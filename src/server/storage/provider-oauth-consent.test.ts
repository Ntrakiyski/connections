import type { OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { FixtureDatabase } from "../test-fixtures/runtime-database.ts";

import { afterEach, describe, expect, it } from "vitest";
import { createFixtureDatabase } from "../test-fixtures/runtime-database.ts";
import { seedTwoCompanies } from "../test-fixtures/two-company.ts";

const fixtures: FixtureDatabase[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} opaque provider consent`,
    () => {
      async function setup(): Promise<FixtureDatabase> {
        const fixture = await createFixtureDatabase(adapter);
        fixtures.push(fixture);
        await seedTwoCompanies(fixture.database, fixture.sql);
        return fixture;
      }
      function pending(): OAuthAuthorizationState {
        return {
          state: crypto.randomUUID(),
          userId: "alice",
          workspaceId: "A1",
          service: "sentinel",
          connectionName: "shared",
          createdAt: new Date().toISOString(),
          pkceCodeVerifier: "synthetic-verifier",
        };
      }

      it("redeems ownership from the stored destination once under concurrent callbacks", async () => {
        const { database } = await setup();
        const consent = pending();
        await database.createScopedStores("A1").oauthStateStore.set(consent);
        const directory = database.providerOAuthConsents;
        if (!directory) throw new Error("Consent directory required.");
        const results = await Promise.all([directory.take(consent.state), directory.take(consent.state)]);
        expect(results.filter(Boolean)).toEqual([{ workspaceId: "A1", userId: "alice", pending: consent }]);
        await expect(directory.take(consent.state)).resolves.toBeUndefined();
      });

      it("does not infer a user from a legacy state prefix", async () => {
        const { database } = await setup();
        const state = "A1.alice.legacy";
        await database
          .createScopedStores("A1")
          .oauthStateStore.set({ state, service: "sentinel", createdAt: new Date().toISOString() });
        await expect(database.providerOAuthConsents?.take(state)).rejects.toMatchObject({
          code: "invalid_oauth_state",
        });
        await expect(database.providerOAuthConsents?.take(state)).resolves.toBeUndefined();
      });

      it("rejects a state duplicated in separate workspaces and consumes both copies", async () => {
        const { database } = await setup();
        const consent = pending();
        await database.createScopedStores("A1").oauthStateStore.set(consent);
        await database
          .createScopedStores("B1")
          .oauthStateStore.set({ ...consent, userId: "employee", workspaceId: "B1" });
        await expect(database.providerOAuthConsents?.take(consent.state)).rejects.toMatchObject({
          code: "invalid_oauth_state",
        });
        await expect(database.providerOAuthConsents?.take(consent.state)).resolves.toBeUndefined();
      });

      it("binds the pending workspace to its store even if supplied a different destination", async () => {
        const { database } = await setup();
        const consent = pending();
        await database.createScopedStores("A1").oauthStateStore.set({ ...consent, workspaceId: "B1" });
        await expect(database.providerOAuthConsents?.take(consent.state)).resolves.toEqual({
          workspaceId: "A1",
          userId: "alice",
          pending: consent,
        });
      });

      it("uses atomic scoped redemption for legacy callers too", async () => {
        const { database } = await setup();
        const consent = pending();
        const states = database.createScopedStores("A1").oauthStateStore;
        await states.set(consent);
        const results = await Promise.all([states.take(consent.state), states.take(consent.state)]);
        expect(results.filter(Boolean)).toEqual([consent]);
      });
    },
  );
}

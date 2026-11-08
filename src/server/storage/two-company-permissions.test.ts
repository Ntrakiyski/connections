import type { FixtureDatabase } from "../test-fixtures/runtime-database.ts";

import { afterEach, describe, expect, it } from "vitest";
import { createFixtureDatabase } from "../test-fixtures/runtime-database.ts";
import {
  fixtureRunner,
  fixtureService,
  seedTwoCompanies,
  sentinelCredential,
  SentinelProviderLoader,
} from "../test-fixtures/two-company.ts";

const fixtures: FixtureDatabase[] = [];
const postgresUrl = process.env.CONNECTIONS_TEST_POSTGRES_URL;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !postgresUrl)(`${adapter} two-company permission contract`, () => {
    async function setup(): Promise<FixtureDatabase> {
      const fixture = await createFixtureDatabase(adapter);
      fixtures.push(fixture);
      await seedTwoCompanies(fixture.database, fixture.sql);
      return fixture;
    }

    it("persists company parentage and requires independent directory membership for new grants", async () => {
      const { database } = await setup();
      await expect(database.workspaceStore.getById("A1")).resolves.toMatchObject({ organizationId: "company-A" });
      await database.workspaceStore.create({
        id: "A3",
        organizationId: "company-A",
        clerkOrgId: "connections-workspace:A3",
        name: "New company A workspace",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      });
      await expect(database.membershipStore.getRole("A3", "operator")).resolves.toBeUndefined();
      await database.membershipStore.setRole("A3", "operator", "admin");
      await expect(database.membershipStore.getRole("A3", "operator")).resolves.toBe("admin");
      await expect(database.membershipStore.setRole("A3", "employee", "member")).rejects.toThrow();
      await expect(database.membershipStore.getRole("A3", "employee")).resolves.toBeUndefined();
      await expect(database.membershipStore.getRole("B1", "employee")).resolves.toBe("member");
    });

    it("selects distinct same-label accounts in A1, sibling A2 and company B1", async () => {
      const { database } = await setup();
      const loader = new SentinelProviderLoader();
      for (const [workspaceId, expected] of [
        ["A1", "A1-alice"],
        ["A2", "A2-operator"],
        ["B1", "B1-employee"],
      ]) {
        if (!workspaceId || !expected) throw new Error("Incomplete fixture selection.");
        const runner = await fixtureRunner(database, loader, workspaceId, "operator");
        await expect(
          runner.run({ actionId: "sentinel.get_account", connectionName: "shared", input: {}, caller: "mcp" }),
        ).resolves.toMatchObject({ result: { ok: true, output: { selectedAccount: expected, workspaceId } } });
      }
      expect(loader.selectedAccounts).toEqual(["A1-alice", "A2-operator", "B1-employee"]);
    });

    it("allows a member to use, replace, rename and disconnect only their own account", async () => {
      const { database } = await setup();
      const loader = new SentinelProviderLoader();
      const alice = await fixtureService(database, loader, "A1", "alice");
      const bob = await fixtureService(database, loader, "A1", "bob");
      await expect(alice.listConnections()).resolves.toMatchObject([{ connectionName: "shared" }]);
      await expect(bob.listConnections()).resolves.toMatchObject([{ connectionName: "bob" }]);
      const before = await database.createScopedStores("A1").connectionStore.list();
      const deniedRunner = await fixtureRunner(database, loader, "A1", "bob");
      await expect(
        deniedRunner.run({ actionId: "sentinel.get_account", connectionName: "shared", input: {}, caller: "mcp" }),
      ).rejects.toMatchObject({ code: "connection_not_found" });
      await expect(
        bob.connectWithApiKey("sentinel", { connectionName: "shared", values: { apiKey: "unauthorized-key" } }),
      ).rejects.toMatchObject({ code: "connection_not_found" });
      await expect(
        bob.connectWithCustomCredential("sentinel", {
          connectionName: "shared",
          values: { password: "unauthorized-password" },
        }),
      ).rejects.toMatchObject({ code: "connection_not_found" });
      await expect(
        bob.setOAuthCredential(
          "sentinel",
          {
            authType: "oauth2",
            accessToken: "unauthorized-oauth",
            tokenType: "Bearer",
            profile: { accountId: "denied", displayName: "denied", grantedScopes: [] },
            metadata: {},
          },
          "shared",
        ),
      ).rejects.toMatchObject({ code: "connection_not_found" });
      await expect(bob.renameConnection("sentinel", "shared", { connectionName: "stolen" })).rejects.toMatchObject({
        code: "connection_not_found",
      });
      await expect(bob.disconnect("sentinel", "shared")).rejects.toMatchObject({ code: "connection_not_found" });
      expect(loader.selectedAccounts).toEqual([]);
      expect(loader.validatedAccounts).toEqual([]);
      await expect(database.createScopedStores("A1").connectionStore.list()).resolves.toEqual(before);
      await expect(database.createScopedStores("A1").runLogStore.list()).resolves.toMatchObject({ items: [] });
      const ownRunner = await fixtureRunner(database, loader, "A1", "alice");
      await expect(
        ownRunner.run({ actionId: "sentinel.get_account", connectionName: "shared", input: {}, caller: "mcp" }),
      ).resolves.toMatchObject({ result: { ok: true, output: { selectedAccount: "A1-alice", workspaceId: "A1" } } });
      expect(loader.selectedAccounts).toEqual(["A1-alice"]);
      await alice.connectWithApiKey("sentinel", { connectionName: "shared", values: { apiKey: "A1-alice-updated" } });
      await alice.renameConnection("sentinel", "shared", { connectionName: "finance" });
      await expect(alice.getCredential("sentinel", "finance")).resolves.toMatchObject({ apiKey: "A1-alice-updated" });
      await alice.disconnect("sentinel", "finance");
      await expect(alice.listConnections()).resolves.toEqual([]);
      await expect(
        database.createScopedStores("A1").connectionStore.getStored("sentinel", "bob"),
      ).resolves.toMatchObject({ createdBy: "bob", credential: { apiKey: "A1-bob" } });
      await expect(database.createScopedStores("A2").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "A2-operator",
      });
      await expect(database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "B1-employee",
      });
    });

    it("lets managers and admins manage accounts in their workspace without changing ownership", async () => {
      const { database, sql } = await setup();
      const loader = new SentinelProviderLoader();
      for (const role of ["manager", "admin"] as const) {
        await sql.write(
          `update workspace_memberships set role = ${sql.placeholder(1)} where workspace_id = ${sql.placeholder(2)} and user_id = ${sql.placeholder(3)}`,
          [role, "A1", "operator"],
        );
        const operator = await fixtureService(database, loader, "A1", "operator");
        await operator.connectWithApiKey("sentinel", {
          connectionName: "shared",
          values: { apiKey: `A1-${role}-updated` },
        });
        await expect(
          database.createScopedStores("A1").connectionStore.getStored("sentinel", "shared"),
        ).resolves.toMatchObject({ createdBy: "alice", credential: { apiKey: `A1-${role}-updated` } });
        await expect(operator.renameConnection("sentinel", "bob", { connectionName: "shared" })).rejects.toMatchObject({
          code: "connection_name_taken",
        });
      }
      const operator = await fixtureService(database, loader, "A1", "operator");
      await operator.renameConnection("sentinel", "shared", { connectionName: "finance" });
      await expect(
        database.createScopedStores("A1").connectionStore.getStored("sentinel", "finance"),
      ).resolves.toMatchObject({ createdBy: "alice" });
      await operator.disconnect("sentinel", "finance");
      await expect(database.createScopedStores("A2").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "A2-operator",
      });
      await expect(database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "B1-employee",
      });
    });

    it("atomically rejects a competing writer and stores a matching owner/value pair", async () => {
      const { database } = await setup();
      const store = database.createScopedStores("A1").connectionStore;
      const attempts = ["alice", "bob"].map((userId) =>
        store.set("sentinel", "race", sentinelCredential(`race-${userId}`), userId, {
          userId,
          canManageWorkspace: false,
        }),
      );
      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const stored = await store.getStored("sentinel", "race");
      expect(stored?.createdBy).toMatch(/^(alice|bob)$/);
      expect(stored?.credential).toMatchObject({ apiKey: `race-${stored?.createdBy}` });
    });

    it("keeps both accounts intact when two renames compete for the same label", async () => {
      const { database } = await setup();
      const operator = await fixtureService(database, new SentinelProviderLoader(), "A1", "operator");
      const results = await Promise.allSettled([
        operator.renameConnection("sentinel", "shared", { connectionName: "finance" }),
        operator.renameConnection("sentinel", "bob", { connectionName: "finance" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      if (!rejected || rejected.status !== "rejected") throw new Error("One competing rename must be rejected.");
      expect(rejected.reason).toMatchObject({ code: "connection_name_taken" });
      const records = await database.createScopedStores("A1").connectionStore.list();
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.createdBy).sort()).toEqual(["alice", "bob"]);
      for (const record of records) expect(record.credential).toMatchObject({ apiKey: `A1-${record.createdBy}` });
      expect(records.filter((record) => record.connectionName === "finance")).toHaveLength(1);
    });

    it("rechecks ownership after delayed validation before committing a credential", async () => {
      const { database } = await setup();
      const loader = new SentinelProviderLoader();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      loader.validationBarrier = async () => {
        started.resolve();
        await release.promise;
      };
      const alice = await fixtureService(database, loader, "A1", "alice");
      const delayedWrite = alice.connectWithApiKey("sentinel", {
        connectionName: "shared",
        values: { apiKey: "stale-alice-key" },
      });
      const denied = expect(delayedWrite).rejects.toMatchObject({ code: "connection_not_found" });
      await started.promise;
      const manager = await fixtureService(database, new SentinelProviderLoader(), "A1", "operator");
      await manager.disconnect("sentinel", "shared");
      const bob = await fixtureService(database, new SentinelProviderLoader(), "A1", "bob");
      await bob.connectWithApiKey("sentinel", { connectionName: "shared", values: { apiKey: "new-bob-key" } });
      release.resolve();
      await denied;
      await expect(
        database.createScopedStores("A1").connectionStore.getStored("sentinel", "shared"),
      ).resolves.toMatchObject({ createdBy: "bob", credential: { apiKey: "new-bob-key" } });
      expect(loader.selectedAccounts).toEqual([]);
    });
  });
}

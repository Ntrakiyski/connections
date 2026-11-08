import type { FixtureDatabase } from "../test-fixtures/runtime-database.ts";

import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "../company-service.ts";
import { createFixtureDatabase } from "../test-fixtures/runtime-database.ts";
import { fixtureService, seedTwoCompanies, SentinelProviderLoader } from "../test-fixtures/two-company.ts";

const fixtures: FixtureDatabase[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} delayed credential authorization`,
    () => {
      for (const method of ["api_key", "custom_credential", "oauth2"]) {
        for (const change of ["downgrade", "remove_grant", "offboard_company", "archive", "disable_provider"]) {
          it(`rejects ${method} persistence after ${change} during provider validation`, async () => {
            const fixture = await createFixtureDatabase(adapter);
            fixtures.push(fixture);
            const { database, sql } = fixture;
            await seedTwoCompanies(database, sql);
            if (!database.identityMutations) throw new Error("Governance store required.");
            const companies = new CompanyService(database.identityMutations);
            const userId = change === "downgrade" ? "operator" : "alice";
            if (change === "downgrade")
              await companies.setWorkspaceGrant("operator", {
                organizationId: "company-A",
                workspaceId: "A1",
                userId: "bob",
                role: "admin",
              });
            const loader = new SentinelProviderLoader();
            const reached = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            loader.validationBarrier = async () => {
              reached.resolve();
              await release.promise;
            };
            const service = await fixtureService(database, loader, "A1", userId);
            const operation =
              method === "api_key"
                ? service.connectWithApiKey("sentinel", {
                    connectionName: "shared",
                    values: { apiKey: "delayed-account" },
                  })
                : method === "custom_credential"
                  ? service.connectWithCustomCredential("sentinel", {
                      connectionName: "shared",
                      values: { password: "delayed-account" },
                    })
                  : service.setOAuthCredential(
                      "sentinel",
                      {
                        authType: "oauth2",
                        accessToken: "delayed-account",
                        tokenType: "Bearer",
                        profile: { accountId: "delayed-account", displayName: "delayed-account", grantedScopes: [] },
                        metadata: {},
                      },
                      "shared",
                    );
            const denied = expect(operation).rejects.toMatchObject({ code: "connection_not_found" });
            await reached.promise;
            try {
              if (change === "downgrade")
                await companies.setWorkspaceGrant("operator", {
                  organizationId: "company-A",
                  workspaceId: "A1",
                  userId: "operator",
                  role: "member",
                });
              if (change === "remove_grant")
                await companies.removeWorkspaceGrant("operator", "company-A", "A1", "alice");
              if (change === "offboard_company")
                await companies.removeOrganizationMember("operator", "company-A", "alice");
              if (change === "archive")
                await sql.write(
                  `update workspaces set deleted_at=${sql.placeholder(1)} where id=${sql.placeholder(2)}`,
                  [new Date().toISOString(), "A1"],
                );
              if (change === "disable_provider") await database.workspaceControlStore.disableProvider("A1", "sentinel");
              const before = await database.createScopedStores("A1").connectionStore.list();
              release.resolve();
              await denied;
              await expect(database.createScopedStores("A1").connectionStore.list()).resolves.toEqual(before);
              await expect(
                database.createScopedStores("A2").connectionStore.get("sentinel", "shared"),
              ).resolves.toMatchObject({ apiKey: "A2-operator" });
              await expect(
                database.createScopedStores("B1").connectionStore.get("sentinel", "shared"),
              ).resolves.toMatchObject({ apiKey: "B1-employee" });
            } finally {
              release.resolve();
              await operation.catch(() => undefined);
            }
          });
        }
      }
    },
  );
}

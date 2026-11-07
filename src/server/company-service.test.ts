import type { FixtureDatabase } from "./test-fixtures/runtime-database.ts";

import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./company-service.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { createFixtureDatabase } from "./test-fixtures/runtime-database.ts";
import { seedTwoCompanies, sentinelCredential } from "./test-fixtures/two-company.ts";

const fixtures: FixtureDatabase[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} transactional company governance`,
    () => {
      async function setup(): Promise<FixtureDatabase & { service: CompanyService }> {
        const fixture = await createFixtureDatabase(adapter);
        fixtures.push(fixture);
        await seedTwoCompanies(fixture.database, fixture.sql);
        if (!fixture.database.identityMutations) throw new Error("Identity mutation store missing.");
        return { ...fixture, service: new CompanyService(fixture.database.identityMutations) };
      }

      it("provisions a company and sibling workspace atomically with explicit initial admins", async () => {
        const { database, service } = await setup();
        const company = await service.createCompany("alice", {
          name: "Company C",
          slug: "company-c",
          workspaceName: "C1",
        });
        expect(await database.identityDirectory?.getOrganizationRole(company.organizationId, "alice")).toBe("owner");
        expect(await database.membershipStore.getRole(company.workspaceId, "alice")).toBe("admin");
        const sibling = await service.createWorkspace("operator", {
          organizationId: "company-A",
          name: "A3",
          initialAdminId: "alice",
        });
        expect(await database.membershipStore.getRole(sibling.workspaceId, "alice")).toBe("admin");
        expect(await database.membershipStore.getRole(sibling.workspaceId, "operator")).toBeUndefined();
        expect(await database.membershipStore.getRole("A2", "operator")).toBe("manager");
        await expect(
          service.createWorkspace("alice", { organizationId: "company-A", name: "Forbidden", initialAdminId: "alice" }),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          service.createWorkspace("operator", {
            organizationId: "company-A",
            name: "Unrelated",
            initialAdminId: "employee",
          }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it("grants existing directory members access without another invitation and rejects parent mismatch", async () => {
        const { database, service } = await setup();
        await service.setWorkspaceGrant("operator", {
          organizationId: "company-A",
          workspaceId: "A2",
          userId: "alice",
          role: "member",
        });
        expect(await database.membershipStore.getRole("A2", "alice")).toBe("member");
        await expect(
          service.setWorkspaceGrant("operator", {
            organizationId: "company-A",
            workspaceId: "B1",
            userId: "alice",
            role: "admin",
          }),
        ).rejects.toMatchObject({ status: 403 });
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
        await expect(
          service.setWorkspaceGrant("operator", {
            organizationId: "company-A",
            workspaceId: "A1",
            userId: "employee",
            role: "member",
          }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it("serializes competing demotions so each company and workspace retains its final administrator", async () => {
        const { database, service } = await setup();
        await service.setOrganizationRole("operator", { organizationId: "company-A", userId: "alice", role: "owner" });
        const owners = await Promise.allSettled([
          service.setOrganizationRole("operator", { organizationId: "company-A", userId: "operator", role: "member" }),
          service.setOrganizationRole("alice", { organizationId: "company-A", userId: "alice", role: "member" }),
        ]);
        expect(owners.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(owners.find((result) => result.status === "rejected")).toMatchObject({
          reason: { code: "last_company_owner" },
        });
        const remainingOwner =
          (await database.identityDirectory?.getOrganizationRole("company-A", "operator")) === "owner"
            ? "operator"
            : "alice";
        await service.setWorkspaceGrant(remainingOwner, {
          organizationId: "company-A",
          workspaceId: "A1",
          userId: "alice",
          role: "admin",
        });
        const admins = await Promise.allSettled([
          service.setWorkspaceGrant(remainingOwner, {
            organizationId: "company-A",
            workspaceId: "A1",
            userId: "operator",
            role: "member",
          }),
          service.setWorkspaceGrant(remainingOwner, {
            organizationId: "company-A",
            workspaceId: "A1",
            userId: "alice",
            role: "member",
          }),
        ]);
        expect(admins.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(admins.find((result) => result.status === "rejected")).toMatchObject({
          reason: { code: "last_workspace_admin" },
        });
        expect(
          (await database.membershipStore.listMembers("A1")).filter((member) => member.role === "admin"),
        ).toHaveLength(1);
      });

      it("offboards one workspace then one company without changing independent B access", async () => {
        const { database, service } = await setup();
        await service.setWorkspaceGrant("operator", {
          organizationId: "company-A",
          workspaceId: "A2",
          userId: "alice",
          role: "member",
        });
        const a1 = database.createScopedStores("A1");
        const a2 = database.createScopedStores("A2");
        await a2.connectionStore.set("sentinel", "alice", sentinelCredential("A2-alice"), "alice");
        const token1 = await new RuntimeTokenService(a1.runtimeTokenStore).createToken("A1", "alice", "A1");
        const token2 = await new RuntimeTokenService(a2.runtimeTokenStore).createToken("A2", "alice", "A2");
        await service.removeWorkspaceGrant("operator", "company-A", "A1", "alice");
        expect(await database.membershipStore.getRole("A1", "alice")).toBeUndefined();
        expect(await database.membershipStore.getRole("A2", "alice")).toBe("member");
        expect(await a1.connectionStore.get("sentinel", "shared")).toBeUndefined();
        expect(await a1.runtimeTokenStore.findByHash(token1.record.tokenHash)).toBeUndefined();
        expect(await a2.runtimeTokenStore.findByHash(token2.record.tokenHash)).toBeDefined();
        const bBefore = await database.createScopedStores("B1").connectionStore.list();
        await service.removeOrganizationMember("operator", "company-A", "alice");
        expect(await database.identityDirectory?.getOrganizationRole("company-A", "alice")).toBeUndefined();
        expect(await database.membershipStore.getRole("A2", "alice")).toBeUndefined();
        expect(await a2.runtimeTokenStore.findByHash(token2.record.tokenHash)).toBeUndefined();
        expect(await a2.connectionStore.get("sentinel", "alice")).toBeUndefined();
        expect(await database.createScopedStores("B1").connectionStore.list()).toEqual(bBefore);
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "operator")).toBe("admin");
      });

      it("rolls back every cleanup write when removing the final owner or workspace admin", async () => {
        const { database, service } = await setup();
        await expect(service.removeOrganizationMember("operator", "company-A", "operator")).rejects.toMatchObject({
          code: "last_company_owner",
        });
        await expect(service.removeWorkspaceGrant("operator", "company-A", "A1", "operator")).rejects.toMatchObject({
          code: "last_workspace_admin",
        });
        expect(await database.membershipStore.getRole("A1", "operator")).toBe("admin");
        expect(await database.identityDirectory?.getOrganizationRole("company-A", "operator")).toBe("owner");
        expect(
          await database.identityMutations?.read({ sql: "select * from identity_mutation_checks", values: [] }),
        ).toEqual([]);
      });

      it("removes the same account from company A while retaining its B grant, key and owned connection", async () => {
        const { database, service } = await setup();
        await service.setOrganizationRole("operator", { organizationId: "company-A", userId: "bob", role: "owner" });
        for (const workspaceId of ["A1", "A2"]) {
          await service.setWorkspaceGrant("operator", {
            organizationId: "company-A",
            workspaceId,
            userId: "bob",
            role: "admin",
          });
        }
        const a = database.createScopedStores("A2");
        const b = database.createScopedStores("B1");
        await b.connectionStore.set("sentinel", "operator", sentinelCredential("B1-operator"), "operator");
        const aToken = await new RuntimeTokenService(a.runtimeTokenStore).createToken("A2", "operator", "A");
        const bToken = await new RuntimeTokenService(b.runtimeTokenStore).createToken("B1", "operator", "B");
        await service.removeWorkspaceGrant("bob", "company-A", "A1", "operator");
        expect(await database.membershipStore.getRole("A1", "operator")).toBeUndefined();
        expect(await database.membershipStore.getRole("A2", "operator")).toBe("manager");
        expect(await database.membershipStore.getRole("B1", "operator")).toBe("admin");
        await service.removeOrganizationMember("bob", "company-A", "operator");
        expect(await database.identityDirectory?.getOrganizationRole("company-A", "operator")).toBeUndefined();
        expect(await database.membershipStore.getRole("A1", "operator")).toBeUndefined();
        expect(await database.membershipStore.getRole("A2", "operator")).toBeUndefined();
        expect(await a.runtimeTokenStore.findByHash(aToken.record.tokenHash)).toBeUndefined();
        expect(await a.connectionStore.get("sentinel", "shared")).toBeUndefined();
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "operator")).toBe("admin");
        expect(await database.membershipStore.getRole("B1", "operator")).toBe("admin");
        expect(await b.runtimeTokenStore.findByHash(bToken.record.tokenHash)).toBeDefined();
        expect(await b.connectionStore.get("sentinel", "operator")).toMatchObject({ apiKey: "B1-operator" });
      });
    },
  );
}

import type { AuthMail } from "./human-auth.ts";
import type { IIdentityMutationStore } from "./storage/identity-mutations.ts";
import type { FixtureDatabase } from "./test-fixtures/runtime-database.ts";

import { afterEach, describe, expect, it } from "vitest";
import { CompanyInvitationService } from "./company-invitations.ts";
import { CompanyService } from "./company-service.ts";
import { createFixtureDatabase } from "./test-fixtures/runtime-database.ts";
import { seedTwoCompanies } from "./test-fixtures/two-company.ts";

const fixtures: FixtureDatabase[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} company invitation finalization`,
    () => {
      async function setup(): Promise<
        FixtureDatabase & {
          invitations: CompanyInvitationService;
          companies: CompanyService;
          store: IIdentityMutationStore;
          mail: AuthMail[];
        }
      > {
        const fixture = await createFixtureDatabase(adapter);
        fixtures.push(fixture);
        await seedTwoCompanies(fixture.database, fixture.sql);
        const store = fixture.database.identityMutations;
        if (!store) throw new Error("Identity mutation store missing.");
        const mail: AuthMail[] = [];
        return {
          ...fixture,
          store,
          mail,
          companies: new CompanyService(store),
          invitations: new CompanyInvitationService(store, {
            publicOrigin: "https://connections.example.test",
            sendMail: async (message) => {
              mail.push(message);
            },
          }),
        };
      }

      it("lets an A member join B with the same verified identity and later receive A2 through a direct grant", async () => {
        const { database, invitations, companies, mail } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "manager" }],
        });
        expect(invitation.delivery).toBe("sent");
        expect(mail).toMatchObject([{ to: "alice@synthetic.invalid" }]);
        expect(mail[0]?.text).toContain(`invitation=${invitation.invitationId}`);
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
        expect(await invitations.listForRecipient("alice")).toMatchObject([
          { id: invitation.invitationId, organizationId: "company-B" },
        ]);
        await invitations.accept("alice", invitation.invitationId);
        expect(await database.identityDirectory?.getOrganizationRole("company-A", "alice")).toBe("member");
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "alice")).toBe("member");
        expect(await database.membershipStore.getRole("B1", "alice")).toBe("manager");
        await companies.setWorkspaceGrant("operator", {
          organizationId: "company-A",
          workspaceId: "A2",
          userId: "alice",
          role: "member",
        });
        expect(await database.membershipStore.getRole("A2", "alice")).toBe("member");
      });

      it("rejects wrong recipients and expiry without writing any directory membership or workspace grant", async () => {
        const { database, invitations, store } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "member" }],
        });
        await expect(invitations.accept("bob", invitation.invitationId)).rejects.toMatchObject({ status: 403 });
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "bob")).toBeUndefined();
        await store.commit([
          {
            sql: "update organization_invitations set expires_at=? where id=?",
            values: ["2000-01-01T00:00:00.000Z", invitation.invitationId],
          },
        ]);
        await expect(invitations.accept("alice", invitation.invitationId)).rejects.toMatchObject({
          code: "invitation_invalid",
        });
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "alice")).toBeUndefined();
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
        expect(await store.read({ sql: "select * from invitation_acceptances", values: [] })).toEqual([]);
      });

      it("refuses acceptance after workspace archival, cancellation, or inviter demotion", async () => {
        const { database, invitations, companies } = await setup();
        const input = {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member" as const,
          grants: [{ workspaceId: "B1", role: "member" as const }],
        };
        const archived = await invitations.create("operator", input);
        await database.workspaceLifecycleStore?.archive("B1", new Date().toISOString(), "2099-01-01T00:00:00.000Z");
        await expect(invitations.accept("alice", archived.invitationId)).rejects.toMatchObject({
          code: "invitation_invalid",
        });
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "alice")).toBeUndefined();
        await database.workspaceLifecycleStore?.restore("B1", new Date().toISOString());
        const canceled = await invitations.create("operator", input);
        await invitations.cancel("operator", canceled.invitationId);
        await expect(invitations.accept("alice", canceled.invitationId)).rejects.toMatchObject({
          code: "invitation_invalid",
        });
        const stale = await invitations.create("operator", input);
        await companies.setOrganizationRole("operator", {
          organizationId: "company-B",
          userId: "operator",
          role: "member",
        });
        await expect(invitations.accept("alice", stale.invitationId)).rejects.toMatchObject({ status: 403 });
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
      });

      it("finalizes concurrent accepts once and never resurrects a subsequently removed grant", async () => {
        const { database, invitations, companies, store } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "member" }],
        });
        const accepted = await Promise.all([
          invitations.accept("alice", invitation.invitationId),
          invitations.accept("alice", invitation.invitationId),
        ]);
        expect(accepted[0]).toEqual(accepted[1]);
        expect(
          await store.read({
            sql: "select * from invitation_acceptances where invitation_id=?",
            values: [invitation.invitationId],
          }),
        ).toHaveLength(1);
        expect(
          await store.read({
            sql: "select id from organization_audit_events where event='company.invitation.accepted'",
            values: [],
          }),
        ).toHaveLength(1);
        await companies.removeWorkspaceGrant("operator", "company-B", "B1", "alice");
        await invitations.accept("alice", invitation.invitationId);
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
        await expect(invitations.accept("bob", invitation.invitationId)).rejects.toMatchObject({ status: 403 });
      });

      it("rolls back an interrupted finalization and retries without partial grants", async () => {
        const { database, invitations, store } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "member" }],
        });
        let interrupt = true;
        const interrupted: IIdentityMutationStore = {
          currentTimeSQL: store.currentTimeSQL,
          read: (statement) => store.read(statement),
          commit: (statements, organizationId) => {
            if (!interrupt) return store.commit(statements, organizationId);
            interrupt = false;
            // Failure after the grant writes must abort the entire transaction/batch.
            const audit = statements.findIndex((statement) =>
              statement.sql.includes("insert into organization_audit_events"),
            );
            const broken = [...statements];
            broken.splice(audit, 0, {
              sql: "insert into identity_mutation_checks(id, authorized) values(?,0)",
              values: ["synthetic-interruption"],
            });
            return store.commit(broken, organizationId);
          },
        };
        const retrying = new CompanyInvitationService(interrupted, {
          publicOrigin: "https://connections.example.test",
          sendMail: async () => {},
        });
        await expect(retrying.accept("alice", invitation.invitationId)).rejects.toMatchObject({ status: 403 });
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "alice")).toBeUndefined();
        expect(await database.membershipStore.getRole("B1", "alice")).toBeUndefined();
        await retrying.accept("alice", invitation.invitationId);
        expect(await database.membershipStore.getRole("B1", "alice")).toBe("member");
        expect(
          await store.read({
            sql: "select * from invitation_acceptances where invitation_id=?",
            values: [invitation.invitationId],
          }),
        ).toHaveLength(1);
      });

      it("retains independently assigned directory roles and handles failed delivery through resend", async () => {
        const { database, companies, store } = await setup();
        let fail = true;
        const invitations = new CompanyInvitationService(store, {
          publicOrigin: "https://connections.example.test",
          sendMail: async () => {
            if (fail) throw new Error("Synthetic delivery failure");
          },
        });
        const invitation = await invitations.create("operator", {
          organizationId: "company-A",
          email: "alice@synthetic.invalid",
          role: "owner",
          grants: [{ workspaceId: "A2", role: "member" }],
        });
        expect(invitation.delivery).toBe("failed");
        fail = false;
        expect(await invitations.resend("operator", invitation.invitationId)).toMatchObject({ delivery: "sent" });
        await companies.setOrganizationRole("operator", {
          organizationId: "company-A",
          userId: "alice",
          role: "admin",
        });
        await invitations.accept("alice", invitation.invitationId);
        expect(await database.identityDirectory?.getOrganizationRole("company-A", "alice")).toBe("admin");
        expect(await database.membershipStore.getRole("A2", "alice")).toBe("member");
      });

      it("rejects unverified recipients and invitations whose original workspace was purged", async () => {
        const { database, invitations, store } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "member" }],
        });
        await store.commit([{ sql: "update auth_user set email_verified=false where id=?", values: ["alice"] }]);
        await expect(invitations.accept("alice", invitation.invitationId)).rejects.toMatchObject({ status: 403 });
        await store.commit([{ sql: "update auth_user set email_verified=true where id=?", values: ["alice"] }]);
        await database.workspaceLifecycleStore?.archive("B1", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
        await database.workspaceLifecycleStore?.purgeExpired(new Date().toISOString());
        expect(await database.workspaceStore.getById("B1")).toBeUndefined();
        expect(
          await store.read({
            sql: "select workspace_id from workspace_invitation_grants where invitation_id=?",
            values: [invitation.invitationId],
          }),
        ).toMatchObject([{ workspace_id: "B1" }]);
        await expect(invitations.accept("alice", invitation.invitationId)).rejects.toMatchObject({
          code: "invitation_invalid",
        });
        expect(await database.identityDirectory?.getOrganizationRole("company-B", "alice")).toBeUndefined();
      });

      it("acknowledges a lost successful response without issuing membership or audit twice", async () => {
        const { invitations, store } = await setup();
        const invitation = await invitations.create("operator", {
          organizationId: "company-B",
          email: "alice@synthetic.invalid",
          role: "member",
          grants: [{ workspaceId: "B1", role: "member" }],
        });
        let loseResponse = true;
        const losing: IIdentityMutationStore = {
          currentTimeSQL: store.currentTimeSQL,
          read: (statement) => store.read(statement),
          async commit(statements, organizationId) {
            const result = await store.commit(statements, organizationId);
            if (loseResponse) {
              loseResponse = false;
              throw new Error("Synthetic response loss after commit");
            }
            return result;
          },
        };
        const retrying = new CompanyInvitationService(losing, {
          publicOrigin: "https://connections.example.test",
          sendMail: async () => {},
        });
        await expect(retrying.accept("alice", invitation.invitationId)).rejects.toThrow("response loss");
        await retrying.accept("alice", invitation.invitationId);
        expect(
          await store.read({
            sql: "select invitation_id from invitation_acceptances where invitation_id=?",
            values: [invitation.invitationId],
          }),
        ).toHaveLength(1);
        expect(
          await store.read({
            sql: "select id from organization_audit_events where event='company.invitation.accepted'",
            values: [],
          }),
        ).toHaveLength(1);
      });
    },
  );
}

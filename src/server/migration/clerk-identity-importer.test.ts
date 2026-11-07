import type { AuthMail } from "../human-auth.ts";
import type { FixtureDatabase } from "../test-fixtures/runtime-database.ts";
import type { IClerkImportStore } from "./clerk-import-store.ts";
import type { ClerkSnapshot, ClerkImportManifest } from "./clerk-snapshot.ts";

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "../company-service.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { createHumanAuth } from "../human-auth.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { createFixtureDatabase } from "../test-fixtures/runtime-database.ts";
import { sentinelCatalog } from "../test-fixtures/two-company.ts";
import { fixtureRunner, sentinelCredential, SentinelProviderLoader } from "../test-fixtures/two-company.ts";
import { ClerkIdentityImporter } from "./clerk-identity-importer.ts";
import { NodeClerkImportFiles } from "./clerk-import-files.ts";
import { readClerkImportInventory } from "./clerk-import-inventory.ts";

const time = "2026-07-15T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function snapshot(): ClerkSnapshot {
  return {
    version: 1,
    sourceInstance: "ins_synthetic",
    capturedAt: time,
    users: ["operator", "alice", "employee"].map((name) => ({
      id: `user_${name}`,
      name,
      primaryEmail: `${name}@example.test`,
      emails: [{ address: `${name}@example.test`, verified: true }],
      createdAt: time,
      updatedAt: time,
      signInMethods: ["password"],
      mfaEnabled: false,
      disabled: false,
    })),
    organizations: ["alpha", "beta"].map((name) => ({
      id: `org_${name}`,
      name,
      slug: name,
      createdAt: time,
      createdBy: name === "alpha" ? "user_operator" : "user_employee",
    })),
    memberships: [
      {
        id: "omem_alpha_operator",
        organizationId: "org_alpha",
        userId: "user_operator",
        role: "org:admin",
        createdAt: time,
      },
      {
        id: "omem_alpha_alice",
        organizationId: "org_alpha",
        userId: "user_alice",
        role: "org:member",
        createdAt: time,
      },
      {
        id: "omem_beta_operator",
        organizationId: "org_beta",
        userId: "user_operator",
        role: "org:member",
        createdAt: time,
      },
      {
        id: "omem_beta_employee",
        organizationId: "org_beta",
        userId: "user_employee",
        role: "org:admin",
        createdAt: time,
      },
    ],
    invitations: [
      {
        id: "invite_pending",
        organizationId: "org_alpha",
        email: "new-member@example.test",
        role: "org:member",
        status: "pending",
        expiresAt: "2026-07-20T00:00:00.000Z",
      },
    ],
  };
}
function manifest(): ClerkImportManifest {
  return {
    version: 1,
    sourceInstance: "ins_synthetic",
    companies: [
      {
        sourceOrganizationId: "org_alpha",
        workspaceId: "A1",
        ownerUserId: "user_operator",
        workspaceAdminId: "user_operator",
        slug: "alpha",
      },
      {
        sourceOrganizationId: "org_beta",
        workspaceId: "B1",
        ownerUserId: "user_employee",
        workspaceAdminId: "user_employee",
        slug: "beta",
      },
    ],
    directoryRoles: { "org:admin": "admin", "org:member": "member" },
    localCompatibilityWorkspaceIds: ["default"],
  };
}
interface ImportFixture extends FixtureDatabase {
  importer: ClerkIdentityImporter;
  files: NodeClerkImportFiles;
  filesRoot: string;
  transit: TransitFileService;
  tokens: RuntimeTokenService;
  active: string;
  revoked: string;
  write(sql: string, values?: string[]): Promise<void>;
}
async function setup(adapter: string): Promise<ImportFixture> {
  const fixture = await createFixtureDatabase(adapter);
  cleanup.push(fixture.close);
  const root = await mkdtemp(join(tmpdir(), "connections-import-files-"));
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function write(sql: string, values: string[] = []): Promise<void> {
    let index = 0;
    await fixture.sql.write(
      sql.replaceAll("?", () => fixture.sql.placeholder(++index)),
      values,
    );
  }
  if (adapter === "PostgreSQL") {
    const schema = String(
      (await fixture.importStore.read({ sql: "select current_schema() as name", values: [] }))[0]?.name,
    );
    if (!/^fixture_[a-f0-9]+$/.test(schema)) throw new Error("Unsafe fixture schema.");
    await write(
      "create function fixture_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$",
    );
    for (const name of [
      "20260717090000_meetily-meetings.sql",
      "20260719130000_meetily-summary-only.sql",
      "20260719130001_add-meetily-raw-transcript.sql",
      "20260720103941_tenant-meetily-meetings.sql",
    ]) {
      const sql = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8")
        .replaceAll("public.", `${schema}.`)
        .replaceAll("system.update_updated_at()", "fixture_updated_at()");
      await write(sql);
    }
  }
  const { database } = fixture;
  for (const [id, clerkOrgId] of [
    ["A1", "org_alpha"],
    ["B1", "org_beta"],
  ]) {
    if (!id || !clerkOrgId) throw new Error("Incomplete fixture workspace.");
    await database.workspaceStore.create({ id, clerkOrgId, name: id, createdAt: time, updatedAt: time });
    await database.workspaceControlStore.enableProvider({
      workspaceId: id,
      service: "sentinel",
      enabledBy: "user_operator",
      enabledAt: time,
    });
  }
  for (const [workspace, user, role] of [
    ["A1", "user_operator", "admin"],
    ["A1", "user_alice", "member"],
    ["B1", "user_operator", "manager"],
    ["B1", "user_employee", "admin"],
  ]) {
    await write(
      "insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at) values(?,?,?,?,?)",
      [workspace ?? "", user ?? "", role ?? "", time, time],
    );
  }
  await database
    .createScopedStores("A1")
    .connectionStore.set("sentinel", "shared", sentinelCredential("A1-private-sentinel"), "user_operator");
  await database
    .createScopedStores("A1")
    .connectionStore.set("sentinel", "alice", sentinelCredential("Alice-private-sentinel"), "user_alice");
  await database
    .createScopedStores("B1")
    .connectionStore.set("sentinel", "shared", sentinelCredential("B1-private-sentinel"), "user_operator");
  await database.workspaceControlStore.setWorkspaceSafetySettings({
    workspaceId: "A1",
    value: { scopePreflight: { mode: "observe" } },
    updatedBy: "user_operator",
    updatedAt: time,
  });
  await database.meetingStore?.put("A1", {
    externalId: "original-recording",
    createdBy: "user_operator",
    state: "final",
    revision: 1,
    title: "Private old recording",
    transcript: "Private transcript",
    transcriptSegments: [],
  });
  const tokens = new RuntimeTokenService(database.runtimeTokenStore);
  const active = (await tokens.createToken("A1", "user_operator", "preserved-active")).token;
  const old = await tokens.createToken("A1", "user_operator", "preserved-revoked");
  await tokens.revokeToken(old.record.id);
  await write(
    "insert into oauth_states(workspace_id,state,value,created_at,user_id) values('A1','old-consent',?,?,'user_operator')",
    [JSON.stringify({ accessToken: "transient-provider-secret" }), time],
  );
  await write(
    "insert into auth_user(id,name,email,email_verified,created_at,updated_at) values('user_unrelated','Unrelated','unrelated@example.test',true,?,?)",
    [time, time],
  );
  await write(
    "insert into auth_session(id,token,user_id,expires_at,created_at,updated_at) values('old-session','old-human-session-secret','user_unrelated',?,?,?)",
    ["2027-01-01T00:00:00.000Z", time, time],
  );
  await write(
    "insert into auth_verification(id,identifier,value,expires_at,created_at,updated_at) values('old-verification','old','old-verification-secret',?,?,?)",
    ["2027-01-01T00:00:00.000Z", time, time],
  );
  const transit = new TransitFileService({
    rootDir: root,
    publicOrigin: "http://localhost:3000",
    ttlSeconds: 3600,
    maxBytes: 1024,
  });
  const upload = await transit.create(new File(["private original file content"], "recording.txt"), {
    workspaceId: "A1",
    userId: "user_operator",
    canManageWorkspace: false,
  });
  const fileTime = Math.floor(Date.now() / 1000);
  await utimes(join(root, upload.fileId), fileTime, fileTime);
  const files = new NodeClerkImportFiles(root);
  const importer = new ClerkIdentityImporter({
    store: fixture.importStore,
    secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
    files,
  });
  return { ...fixture, importer, files, filesRoot: root, transit, tokens, active, revoked: old.token, write };
}

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} verified Clerk import`,
    () => {
      it("dry-runs without writes, imports once, preserves encrypted resources and routes existing tokens", async () => {
        const f = await setup(adapter);
        const before = await readClerkImportInventory(f.importStore);
        const files = await f.files.read();
        const source = snapshot();
        const config = manifest();
        const preview = await f.importer.preview(source, config);
        expect(preview.kind, JSON.stringify(preview.exceptions)).toBe("dry_run");
        expect(await readClerkImportInventory(f.importStore)).toEqual(before);
        const other = await f.importer.preview(
          { ...source, users: [...source.users].reverse(), capturedAt: "2026-07-16T00:00:00.000Z" },
          config,
        );
        expect(other.planFingerprint).toBe(preview.planFingerprint);
        const applied = await f.importer.apply(source, config, {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        });
        expect(applied.kind, JSON.stringify(applied.exceptions)).toBe("applied");
        const after = await readClerkImportInventory(f.importStore);
        for (const item of before.filter(
          (item) =>
            ![
              "auth_user",
              "auth_session",
              "auth_verification",
              "oauth_states",
              "workspaces",
              "workspace_memberships",
              "organizations",
              "organization_memberships",
              "identity_import_runs",
              "identity_source_mappings",
              "identity_import_invitation_recovery",
            ].includes(item.table),
        ))
          expect(after.find((next) => next.table === item.table)).toEqual(item);
        expect(await f.files.read()).toEqual(files);
        expect(await f.database.identityDirectory?.getOrganizationRole("org_alpha", "user_operator")).toBe("owner");
        expect(await f.database.identityDirectory?.getOrganizationRole("org_beta", "user_operator")).toBe("member");
        expect(await f.database.membershipStore.getRole("B1", "user_operator")).toBe("manager");
        expect(after.find((item) => item.table === "auth_session")?.rows).toHaveLength(0);
        expect(after.find((item) => item.table === "oauth_states")?.rows).toHaveLength(0);
        expect(after.find((item) => item.table === "auth_verification")?.rows).toHaveLength(0);
        const again = await f.importer.apply(source, config, {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        });
        expect(again.kind).toBe("already_applied");
        expect(again.mappings).toEqual(applied.mappings);
        expect(again.directoryRoles).toEqual(applied.directoryRoles);
        expect(again.workspaceRoles).toEqual(applied.workspaceRoles);
        expect(await readClerkImportInventory(f.importStore)).toEqual(after);
        expect(await f.tokens.verifyToken(f.active)).toMatchObject({ workspaceId: "A1", userId: "user_operator" });
        expect(await f.tokens.verifyToken(f.revoked)).toBeUndefined();
        const loader = new SentinelProviderLoader();
        for (const [workspace, selectedAccount] of [
          ["A1", "A1-private-sentinel"],
          ["B1", "B1-private-sentinel"],
        ]) {
          const runner = await fixtureRunner(f.database, loader, workspace ?? "", "user_operator");
          expect(
            await runner.run({ actionId: "sentinel.get_account", connectionName: "shared", input: {}, caller: "mcp" }),
          ).toMatchObject({ result: { ok: true, output: { selectedAccount, workspaceId: workspace } } });
        }
        const serialized = JSON.stringify(applied);
        for (const secret of [
          f.active,
          f.revoked,
          "transient-provider-secret",
          "old-human-session-secret",
          "old-verification-secret",
          "Private transcript",
          "A1-private-sentinel",
          "private original file content",
          "operator@example.test",
          "new-member@example.test",
        ])
          expect(serialized).not.toContain(secret);
      });

      it("recovers an imported password account through Hono and uses its original human/runtime workspace identity", async () => {
        const f = await setup(adapter);
        const source = snapshot();
        const config = manifest();
        const preview = await f.importer.preview(source, config);
        expect(
          (
            await f.importer.apply(source, config, {
              expectedPlanFingerprint: preview.planFingerprint,
              maintenanceMode: true,
            })
          ).kind,
        ).toBe("applied");
        const origin = "http://localhost:3000";
        const mail: AuthMail[] = [];
        const auth = createHumanAuth(
          {
            baseURL: origin,
            secret: "synthetic-import-human-auth-key-more-than-32-characters",
            trustedOrigins: [],
            sendMail: async (message) => {
              mail.push(message);
            },
          },
          f.authDatabase,
        );
        const connect = await createConnectApp({
          catalog: sentinelCatalog,
          providerLoader: new SentinelProviderLoader(),
          runtimeDatabase: f.database,
          secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
          humanAuth: auth,
          authMailDelivery: async (message) => {
            mail.push(message);
          },
          publicOrigin: origin,
          transitFiles: f.transit,
        });
        const app = connect.app;
        const post = (path: string, body: unknown) =>
          app.request(origin + path, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        expect(
          (
            await post("/api/identity/sign-in/email", {
              email: "operator@example.test",
              password: "old-incompatible-Clerk-password",
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await post("/api/identity/request-password-reset", {
              email: "operator@example.test",
              redirectTo: origin + "/reset-password",
            })
          ).status,
        ).toBe(200);
        const message = mail.find((item) => item.subject === "Reset your Connections password");
        if (!message) throw new Error("No recovery mail was delivered.");
        const callback = await app.request(message.text.replace("Reset your password: ", ""));
        expect(callback.status).toBe(302);
        const token = new URL(callback.headers.get("location") ?? "", origin).searchParams.get("token");
        expect(
          (await post("/api/identity/reset-password", { token, newPassword: "new-synthetic-password-12345" })).status,
        ).toBe(200);
        const login = await post("/api/identity/sign-in/email", {
          email: "operator@example.test",
          password: "new-synthetic-password-12345",
        });
        expect(login.status).toBe(200);
        expect(await login.json()).toMatchObject({ user: { id: "user_operator", emailVerified: true } });
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const session = await app.request(origin + "/api/auth/session", {
          headers: { cookie, "x-workspace-id": "B1" },
        });
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({
          userId: "user_operator",
          workspaceId: "B1",
          organizationId: "org_beta",
          role: "manager",
        });
        const runtime = await app.request(origin + "/v1/actions/sentinel.get_account", {
          method: "POST",
          headers: { authorization: "Bearer " + f.active, "content-type": "application/json" },
          body: JSON.stringify({ connectionName: "shared", input: {} }),
        });
        expect(runtime.status).toBe(200);
        expect(await runtime.json()).toMatchObject({
          data: { workspaceId: "A1", selectedAccount: "A1-private-sentinel" },
        });
        expect(
          (await app.request(origin + "/v1/health", { headers: { authorization: "Bearer " + f.revoked } })).status,
        ).toBe(401);
        expect(await f.importStore.read({ sql: "select provider_id,user_id from auth_account", values: [] })).toEqual([
          { provider_id: "credential", user_id: "user_operator" },
        ]);
      });
      it("does not replay source grants after current offboarding and refuses changed completed snapshots", async () => {
        const f = await setup(adapter);
        const source = snapshot();
        const config = manifest();
        const preview = await f.importer.preview(source, config);
        await f.importer.apply(source, config, {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        });
        if (!f.database.identityMutations) throw new Error("Missing governance store.");
        const companies = new CompanyService(f.database.identityMutations);
        await companies.removeOrganizationMember("user_operator", "org_alpha", "user_alice");
        expect(
          (
            await f.importer.apply(source, config, {
              expectedPlanFingerprint: preview.planFingerprint,
              maintenanceMode: true,
            })
          ).kind,
        ).toBe("already_applied");
        expect(await f.database.membershipStore.getRole("A1", "user_alice")).toBeUndefined();
        expect(await f.database.createScopedStores("A1").connectionStore.get("sentinel", "alice")).toBeUndefined();
        const changed = structuredClone(source);
        changed.memberships.push({
          id: "new-member",
          organizationId: "org_alpha",
          userId: "user_employee",
          role: "org:member",
          createdAt: time,
        });
        expect((await f.importer.preview(changed, config)).exceptions).toContainEqual(
          expect.objectContaining({ code: "completed_source_changed" }),
        );
      });
      it("blocks alias collisions, missing verified ownership, stale grants and zero-admin mappings without writes", async () => {
        const f = await setup(adapter);
        const initial = await readClerkImportInventory(f.importStore);
        const source = snapshot();
        const first = source.users[0];
        const second = source.users[1];
        if (!first || !second) throw new Error("Missing fixture users.");
        second.emails.push({ address: first.primaryEmail ?? "", verified: true });
        const report = await f.importer.preview(source, manifest());
        expect(report.kind).toBe("blocked");
        expect(report.exceptions).toContainEqual(expect.objectContaining({ code: "ambiguous_email_identity" }));
        expect(JSON.stringify(report)).not.toContain(first.primaryEmail);
        const stale = snapshot();
        stale.memberships = stale.memberships.filter((item) => item.userId !== "user_alice");
        expect((await f.importer.preview(stale, manifest())).exceptions).toContainEqual(
          expect.objectContaining({ code: "stale_or_unmapped_grant" }),
        );
        const noOwner = manifest();
        if (!noOwner.companies[0]) throw new Error("Missing company.");
        noOwner.companies[0].ownerUserId = "user_missing";
        expect((await f.importer.preview(snapshot(), noOwner)).exceptions).toContainEqual(
          expect.objectContaining({ code: "invalid_designated_owner" }),
        );
        expect(await readClerkImportInventory(f.importStore)).toEqual(initial);
        await f.write(
          "update workspace_memberships set role='manager' where workspace_id='A1' and user_id='user_operator'",
        );
        expect((await f.importer.preview(snapshot(), manifest())).exceptions).toContainEqual(
          expect.objectContaining({ code: "missing_workspace_admin" }),
        );
      });
      it("blocks unmapped active owners, wrong encryption keys and MFA/disabled identity recovery", async () => {
        const f = await setup(adapter);
        const wrong = new ClerkIdentityImporter({
          store: f.importStore,
          secretCodec: new AesGcmSecretCodec("wrong-synthetic-key"),
          files: f.files,
        });
        expect((await wrong.preview(snapshot(), manifest())).exceptions).toContainEqual(
          expect.objectContaining({ code: "credential_decryption_failed" }),
        );
        const source = snapshot();
        if (!source.users[0]) throw new Error("Missing user.");
        source.users[0].mfaEnabled = true;
        source.users[0].disabled = true;
        const factors = await f.importer.preview(source, manifest());
        expect(factors.kind).toBe("blocked");
        expect(factors.exceptions).toContainEqual(expect.objectContaining({ code: "mfa_recovery_required" }));
        expect(factors.exceptions).toContainEqual(expect.objectContaining({ code: "disabled_identity" }));
        await f.write(
          "update connections set created_by='user_orphan' where workspace_id='A1' and connection_name='shared'",
        );
        expect((await f.importer.preview(snapshot(), manifest())).exceptions).toContainEqual(
          expect.objectContaining({ code: "unmapped_active_owner" }),
        );
        expect(await f.importStore.read({ sql: "select * from identity_import_runs", values: [] })).toHaveLength(0);
      });
      it("rejects stale reviewed plans and atomically detects an inventory race", async () => {
        const f = await setup(adapter);
        const preview = await f.importer.preview(snapshot(), manifest());
        expect(
          (await f.importer.apply(snapshot(), manifest(), { expectedPlanFingerprint: "wrong", maintenanceMode: true }))
            .kind,
        ).toBe("blocked");
        const racing: IClerkImportStore = {
          read: (statement) => f.importStore.read(statement),
          commitImport: async (statements, tables) => {
            await f.write("update runtime_tokens set revoked_at='race-revoked' where revoked_at is null");
            return f.importStore.commitImport(statements, tables);
          },
        };
        const importer = new ClerkIdentityImporter({
          store: racing,
          secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
          files: f.files,
        });
        const result = await importer.apply(snapshot(), manifest(), {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        });
        expect(result.kind).toBe("apply_uncertain");
        expect(await f.importStore.read({ sql: "select * from identity_import_runs", values: [] })).toHaveLength(0);
        expect(
          await f.importStore.read({ sql: "select * from auth_user where id='user_operator'", values: [] }),
        ).toHaveLength(0);
        expect(await f.tokens.verifyToken(f.active)).toBeUndefined();
      });

      it("keeps final verification pending after a file write and resumes without replaying grants", async () => {
        const f = await setup(adapter);
        const preview = await f.importer.preview(snapshot(), manifest());
        const original = (await f.files.read())[0];
        if (!original) throw new Error("Missing fixture file.");
        const path = join(f.filesRoot, original.id);
        const bytes = readFileSync(path);
        const observing: IClerkImportStore = {
          read: (statement) => f.importStore.read(statement),
          commitImport: async (statements, tables) => {
            const results = await f.importStore.commitImport(statements, tables);
            await writeFile(path, "unexpected file write after database commit");
            return results;
          },
        };
        const importer = new ClerkIdentityImporter({
          store: observing,
          secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
          files: f.files,
        });
        const result = await importer.apply(snapshot(), manifest(), {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        });
        expect(result.kind).toBe("verification_pending");
        expect(result.exceptions).toContainEqual(expect.objectContaining({ code: "pending_files_changed" }));
        expect((await f.importer.preview(snapshot(), manifest())).kind).toBe("verification_pending");
        await writeFile(path, bytes);
        await utimes(path, new Date(), Number(BigInt(original.modifiedAtNs) / 1_000_000_000n));
        expect(
          (
            await f.importer.apply(snapshot(), manifest(), {
              expectedPlanFingerprint: preview.planFingerprint,
              maintenanceMode: true,
            })
          ).kind,
        ).toBe("already_applied");
        expect(
          await f.importStore.read({
            sql: "select user_id,role from workspace_memberships where workspace_id='A1' order by user_id",
            values: [],
          }),
        ).toEqual([
          { user_id: "user_alice", role: "member" },
          { user_id: "user_operator", role: "admin" },
        ]);
      });
      it("keeps a failed final verification incomplete and resumes only the preservation check", async () => {
        const f = await setup(adapter);
        const preview = await f.importer.preview(snapshot(), manifest());
        let commits = 0;
        const interrupted: IClerkImportStore = {
          read: (statement) => f.importStore.read(statement),
          commitImport: async (statements, tables) => {
            if (++commits === 2) throw new Error("Simulated final verification connection failure");
            return f.importStore.commitImport(statements, tables);
          },
        };
        const importer = new ClerkIdentityImporter({
          store: interrupted,
          secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
          files: f.files,
        });
        const options = {
          expectedPlanFingerprint: preview.planFingerprint,
          maintenanceMode: true,
        } satisfies Parameters<ClerkIdentityImporter["apply"]>[2];
        const result = await importer.apply(snapshot(), manifest(), options);
        expect(result.kind).toBe("verification_pending");
        const before = await readClerkImportInventory(f.importStore);
        const ledger = before.find((item) => item.table === "identity_import_runs")?.rows[0];
        expect(ledger?.verification).toBe("pending");
        expect(ledger?.verified_at).toBeNull();
        expect(JSON.parse(String(ledger?.report)).kind).toBe("verification_pending");
        expect((await f.importer.preview(snapshot(), manifest())).kind).toBe("verification_pending");
        expect(await readClerkImportInventory(f.importStore)).toEqual(before);
        expect((await f.importer.apply(snapshot(), manifest(), options)).kind).toBe("already_applied");
        const after = await readClerkImportInventory(f.importStore);
        expect(after.filter((item) => item.table !== "identity_import_runs")).toEqual(
          before.filter((item) => item.table !== "identity_import_runs"),
        );
        expect(after.find((item) => item.table === "identity_import_runs")?.rows[0]?.verification).toBe("verified");
        expect(await f.tokens.verifyToken(f.revoked)).toBeUndefined();
      });

      it("recovers an interrupted successful commit by reading the ledger without duplicating data", async () => {
        const f = await setup(adapter);
        const preview = await f.importer.preview(snapshot(), manifest());
        const interrupted: IClerkImportStore = {
          read: (statement) => f.importStore.read(statement),
          commitImport: async (statements, tables) => {
            await f.importStore.commitImport(statements, tables);
            throw new Error("Simulated lost commit acknowledgement");
          },
        };
        const importer = new ClerkIdentityImporter({
          store: interrupted,
          secretCodec: new AesGcmSecretCodec("synthetic-fixture-key"),
          files: f.files,
        });
        expect(
          (
            await importer.apply(snapshot(), manifest(), {
              expectedPlanFingerprint: preview.planFingerprint,
              maintenanceMode: true,
            })
          ).kind,
        ).toBe("apply_uncertain");
        const before = await readClerkImportInventory(f.importStore);
        expect((await f.importer.preview(snapshot(), manifest())).kind).toBe("verification_pending");
        expect(await readClerkImportInventory(f.importStore)).toEqual(before);
        expect(
          (
            await f.importer.apply(snapshot(), manifest(), {
              expectedPlanFingerprint: preview.planFingerprint,
              maintenanceMode: true,
            })
          ).kind,
        ).toBe("already_applied");
        const after = await readClerkImportInventory(f.importStore);
        expect(after.filter((item) => item.table !== "identity_import_runs")).toEqual(
          before.filter((item) => item.table !== "identity_import_runs"),
        );
        expect(after.find((item) => item.table === "identity_import_runs")?.rows[0]?.verification).toBe("verified");
      });
    },
  );
}

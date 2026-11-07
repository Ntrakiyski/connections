import type { AuthMail } from "../human-auth.ts";
import type { RuntimeDatabase } from "../storage/runtime-database.ts";
import type { BetterAuthOptions } from "better-auth";
import type { Hono } from "hono";

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1AuthDatabase } from "../cloudflare/d1-auth-database.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { createHumanAuth } from "../human-auth.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { D1RuntimeDatabase } from "../storage/d1-runtime-store.ts";
import { PostgresRuntimeDatabase } from "../storage/postgres-runtime-store.ts";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { FixtureD1Database } from "../test-fixtures/sqlite-d1.ts";
import { sentinelCatalog, sentinelCredential, SentinelProviderLoader } from "../test-fixtures/two-company.ts";

const origin = "http://localhost:3000";
const password = "synthetic-local-password-12345";
const cleanups: Array<() => Promise<void>> = [];

interface Fixture {
  app: Hono;
  database: RuntimeDatabase;
  write(sql: string, values: Array<string | number>): Promise<void>;
  mail: AuthMail[];
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanups.splice(0)) await close();
});

async function createFixture(adapter: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "connections-human-auth-"));
  const filename = join(directory, "connect.sqlite");
  let database: RuntimeDatabase;
  let authDatabase: BetterAuthOptions["database"];
  let write: Fixture["write"];
  if (adapter === "PostgreSQL") {
    const connectionString = process.env.CONNECTIONS_TEST_POSTGRES_URL;
    const schema = `auth_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    cleanups.push(async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    });
    await pool.query(readFileSync(new URL("../../../connections-docs/insforge-schema.sql", import.meta.url), "utf8"));
    await pool.query(
      readFileSync(new URL("../../../migrations/20261107200000_organization-identity.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      readFileSync(new URL("../../../migrations/20261107210000_identity-governance.sql", import.meta.url), "utf8"),
    );
    const runtime = new PostgresRuntimeDatabase(pool, new PlainTextSecretCodec());
    database = runtime;
    authDatabase = runtime.authDatabase;
    write = async (sql, values) => {
      let index = 0;
      await pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    };
  } else if (adapter === "D1") {
    const binding = new FixtureD1Database();
    database = new D1RuntimeDatabase(binding);
    authDatabase = createD1AuthDatabase(binding);
    write = async (sql, values) => {
      binding.sqlite.prepare(sql).run(...values);
    };
    cleanups.push(async () => {
      binding.sqlite.close();
    });
  } else {
    const runtime = new SqliteRuntimeDatabase(filename);
    const raw = new DatabaseSync(filename);
    database = runtime;
    authDatabase = runtime.authDatabase;
    write = async (sql, values) => {
      raw.prepare(sql).run(...values);
    };
    cleanups.push(async () => {
      raw.close();
      runtime.close();
    });
  }
  const mail: AuthMail[] = [];
  const auth = createHumanAuth(
    {
      baseURL: origin,
      secret: "synthetic-only-auth-secret-at-least-32-characters",
      trustedOrigins: [],
      sendMail: async (message) => {
        mail.push(message);
      },
    },
    authDatabase,
  );
  const connect = await createConnectApp({
    catalog: sentinelCatalog,
    providerLoader: new SentinelProviderLoader(),
    runtimeDatabase: database,
    transitFiles: new TransitFileService({
      rootDir: join(directory, "files"),
      publicOrigin: origin,
      ttlSeconds: 60,
      maxBytes: 1024,
    }),
    publicOrigin: origin,
    secretCodec: new PlainTextSecretCodec(),
    humanAuth: auth,
    authMailDelivery: async (message) => {
      mail.push(message);
    },
  });
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { app: connect.app, database, write, mail };
}

function post(app: Hono, path: string, body: unknown, cookie = "", requestOrigin = origin): Promise<Response> {
  return Promise.resolve(
    app.request(new URL(path, origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", origin: requestOrigin, cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function register(
  fixture: Fixture,
  email = "operator@example.test",
): Promise<{ cookie: string; userId: string }> {
  const { app, mail } = fixture;
  const created = await post(app, "/api/identity/sign-up/email", {
    name: "Operator",
    email,
    password,
  });
  expect(created.status).toBe(200);
  expect((await post(app, "/api/identity/sign-in/email", { email, password })).status).toBe(403);
  const message = mail.find((item) => item.subject === "Verify your Connections email" && item.to === email);
  if (!message) throw new Error("Verification delivery was not requested.");
  const verified = await app.request(message.text.replace("Verify your email: ", ""));
  expect(verified.status).toBe(302);
  expect(new URL(verified.headers.get("location") ?? "", origin).searchParams.has("error")).toBe(false);
  const signedIn = await post(app, "/api/identity/sign-in/email", { email, password });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(cookie).toContain("better-auth.session_token=");
  const result: unknown = await signedIn.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("user" in result) ||
    !result.user ||
    typeof result.user !== "object" ||
    !("id" in result.user) ||
    typeof result.user.id !== "string"
  ) {
    throw new Error("Sign-in response did not contain a stable user identity.");
  }
  return { cookie, userId: result.user.id };
}

async function seed(fixture: Fixture, userId: string): Promise<void> {
  const { write, database } = fixture;
  for (const company of ["A", "B"]) {
    await write("insert into organizations(id,name,slug,created_at) values(?,?,?,?)", [
      company,
      company,
      company.toLowerCase(),
      new Date().toISOString(),
    ]);
    await write("insert into organization_memberships(id,organization_id,user_id,role,created_at) values(?,?,?,?,?)", [
      `${company}-${userId}`,
      company,
      userId,
      "owner",
      new Date().toISOString(),
    ]);
    const workspaceId = `${company}1`;
    await database.workspaceStore.create({
      id: workspaceId,
      organizationId: company,
      clerkOrgId: `connections-workspace:${workspaceId}`,
      name: workspaceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await database.membershipStore.setRole(workspaceId, userId, "admin");
    await database.workspaceControlStore.enableProvider({
      workspaceId,
      service: "sentinel",
      enabledBy: userId,
      enabledAt: new Date().toISOString(),
    });
    await database
      .createScopedStores(workspaceId)
      .connectionStore.set("sentinel", "shared", sentinelCredential(`${workspaceId}-account`), userId);
  }
}

for (const adapter of ["SQLite", "D1", "PostgreSQL"]) {
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} Better Auth cookie and principal integration`,
    () => {
      const setup = (): Promise<Fixture> => createFixture(adapter);
      it("uses opaque consent ownership under concurrent callbacks and ignores alternate browser selectors", async () => {
        const fixture = await setup();
        const { cookie, userId } = await register(fixture);
        await seed(fixture, userId);
        await fixture.database.createScopedStores("A1").oauthClientConfigStore.set({
          service: "sentinel",
          clientId: "synthetic-client",
          clientSecret: "synthetic-secret",
          extra: {},
          secretExtra: {},
        });
        const started = await fixture.app.request(`${origin}/api/oauth/authorizations`, {
          method: "POST",
          headers: { cookie, origin, "x-workspace-id": "A1", "content-type": "application/json" },
          body: JSON.stringify({ service: "sentinel", connectionName: "shared" }),
        });
        expect(started.status).toBe(200);
        const authorization = await started.json();
        const state = new URL(authorization.authorizationUrl).searchParams.get("state");
        expect(state).toBe(authorization.state);
        expect(state).not.toContain("A1");
        expect(state).not.toContain(userId);
        const tokenExchange = vi.fn(async () =>
          Response.json({ access_token: "synthetic-exchanged-account", token_type: "Bearer" }),
        );
        vi.stubGlobal("fetch", tokenExchange);
        const callback = `${origin}/oauth/callback?state=${encodeURIComponent(state ?? "")}&code=synthetic-code&workspaceId=B1`;
        const results = await Promise.all([
          fixture.app.request(callback, { headers: { cookie, "x-workspace-id": "B1" } }),
          fixture.app.request(callback),
        ]);
        expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
        const completed = results.find((response) => response.status === 200);
        if (!completed) throw new Error("Successful callback missing.");
        const html = await completed.text();
        expect(html).toContain('"workspaceId":"A1"');
        expect(html).toContain(`"userId":"${userId}"`);
        expect(html).toContain(`"state":"${state}"`);
        expect(tokenExchange).toHaveBeenCalledTimes(1);
        expect(
          await fixture.database.createScopedStores("A1").connectionStore.getStored("sentinel", "shared"),
        ).toMatchObject({ createdBy: userId, credential: { accessToken: "synthetic-exchanged-account" } });
        expect(await fixture.database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).toMatchObject(
          { apiKey: "B1-account" },
        );
        expect((await fixture.app.request(callback)).status).toBe(400);
      });

      it("does not save exchanged credentials when the grant disappears during the provider request", async () => {
        const fixture = await setup();
        const { userId } = await register(fixture);
        await seed(fixture, userId);
        await fixture.database
          .createScopedStores("A1")
          .oauthClientConfigStore.set({
            service: "sentinel",
            clientId: "synthetic-client",
            clientSecret: "synthetic-secret",
            extra: {},
            secretExtra: {},
          });
        const state = crypto.randomUUID();
        await fixture.database
          .createScopedStores("A1")
          .oauthStateStore.set({
            state,
            userId,
            workspaceId: "A1",
            service: "sentinel",
            connectionName: "shared",
            createdAt: new Date().toISOString(),
          });
        const exchange = vi.fn(async () => {
          await fixture.write("delete from workspace_memberships where workspace_id=? and user_id=?", ["A1", userId]);
          return Response.json({ access_token: "removed-during-exchange", token_type: "Bearer" });
        });
        vi.stubGlobal("fetch", exchange);
        const response = await fixture.app.request(`${origin}/oauth/callback?state=${state}&code=synthetic-code`);
        expect(response.status).toBe(403);
        expect(exchange).toHaveBeenCalledTimes(1);
        expect(await fixture.database.createScopedStores("A1").connectionStore.get("sentinel", "shared")).toMatchObject(
          { apiKey: "A1-account" },
        );
        expect(await fixture.database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).toMatchObject(
          { apiKey: "B1-account" },
        );
        expect(await fixture.database.providerOAuthConsents?.take(state)).toBeUndefined();
      });

      it("consumes expired or future consent and refuses callbacks after provider disablement or archive", async () => {
        const fixture = await setup();
        const { userId } = await register(fixture);
        await seed(fixture, userId);
        const exchange = vi.fn(async () => Response.json({ access_token: "denied-token", token_type: "Bearer" }));
        vi.stubGlobal("fetch", exchange);
        for (const change of ["expired", "future", "disable_provider", "archive", "remove_company"]) {
          const state = crypto.randomUUID();
          const createdAt = new Date(
            Date.now() + (change === "expired" ? -3600000 : change === "future" ? 3600000 : 0),
          ).toISOString();
          await fixture.database.createScopedStores("A1").oauthStateStore.set({
            state,
            userId,
            workspaceId: "A1",
            service: "sentinel",
            connectionName: "shared",
            createdAt,
          });
          if (change === "disable_provider")
            await fixture.database.workspaceControlStore.disableProvider("A1", "sentinel");
          if (change === "archive")
            await fixture.write("update workspaces set deleted_at=? where id=?", [new Date().toISOString(), "A1"]);
          if (change === "remove_company") {
            await fixture.write("update workspaces set deleted_at=null where id=?", ["A1"]);
            await fixture.write("delete from organization_memberships where organization_id=? and user_id=?", [
              "A",
              userId,
            ]);
          }
          const response = await fixture.app.request(`${origin}/oauth/callback?state=${state}&code=denied-code`);
          expect([400, 403]).toContain(response.status);
          expect(await fixture.database.providerOAuthConsents?.take(state)).toBeUndefined();
        }
        expect(exchange).not.toHaveBeenCalled();
        expect(await fixture.database.createScopedStores("A1").connectionStore.get("sentinel", "shared")).toMatchObject(
          { apiKey: "A1-account" },
        );
        expect(await fixture.database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).toMatchObject(
          { apiKey: "B1-account" },
        );
      });

      it("requires verification and delivers recovery without exposing authentication tokens", async () => {
        const fixture = await setup();
        const { cookie } = await register(fixture);
        expect((await fixture.app.request(`${origin}/api/account`, { headers: { cookie } })).status).toBe(200);
        const recovery = await post(fixture.app, "/api/identity/request-password-reset", {
          email: "operator@example.test",
          redirectTo: `${origin}/reset-password`,
        });
        expect(recovery.status).toBe(200);
        const message = fixture.mail.find((item) => item.subject === "Reset your Connections password");
        if (!message) throw new Error("Recovery delivery was not requested.");
        const token = new URL(message.text.replace("Reset your password: ", "")).pathname.split("/").pop();
        const reset = await post(fixture.app, "/api/identity/reset-password", {
          token,
          newPassword: `${password}-changed`,
        });
        expect(reset.status).toBe(200);
        expect((await fixture.app.request(`${origin}/api/account`, { headers: { cookie } })).status).toBe(401);
        expect(
          (await post(fixture.app, "/api/identity/sign-in/email", { email: "operator@example.test", password })).status,
        ).toBe(401);
      });

      it("binds each browser tab to its explicit live grant and rejects wrong-origin mutations", async () => {
        const fixture = await setup();
        const { cookie, userId } = await register(fixture);
        await seed(fixture, userId);
        for (const workspaceId of ["A1", "B1"]) {
          const response = await fixture.app.request(`${origin}/api/connections`, {
            headers: { cookie, "x-workspace-id": workspaceId },
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject([{ connectionName: "shared" }]);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
        }
        const denied = await fixture.app.request(`${origin}/api/runtime-tokens`, {
          method: "POST",
          headers: {
            cookie,
            "x-workspace-id": "A1",
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          body: JSON.stringify({ name: "denied" }),
        });
        expect(denied.status).toBe(403);
        expect(await fixture.database.createScopedStores("A1").runtimeTokenStore.list()).toEqual([]);
        const unknown = await fixture.app.request(`${origin}/api/auth/session`, {
          headers: { cookie, "x-workspace-id": "ungranted" },
        });
        expect(unknown.status).toBe(403);
        await fixture.write("delete from organization_memberships where organization_id=? and user_id=?", [
          "A",
          userId,
        ]);
        expect(
          (await fixture.app.request(`${origin}/api/auth/session`, { headers: { cookie, "x-workspace-id": "A1" } }))
            .status,
        ).toBe(403);
        expect(
          (await fixture.app.request(`${origin}/api/auth/session`, { headers: { cookie, "x-workspace-id": "B1" } }))
            .status,
        ).toBe(200);
      });

      it("rejects plugin company mutations, conflicting credentials and machine scope changes", async () => {
        const fixture = await setup();
        const { cookie, userId } = await register(fixture);
        await seed(fixture, userId);
        expect(
          (await post(fixture.app, "/api/identity/organization/create", { name: "Bypass", slug: "bypass" }, cookie))
            .status,
        ).toBe(403);
        const token = await new RuntimeTokenService(fixture.database.runtimeTokenStore).createToken(
          "A1",
          userId,
          "Synthetic agent",
        );
        expect(
          (
            await fixture.app.request(`${origin}/v1/providers`, {
              headers: { authorization: `Bearer ${token.token}`, cookie },
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await fixture.app.request(`${origin}/v1/providers`, {
              headers: { authorization: `Bearer ${token.token}`, "x-workspace-id": "B1" },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await fixture.app.request(`${origin}/v1/providers?workspaceId=B1`, {
              headers: { authorization: `Bearer ${token.token}`, "x-workspace-id": "A1" },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { authorization: `Bearer ${token.token}` },
            })
          ).status,
        ).toBe(401);
        expect(
          (await fixture.app.request(`${origin}/v1/providers`, { headers: { authorization: `Bearer ${token.token}` } }))
            .status,
        ).toBe(200);
        expect(
          (await fixture.app.request(`${origin}/v1/providers`, { headers: { authorization: "Bearer unknown" } }))
            .status,
        ).toBe(401);
      });

      it("retains revoked keys and refuses to reuse them or modify them through sibling stores", async () => {
        const fixture = await setup();
        const { userId } = await register(fixture);
        await seed(fixture, userId);
        const token = await new RuntimeTokenService(fixture.database.runtimeTokenStore).createToken(
          "A1",
          userId,
          "Persistent revocation",
        );
        const a = fixture.database.createScopedStores("A1").runtimeTokenStore;
        const b = fixture.database.createScopedStores("B1").runtimeTokenStore;
        expect(await a.findByHash(token.record.tokenHash)).toMatchObject({ workspaceId: "A1", userId });
        expect(await b.findByHash(token.record.tokenHash)).toBeUndefined();
        await expect(b.add(token.record)).rejects.toThrow("workspace");
        expect(await b.revoke(token.record.id)).toBe(false);
        expect(await a.revoke(token.record.id)).toBe(true);
        expect(await a.revoke(token.record.id)).toBe(false);
        await expect(a.add(token.record)).rejects.toThrow();
        expect(await fixture.database.runtimeTokenStore.findByHash(token.record.tokenHash)).toBeUndefined();
        expect(
          (await fixture.app.request(`${origin}/v1/providers`, { headers: { authorization: `Bearer ${token.token}` } }))
            .status,
        ).toBe(401);
      });

      it("routes company governance through verified cookies and rechecks each grant after acceptance and removal", async () => {
        const fixture = await setup();
        const operator = await register(fixture);
        await seed(fixture, operator.userId);
        const companies = await fixture.app.request(`${origin}/api/companies`, {
          headers: { cookie: operator.cookie },
        });
        expect(companies.status).toBe(200);
        expect(await companies.json()).toMatchObject([{ id: "A" }, { id: "B" }]);
        const overview = await fixture.app.request(`${origin}/api/companies/A`, {
          headers: { cookie: operator.cookie },
        });
        expect(overview.status).toBe(200);
        expect(await overview.json()).toMatchObject({
          members: [{ userId: operator.userId, role: "owner" }],
          workspaces: [{ id: "A1" }],
        });
        expect(
          (
            await post(
              fixture.app,
              "/api/companies/B/invitations",
              { email: "invitee@example.test", role: "member", grants: [] },
              operator.cookie,
              "https://attacker.example",
            )
          ).status,
        ).toBe(403);
        const created = await post(
          fixture.app,
          "/api/companies/B/invitations",
          { email: "invitee@example.test", role: "member", grants: [{ workspaceId: "B1", role: "manager" }] },
          operator.cookie,
        );
        expect(created.status).toBe(201);
        const invitation: unknown = await created.json();
        if (
          !invitation ||
          typeof invitation !== "object" ||
          !("invitationId" in invitation) ||
          typeof invitation.invitationId !== "string"
        )
          throw new Error("Invitation ID missing.");
        const invitee = await register(fixture, "invitee@example.test");
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { cookie: invitee.cookie, "x-workspace-id": "B1" },
            })
          ).status,
        ).toBe(403);
        expect(
          (await post(fixture.app, `/api/account/invitations/${invitation.invitationId}/accept`, {}, invitee.cookie))
            .status,
        ).toBe(200);
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { cookie: invitee.cookie, "x-workspace-id": "B1" },
            })
          ).status,
        ).toBe(200);
        const removed = await fixture.app.request(`${origin}/api/companies/B/workspaces/B1/grants/${invitee.userId}`, {
          method: "DELETE",
          headers: { cookie: operator.cookie, origin },
        });
        expect(removed.status).toBe(200);
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { cookie: invitee.cookie, "x-workspace-id": "B1" },
            })
          ).status,
        ).toBe(403);
        expect(
          (await post(fixture.app, `/api/account/invitations/${invitation.invitationId}/accept`, {}, invitee.cookie))
            .status,
        ).toBe(200);
        expect(await fixture.database.membershipStore.getRole("B1", invitee.userId)).toBeUndefined();
        const lastAdmin = await fixture.app.request(
          `${origin}/api/companies/A/workspaces/A1/grants/${operator.userId}`,
          { method: "DELETE", headers: { cookie: operator.cookie, origin } },
        );
        expect(lastAdmin.status).toBe(409);
        const invalid = await post(
          fixture.app,
          "/api/companies",
          { name: "", slug: "invalid", workspaceName: "empty" },
          operator.cookie,
        );
        expect(invalid.status).toBe(400);
      });

      it("invalidates the stored session on server-side logout", async () => {
        const fixture = await setup();
        const { cookie } = await register(fixture);
        expect((await post(fixture.app, "/api/auth/logout", {}, cookie, "https://attacker.example")).status).toBe(403);
        expect((await fixture.app.request(`${origin}/api/account`, { headers: { cookie } })).status).toBe(200);
        expect((await post(fixture.app, "/api/identity/sign-out", {}, cookie, "https://attacker.example")).status).toBe(
          403,
        );
        expect((await post(fixture.app, "/api/auth/logout", {}, cookie)).status).toBe(200);
        expect((await fixture.app.request(`${origin}/api/account`, { headers: { cookie } })).status).toBe(401);
      });
    },
  );
}

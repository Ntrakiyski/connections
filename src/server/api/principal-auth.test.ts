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
import { afterEach, describe, expect, it } from "vitest";
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

async function register(fixture: Fixture): Promise<{ cookie: string; userId: string }> {
  const { app, mail } = fixture;
  const created = await post(app, "/api/identity/sign-up/email", {
    name: "Operator",
    email: "operator@example.test",
    password,
  });
  expect(created.status).toBe(200);
  expect((await post(app, "/api/identity/sign-in/email", { email: "operator@example.test", password })).status).toBe(
    403,
  );
  const message = mail.find((item) => item.subject === "Verify your Connections email");
  if (!message) throw new Error("Verification delivery was not requested.");
  const verified = await app.request(message.text.replace("Verify your email: ", ""));
  expect(verified.status).toBe(302);
  expect(new URL(verified.headers.get("location") ?? "", origin).searchParams.has("error")).toBe(false);
  const signedIn = await post(app, "/api/identity/sign-in/email", { email: "operator@example.test", password });
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

import type { AuthMail } from "../human-auth.ts";
import type { RuntimeDatabase } from "../storage/runtime-database.ts";
import type { WorkflowBackend } from "./workflow-routes.ts";
import type { BetterAuthOptions } from "better-auth";
import type { Hono } from "hono";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import pino from "pino";
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
  loader: SentinelProviderLoader;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanups.splice(0)) await close();
});

async function createFixture(adapter: string, workflowBackends?: WorkflowBackend[]): Promise<Fixture> {
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
      readFileSync(
        new URL("../../../migrations/20260718095600_workspace-safety-settings.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      readFileSync(new URL("../../../migrations/20261107200000_organization-identity.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      readFileSync(new URL("../../../migrations/20261107210000_identity-governance.sql", import.meta.url), "utf8"),
    );
    const runtime = new PostgresRuntimeDatabase(pool, new PlainTextSecretCodec());
    await pool.query(
      readFileSync(new URL("../../../migrations/20261107230000_meetings-oauth.sql", import.meta.url), "utf8"),
    );
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
  const loader = new SentinelProviderLoader();
  const connect = await createConnectApp({
    logger: pino({ level: "error" }),
    catalog: sentinelCatalog,
    providerLoader: loader,
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
    workflowBackends,
    authMailDelivery: async (message) => {
      mail.push(message);
    },
  });
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { app: connect.app, database, write, mail, loader };
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

for (const adapter of ["SQLite", "PostgreSQL"]) {
  it.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    `${adapter} routes Open Flow requests only for the workspace's assigned Connections account`,
    async () => {
      const backends: WorkflowBackend[] = [];
      const fixture = await createFixture(adapter, backends);
      const alice = await register(fixture, "alice@example.test");
      const bob = await register(fixture, "bob@example.test");
      await seed(fixture, alice.userId);
      for (const company of ["A", "B"]) {
        await fixture.write(
          "insert into organization_memberships(id,organization_id,user_id,role,created_at) values(?,?,?,?,?)",
          [`${company}-${bob.userId}`, company, bob.userId, "member", new Date().toISOString()],
        );
        await fixture.database.membershipStore.setRole(`${company}1`, bob.userId, "member");
      }
      backends.push(
        { workspaceId: "A1", userId: alice.userId, origin: "http://flow-a.test", token: `ofp_${"a".repeat(43)}` },
        { workspaceId: "B1", userId: bob.userId, origin: "http://flow-b.test", token: `ofp_${"b".repeat(43)}` },
      );
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.headers.has("cookie")).toBe(false);
        const target = new URL(request.url);
        const backend = backends.find((entry) => entry.origin === target.origin);
        expect(request.headers.get("authorization")).toBe(`Bearer ${backend?.token}`);
        expect(init?.redirect).toBe("manual");
        if (target.pathname.endsWith("/notifications")) {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              streamController = controller;
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json(
          { flows: [{ flowId: `${backend?.workspaceId}-flow` }] },
          { headers: { "set-cookie": "leak=1" } },
        );
      });
      vi.stubGlobal("fetch", upstream);

      const request = (workspace: string, cookie = "", path = "", init?: RequestInit) =>
        fixture.app.request(`${origin}/api/workflows/${workspace}${path}`, {
          ...init,
          headers: { cookie, ...init?.headers },
        });
      expect(await (await request("A1", alice.cookie)).json()).toEqual({ enabled: true });
      expect(await (await request("A1", bob.cookie)).json()).toEqual({ enabled: false });
      expect((await request("A1", "", "/v1/flows")).status).toBe(401);
      expect((await request("B1", alice.cookie, "/v1/flows")).status).toBe(403);
      expect((await request("A1", bob.cookie, "/v1/flows")).status).toBe(403);
      expect((await request("A1", alice.cookie, "/auth/session")).status).toBe(404);
      expect((await request("A1", alice.cookie, "/v1/flows%2f..%2fmcp")).status).toBe(404);
      expect((await request("A1", alice.cookie, "/v1/flows", { method: "POST" })).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();

      const result = await request("A1", alice.cookie, "/v1/flows?limit=10");
      expect(result.status).toBe(200);
      expect(result.headers.has("set-cookie")).toBe(false);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(await result.json()).toEqual({ flows: [{ flowId: "A1-flow" }] });
      expect(await (await request("B1", bob.cookie, "/v1/flows")).json()).toEqual({ flows: [{ flowId: "B1-flow" }] });

      const subscription = await request("B1", bob.cookie, "/v1/flows/notifications");
      const reader = subscription.body!.getReader();
      const frame = new TextEncoder().encode('data: {"kind":"flows.changed"}\n\n');
      streamController!.enqueue(frame);
      expect(await reader.read()).toEqual({ done: false, value: frame });
      await fixture.write("delete from organization_memberships where organization_id=? and user_id=?", [
        "B",
        bob.userId,
      ]);
      streamController!.enqueue(frame);
      expect((await reader.read()).done).toBe(true);
      expect((await request("B1", bob.cookie, "/v1/flows")).status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(3);
    },
  );
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
        await fixture.database.createScopedStores("A1").oauthClientConfigStore.set({
          service: "sentinel",
          clientId: "synthetic-client",
          clientSecret: "synthetic-secret",
          extra: {},
          secretExtra: {},
        });
        const state = crypto.randomUUID();
        await fixture.database.createScopedStores("A1").oauthStateStore.set({
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

      it("keeps runtime bodies and MCP tool arguments bound to the stored key and persists only original-workspace runs", async () => {
        const fixture = await setup();
        const { userId, cookie } = await register(fixture);
        await seed(fixture, userId);
        await fixture.database.workspaceStore.create({
          id: "A2",
          organizationId: "A",
          clerkOrgId: "connections-workspace:A2",
          name: "A2",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await fixture.database.membershipStore.setRole("A2", userId, "admin");
        await fixture.database.workspaceControlStore.enableProvider({
          workspaceId: "A2",
          service: "sentinel",
          enabledBy: userId,
          enabledAt: new Date().toISOString(),
        });
        await fixture.database
          .createScopedStores("A2")
          .connectionStore.set("sentinel", "shared", sentinelCredential("A2-account"), userId);
        const key = await new RuntimeTokenService(fixture.database.runtimeTokenStore).createToken(
          "A1",
          userId,
          "Existing automation",
        );
        expect((await post(fixture.app, "/api/identity/sign-out", {}, cookie)).status).toBe(200);
        for (const alternate of ["A2", "B1"]) {
          const result = await fixture.app.request(`${origin}/v1/actions/sentinel.get_account`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key.token}`,
              "content-type": "application/json",
              "x-oo-connector-app-id": "sentinel:shared",
            },
            body: JSON.stringify({
              workspaceId: alternate,
              input: { workspaceId: alternate, organizationId: "B", userId: "another-user" },
            }),
          });
          expect(result.status).toBe(200);
          expect(await result.json()).toMatchObject({ data: { selectedAccount: "A1-account", workspaceId: "A1" } });
          const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${key.token}` } },
            fetch: (input, init) => Promise.resolve(fixture.app.request(input, init)),
          });
          const client = new Client({ name: "bound-key-test", version: "1" });
          await client.connect(transport);
          try {
            const tool = await client.callTool({
              name: "execute_action",
              arguments: {
                actionId: "sentinel.get_account",
                connectionName: "shared",
                workspaceId: alternate,
                input: { workspaceId: alternate },
              },
            });
            expect(tool.isError).not.toBe(true);
            expect(tool.content).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "text", text: expect.stringMatching(/"workspaceId"\s*:\s*"A1"/) }),
              ]),
            );
          } finally {
            await client.close();
          }
        }
        for (const alternate of ["A2", "B1"]) {
          expect(
            (
              await fixture.app.request(`${origin}/v1/actions/sentinel.get_account`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${key.token}`,
                  "x-workspace-id": alternate,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ connectionName: "shared", input: {} }),
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await fixture.app.request(`${origin}/v1/actions/sentinel.get_account?workspaceId=${alternate}`, {
                method: "POST",
                headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
                body: JSON.stringify({ connectionName: "shared", input: {} }),
              })
            ).status,
          ).toBe(403);
        }
        expect(fixture.loader.selectedAccounts).toEqual(["A1-account", "A1-account", "A1-account", "A1-account"]);
        const runs = await fixture.database.createScopedStores("A1").runLogStore.list();
        expect(runs.items).toHaveLength(4);
        for (const run of runs.items)
          expect(run).toMatchObject({ workspaceId: "A1", userId, connectionProfile: { accountId: "A1-account" } });
        for (const workspaceId of ["A2", "B1"])
          expect((await fixture.database.createScopedStores(workspaceId).runLogStore.list()).items).toEqual([]);
        expect(await fixture.database.runtimeTokenStore.findByHash(key.record.tokenHash)).toMatchObject({
          id: key.record.id,
          userId,
          workspaceId: "A1",
          tokenHash: key.record.tokenHash,
        });
      });

      it("rechecks runtime role on the next request and preserves the independent company-B key", async () => {
        const fixture = await setup();
        const operator = await register(fixture);
        const other = await register(fixture, "alice@example.test");
        await seed(fixture, operator.userId);
        await fixture.write(
          "insert into organization_memberships(id,organization_id,user_id,role,created_at) values(?,?,?,?,?)",
          [crypto.randomUUID(), "A", other.userId, "member", new Date().toISOString()],
        );
        await fixture.database.membershipStore.setRole("A1", other.userId, "admin");
        await fixture.database.createScopedStores("A1").connectionStore.delete("sentinel", "shared");
        await fixture.database
          .createScopedStores("A1")
          .connectionStore.set("sentinel", "shared", sentinelCredential("alice-owned"), other.userId);
        const tokens = new RuntimeTokenService(fixture.database.runtimeTokenStore);
        const a = await tokens.createToken("A1", operator.userId, "A automation");
        const b = await tokens.createToken("B1", operator.userId, "B automation");
        const run = (token: string): Promise<Response> =>
          Promise.resolve(
            fixture.app.request(`${origin}/v1/actions/sentinel.get_account`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-oo-connector-app-id": "sentinel:shared",
              },
              body: JSON.stringify({ input: {} }),
            }),
          );
        expect((await run(a.token)).status).toBe(200);
        const changed = await fixture.app.request(`${origin}/api/companies/A/workspaces/A1/grants/${operator.userId}`, {
          method: "PUT",
          headers: { cookie: operator.cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        });
        expect(changed.status).toBe(200);
        const denied = await run(a.token);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toMatchObject({ errorCode: "connection_not_found" });
        const permitted = await run(b.token);
        expect(permitted.status).toBe(200);
        expect(await permitted.json()).toMatchObject({ data: { selectedAccount: "B1-account", workspaceId: "B1" } });
        expect(fixture.loader.selectedAccounts).toEqual(["alice-owned", "B1-account"]);
        expect((await fixture.database.createScopedStores("A1").runLogStore.list()).items).toHaveLength(1);
      });

      it("offboards company A through the API while B credentials and automation remain independent", async () => {
        const fixture = await setup();
        const operator = await register(fixture);
        const target = await register(fixture, "member@example.test");
        await seed(fixture, operator.userId);
        for (const organizationId of ["A", "B"]) {
          const workspaceId = `${organizationId}1`;
          const created = await post(
            fixture.app,
            `/api/companies/${organizationId}/invitations`,
            { email: "member@example.test", role: "member", grants: [{ workspaceId, role: "member" }] },
            operator.cookie,
          );
          expect(created.status).toBe(201);
          const invitation = await created.json();
          expect(
            (await post(fixture.app, `/api/account/invitations/${invitation.invitationId}/accept`, {}, target.cookie))
              .status,
          ).toBe(200);
          await fixture.database
            .createScopedStores(workspaceId)
            .connectionStore.set("sentinel", "member", sentinelCredential(`${workspaceId}-member`), target.userId);
        }
        const tokens = new RuntimeTokenService(fixture.database.runtimeTokenStore);
        const a = await tokens.createToken("A1", target.userId, "Member A");
        const b = await tokens.createToken("B1", target.userId, "Member B");
        const run = (token: string): Promise<Response> =>
          Promise.resolve(
            fixture.app.request(`${origin}/v1/actions/sentinel.get_account`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ connectionName: "member", input: {} }),
            }),
          );
        expect((await run(a.token)).status).toBe(200);
        const removed = await fixture.app.request(`${origin}/api/companies/A/members/${target.userId}`, {
          method: "DELETE",
          headers: { cookie: operator.cookie, origin },
        });
        expect(removed.status).toBe(200);
        expect((await run(a.token)).status).toBe(401);
        const stillAuthorized = await run(b.token);
        expect(stillAuthorized.status).toBe(200);
        expect(await stillAuthorized.json()).toMatchObject({
          data: { selectedAccount: "B1-member", workspaceId: "B1" },
        });
        expect(
          await fixture.database.createScopedStores("A1").connectionStore.get("sentinel", "member"),
        ).toBeUndefined();
        expect(
          await fixture.database.createScopedStores("B1").connectionStore.getStored("sentinel", "member"),
        ).toMatchObject({ createdBy: target.userId, credential: { apiKey: "B1-member" } });
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { cookie: target.cookie, "x-workspace-id": "A1" },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await fixture.app.request(`${origin}/api/connections`, {
              headers: { cookie: target.cookie, "x-workspace-id": "B1" },
            })
          ).status,
        ).toBe(200);
        expect((await fixture.database.createScopedStores("B1").runLogStore.list()).items).toEqual([
          expect.objectContaining({
            workspaceId: "B1",
            userId: target.userId,
            connectionProfile: expect.objectContaining({ accountId: "B1-member" }),
          }),
        ]);
      });

      it("archives resources and restores data without resurrecting revoked runtime keys", async () => {
        const fixture = await setup();
        const { cookie, userId } = await register(fixture);
        await seed(fixture, userId);
        const tokens = new RuntimeTokenService(fixture.database.runtimeTokenStore);
        const a = await tokens.createToken("A1", userId, "Archived A");
        const b = await tokens.createToken("B1", userId, "Independent B");
        const archive = await fixture.app.request(`${origin}/api/workspace`, {
          method: "DELETE",
          headers: { cookie, origin, "x-workspace-id": "A1", "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "A1" }),
        });
        expect(archive.status).toBe(200);
        expect(
          (await fixture.app.request(`${origin}/api/connections`, { headers: { cookie, "x-workspace-id": "A1" } }))
            .status,
        ).toBe(403);
        expect(
          (await fixture.app.request(`${origin}/v1/apps`, { headers: { authorization: `Bearer ${a.token}` } })).status,
        ).toBe(401);
        expect(
          (await fixture.app.request(`${origin}/v1/apps`, { headers: { authorization: `Bearer ${b.token}` } })).status,
        ).toBe(200);
        const restored = await fixture.app.request(`${origin}/api/workspace/restore`, {
          method: "POST",
          headers: { cookie, origin, "x-workspace-id": "A1" },
        });
        expect(restored.status).toBe(200);
        expect(
          (await fixture.app.request(`${origin}/api/connections`, { headers: { cookie, "x-workspace-id": "A1" } }))
            .status,
        ).toBe(200);
        expect(
          (await fixture.app.request(`${origin}/v1/apps`, { headers: { authorization: `Bearer ${a.token}` } })).status,
        ).toBe(401);
        const fresh = await tokens.createToken("A1", userId, "Reauthorized A");
        const run = await fixture.app.request(`${origin}/v1/actions/sentinel.get_account`, {
          method: "POST",
          headers: { authorization: `Bearer ${fresh.token}`, "content-type": "application/json" },
          body: JSON.stringify({ connectionName: "shared", input: {} }),
        });
        expect(run.status).toBe(200);
        expect(await run.json()).toMatchObject({ data: { selectedAccount: "A1-account", workspaceId: "A1" } });
        expect(await fixture.database.runtimeTokenStore.findByHash(a.record.tokenHash)).toBeUndefined();
        expect(await fixture.database.workspaceControlStore.listAuditEvents("A1", 100)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event: "workspace.deleted" }),
            expect.objectContaining({ event: "workspace.restored" }),
          ]),
        );
      });

      it("keeps alternating cookie reads and writes private and persists each tab's declared destination", async () => {
        const fixture = await setup();
        const { cookie, userId } = await register(fixture);
        await seed(fixture, userId);
        for (const [workspaceId, account] of [
          ["A1", "A1-edited"],
          ["B1", "B1-edited"],
          ["A1", "A1-edited-again"],
        ]) {
          const response = await fixture.app.request(`${origin}/api/connections/sentinel`, {
            method: "PUT",
            headers: { cookie, origin, "x-workspace-id": workspaceId, "content-type": "application/json" },
            body: JSON.stringify({
              authType: "api_key",
              connectionName: "shared",
              values: { apiKey: account },
              workspaceId: workspaceId === "A1" ? "B1" : "A1",
            }),
          });
          expect(response.status).toBe(200);
          const read = await fixture.app.request(`${origin}/api/connections`, {
            headers: { cookie, "x-workspace-id": workspaceId },
          });
          expect(read.status).toBe(200);
          expect(read.headers.get("cache-control")).toBe("private, no-store");
          expect(read.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
          expect(await read.json()).toEqual([
            expect.objectContaining({ profile: expect.objectContaining({ accountId: account }) }),
          ]);
        }
        expect(
          await fixture.database.createScopedStores("A1").connectionStore.getStored("sentinel", "shared"),
        ).toMatchObject({ createdBy: userId, credential: { apiKey: "A1-edited-again" } });
        expect(
          await fixture.database.createScopedStores("B1").connectionStore.getStored("sentinel", "shared"),
        ).toMatchObject({ createdBy: userId, credential: { apiKey: "B1-edited" } });
        const aCatalog = await fixture.app.request(`${origin}/api/providers`, {
          headers: { cookie, "x-workspace-id": "A1" },
        });
        expect(aCatalog.headers.get("cache-control")).toBe("private, no-store");
        expect(aCatalog.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
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
        const recoveryUrl = new URL(message.text.replace("Reset your password: ", ""));
        const callback = await fixture.app.request(recoveryUrl.toString());
        expect(callback.status).toBe(302);
        const resetUrl = new URL(callback.headers.get("location") ?? "", origin);
        expect(resetUrl.origin).toBe(origin);
        expect(resetUrl.pathname).toBe("/reset-password");
        const token = resetUrl.searchParams.get("token");
        expect(token).toBeTruthy();
        recoveryUrl.searchParams.set("callbackURL", "https://untrusted.invalid/reset-password");
        const deniedRedirect = await fixture.app.request(recoveryUrl.toString());
        expect(deniedRedirect.status).toBe(403);
        expect(deniedRedirect.headers.has("location")).toBe(false);
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

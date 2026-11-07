import type { AuthMail, ConnectionsHumanAuth } from "../human-auth.ts";
import type { FixtureDatabase } from "../test-fixtures/runtime-database.ts";
import type { Hono } from "hono";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CompanyService } from "../company-service.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { createHumanAuth } from "../human-auth.ts";
import { meetingsOAuthClientId, meetingsOAuthRedirect } from "../meetings-oauth-context.ts";
import { MeetingsOAuthService } from "../meetings-oauth.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec.ts";
import { createFixtureDatabase } from "../test-fixtures/runtime-database.ts";
import { sentinelCatalog, SentinelProviderLoader } from "../test-fixtures/two-company.ts";

const origin = "http://localhost:8892";
const password = "SyntheticNativePassword123!";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
interface NativeFixture extends FixtureDatabase {
  app: Hono;
  auth: ConnectionsHumanAuth;
  userId: string;
  cookie: string;
  otherCookie: string;
  companies: CompanyService;
  ownerId: string;
  A1: string;
  A2: string;
  B1: string;
  organizationA: string;
}
interface OAuthFlow {
  oauthQuery: string;
  verifier: string;
  state: string;
}
const tokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

function post(app: Hono, path: string, body: unknown, cookie = ""): Promise<Response> {
  return Promise.resolve(
    app.request(origin + path, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function setup(adapter: string): Promise<NativeFixture> {
  const fixture = await createFixtureDatabase(adapter);
  cleanup.push(fixture.close);
  if (adapter === "PostgreSQL") {
    const schema = z
      .object({ name: z.string().regex(/^fixture_[a-f0-9]+$/) })
      .parse((await fixture.importStore.read({ sql: "select current_schema() as name", values: [] }))[0]).name;
    await fixture.importStore.commitImport(
      [
        {
          sql: "create function fixture_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$",
          values: [],
        },
      ],
      [],
    );
    for (const name of [
      "20260717090000_meetily-meetings.sql",
      "20260719130000_meetily-summary-only.sql",
      "20260719130001_add-meetily-raw-transcript.sql",
      "20260720103941_tenant-meetily-meetings.sql",
    ]) {
      const sql = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8")
        .replaceAll("public.", schema + ".")
        .replaceAll("system.update_updated_at()", "fixture_updated_at()");
      await fixture.importStore.commitImport([{ sql, values: [] }], []);
    }
  }
  const mail: AuthMail[] = [];
  const sendMail = async (message: AuthMail): Promise<void> => {
    mail.push(message);
  };
  const auth = createHumanAuth(
    { baseURL: origin, secret: "synthetic-native-oauth-secret-32-characters", trustedOrigins: [origin], sendMail },
    fixture.authDatabase,
  );
  const { app } = await createConnectApp({
    catalog: sentinelCatalog,
    providerLoader: new SentinelProviderLoader(),
    runtimeDatabase: fixture.database,
    transitFiles: new TransitFileService({
      rootDir: "/tmp/connections-native-fixture-files",
      publicOrigin: origin,
      ttlSeconds: 60,
      maxBytes: 1024,
    }),
    publicOrigin: origin,
    secretCodec: new PlainTextSecretCodec(),
    humanAuth: auth,
    authMailDelivery: sendMail,
  });
  const register = async (email: string): Promise<{ userId: string; cookie: string }> => {
    expect(
      (await post(app, "/api/identity/sign-up/email", { email, name: email.split("@")[0], password })).status,
    ).toBe(200);
    const delivered = mail.find((item) => item.to === email && item.subject === "Verify your Connections email");
    if (!delivered) throw new Error("Missing verification delivery.");
    expect((await app.request(delivered.text.replace("Verify your email: ", ""))).status).toBe(302);
    const signedIn = await post(app, "/api/identity/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);
    const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await signedIn.json()).user.id;
    return {
      userId,
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
  };
  const user = await register("operator@example.test");
  const owner = await register("owner@example.test");
  if (!fixture.database.identityMutations) throw new Error("Missing governance store.");
  const companies = new CompanyService(fixture.database.identityMutations);
  const A = await companies.createCompany(owner.userId, { name: "A", slug: "alpha", workspaceName: "A1" });
  const A2 = await companies.createWorkspace(owner.userId, {
    organizationId: A.organizationId,
    name: "A2",
    initialAdminId: owner.userId,
  });
  const B = await companies.createCompany(owner.userId, { name: "B", slug: "beta", workspaceName: "B1" });
  for (const company of [A, B])
    await fixture.database.identityMutations.commit(
      [
        {
          sql: "insert into organization_memberships(id,organization_id,user_id,role,created_at) values(?,?,?,'member',?)",
          values: [randomUUID(), company.organizationId, user.userId, new Date().toISOString()],
        },
      ],
      company.organizationId,
    );
  for (const [organizationId, workspaceId] of [
    [A.organizationId, A.workspaceId],
    [A.organizationId, A2.workspaceId],
    [B.organizationId, B.workspaceId],
  ])
    await companies.setWorkspaceGrant(owner.userId, {
      organizationId: organizationId ?? "",
      workspaceId: workspaceId ?? "",
      userId: user.userId,
      role: "member",
    });
  return {
    ...fixture,
    app,
    auth,
    userId: user.userId,
    cookie: user.cookie,
    otherCookie: owner.cookie,
    ownerId: owner.userId,
    companies,
    A1: A.workspaceId,
    A2: A2.workspaceId,
    B1: B.workspaceId,
    organizationA: A.organizationId,
  };
}

async function start(f: NativeFixture, scopes = "meetings:read meetings:write offline_access"): Promise<OAuthFlow> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: meetingsOAuthClientId,
    redirect_uri: meetingsOAuthRedirect,
    scope: scopes,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: origin + "/api/meetings",
    prompt: "consent",
  });
  const response = await f.app.request(origin + "/api/identity/oauth2/authorize?" + query, {
    headers: { cookie: f.cookie, accept: "text/html" },
  });
  expect(response.status, await response.clone().text()).toBe(302);
  const location = new URL(response.headers.get("location") ?? "", origin);
  expect(location.pathname).toBe("/desktop/connect");
  return { oauthQuery: location.search.slice(1), verifier, state };
}
async function code(f: NativeFixture, flow: OAuthFlow, workspaceId = f.A1): Promise<string> {
  const selected = await post(
    f.app,
    "/api/meetings-oauth/select",
    { oauthQuery: flow.oauthQuery, workspaceId },
    f.cookie,
  );
  expect(selected.status, await selected.clone().text()).toBe(200);
  const resumed = await post(f.app, "/api/meetings-oauth/continue", { oauthQuery: flow.oauthQuery }, f.cookie);
  expect(resumed.status, await resumed.clone().text()).toBe(200);
  const resumedUrl = z.object({ url: z.string() }).parse(await resumed.json()).url;
  const consent = await post(
    f.app,
    "/api/meetings-oauth/consent",
    { oauthQuery: new URL(resumedUrl, origin).search.slice(1), accept: true },
    f.cookie,
  );
  expect(consent.status, await consent.clone().text()).toBe(200);
  const callback = new URL(z.object({ url: z.string() }).parse(await consent.json()).url);
  expect(callback.origin + callback.pathname).toBe("null/callback");
  expect(callback.searchParams.get("state")).toBe(flow.state);
  expect(callback.searchParams.get("iss")).toBe(origin + "/api/identity");
  return z.string().min(1).parse(callback.searchParams.get("code"));
}
function exchange(
  f: NativeFixture,
  flow: OAuthFlow,
  authorizationCode: string,
  changes: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    f.app.request(origin + "/api/identity/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: meetingsOAuthClientId,
        redirect_uri: meetingsOAuthRedirect,
        code: authorizationCode,
        code_verifier: flow.verifier,
        resource: origin + "/api/meetings",
        ...changes,
      }).toString(),
    }),
  );
}
function refresh(f: NativeFixture, refreshToken: string, changes: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    f.app.request(origin + "/api/identity/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: meetingsOAuthClientId,
        refresh_token: refreshToken,
        resource: origin + "/api/meetings",
        ...changes,
      }).toString(),
    }),
  );
}
async function issued(f: NativeFixture, workspaceId = f.A1, scopes?: string): Promise<z.infer<typeof tokensSchema>> {
  const flow = await start(f, scopes);
  const response = await exchange(f, flow, await code(f, flow, workspaceId));
  expect(response.status, await response.clone().text()).toBe(200);
  return tokensSchema.parse(await response.json());
}

for (const adapter of ["SQLite", "D1", "PostgreSQL"])
  describe.skipIf(adapter === "PostgreSQL" && !process.env.CONNECTIONS_TEST_POSTGRES_URL)(
    adapter + " native Meetings issuer",
    () => {
      it("issues, refreshes and uploads through the real issuer without changing the consent workspace", async () => {
        const f = await setup(adapter);
        const tokens = await issued(f);
        expect(tokens.access_token).toMatch(/^cma_/);
        expect(tokens.refresh_token).toMatch(/^cmr_/);
        const headers = { authorization: "Bearer " + tokens.access_token };
        const identity = await f.app.request(origin + "/api/meetings-identity", { headers });
        expect(identity.status, await identity.clone().text()).toBe(200);
        expect(await identity.json()).toMatchObject({
          contract: "meetings-v1",
          userId: f.userId,
          workspaceId: f.A1,
          organizationId: f.organizationA,
        });
        const recording = {
          state: "final",
          revision: 1,
          title: "Offline A1 recording",
          transcript: "Original recording",
          transcriptSegments: [],
          workspaceId: f.B1,
          createdBy: f.ownerId,
        };
        const upload = await f.app.request(origin + "/api/meetings/queued-original", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(recording),
        });
        expect(upload.status, await upload.clone().text()).toBe(201);
        expect(await upload.json()).toMatchObject({ meeting: { workspaceId: f.A1, createdBy: f.userId } });
        expect(await f.database.meetingStore.get(f.B1, "queued-original")).toBeUndefined();
        const ownerTokens = await issued({ ...f, userId: f.ownerId, cookie: f.otherCookie });
        const ownerHeaders = { authorization: "Bearer " + ownerTokens.access_token };
        const reads = await f.app.request(origin + "/api/meetings", { headers: ownerHeaders });
        expect(reads.status).toBe(200);
        expect(await reads.json()).toMatchObject({ meetings: [{ createdBy: f.userId, workspaceId: f.A1 }] });
        expect(
          (
            await f.app.request(origin + "/api/meetings/queued-original", {
              method: "PUT",
              headers: { ...ownerHeaders, "content-type": "application/json" },
              body: JSON.stringify({ ...recording, revision: 2 }),
            })
          ).status,
        ).toBe(403);
        expect((await f.app.request(origin + "/api/meetings?workspaceId=" + f.B1, { headers })).status).toBe(403);
        expect(
          (await f.app.request(origin + "/api/meetings", { headers: { ...headers, "x-workspace-id": f.A2 } })).status,
        ).toBe(403);
        expect((await f.app.request(origin + "/api/connections", { headers })).status).toBe(401);
        expect((await f.app.request(origin + "/v1/health", { headers })).status).toBe(401);
        const rotated = await refresh(f, tokens.refresh_token);
        expect(rotated.status, await rotated.clone().text()).toBe(200);
        const next = tokensSchema.parse(await rotated.json());
        expect(next.refresh_token).not.toBe(tokens.refresh_token);
        expect(
          (
            await f.app.request(origin + "/api/meetings-identity", {
              headers: { authorization: "Bearer " + next.access_token },
            })
          ).status,
        ).toBe(200);
      });

      it("rejects insufficient scopes, alternate clients/resources and replayed code", async () => {
        const f = await setup(adapter);
        const flow = await start(f);
        const authorizationCode = await code(f, flow);
        expect(
          (await exchange(f, flow, authorizationCode, { code_verifier: randomBytes(32).toString("base64url") })).ok,
        ).toBe(false);
        expect((await exchange(f, flow, authorizationCode, { resource: origin + "/v1" })).ok).toBe(false);
        expect((await exchange(f, flow, authorizationCode, { client_id: "other-client" })).ok).toBe(false);
        const nextFlow = await start(f);
        const nextCode = await code(f, nextFlow);
        const valid = await exchange(f, nextFlow, nextCode);
        expect(valid.status, await valid.clone().text()).toBe(200);
        expect((await exchange(f, nextFlow, nextCode)).ok).toBe(false);
        const read = await issued(f, f.A1, "meetings:read offline_access");
        expect(
          (
            await f.app.request(origin + "/api/meetings/blocked-write", {
              method: "PUT",
              headers: { authorization: "Bearer " + read.access_token, "content-type": "application/json" },
              body: JSON.stringify({
                state: "final",
                revision: 1,
                title: "Blocked",
                transcript: "",
                transcriptSegments: [],
              }),
            })
          ).status,
        ).toBe(403);
        for (const secret of ["oct_synthetic", "eyJ.synthetic.idtoken", read.refresh_token])
          expect(
            (await f.app.request(origin + "/api/meetings", { headers: { authorization: "Bearer " + secret } })).ok,
          ).toBe(false);
        expect(await f.database.meetingStore.get(f.A1, "blocked-write")).toBeUndefined();
      });

      it("initializes concurrent restarts without duplicating clients or resources", async () => {
        const f = await setup(adapter);
        if (!f.database.identityDirectory || !f.database.identityMutations) throw new Error("Missing identity stores.");
        const service = new MeetingsOAuthService({
          auth: f.auth,
          origin,
          store: f.database.identityMutations,
          access: {
            directory: f.database.identityDirectory,
            workspaceStore: f.database.workspaceStore,
            membershipStore: f.database.membershipStore,
          },
        });
        await Promise.all([service.initialize(), service.initialize()]);
        for (const [table, count] of [
          ["auth_oauth_client", 2],
          ["auth_oauth_resource", 1],
          ["auth_oauth_client_resource", 2],
        ] as const) {
          const rows = await f.database.identityMutations.read({
            sql: `select count(*) as count from ${table}`,
            values: [],
          });
          expect(Number(rows[0]?.count)).toBe(count);
        }
        expect((await issued(f)).access_token).toMatch(/^cma_/);
      });

      it("publishes exact discovery and rejects expired consent and expired authorization codes", async () => {
        const f = await setup(adapter);
        const discovery = await f.app.request(origin + "/.well-known/oauth-authorization-server/api/identity");
        expect(discovery.status).toBe(200);
        expect(await discovery.json()).toMatchObject({
          issuer: origin + "/api/identity",
          authorization_endpoint: origin + "/api/identity/oauth2/authorize",
          token_endpoint: origin + "/api/identity/oauth2/token",
        });
        const flow = await start(f);
        const authorizationCode = await code(f, flow);
        await f.database.identityMutations?.commit([
          {
            sql: "update auth_verification set expires_at=?",
            values: [new Date(Date.now() - 1000).toISOString()],
          },
        ]);
        expect((await exchange(f, flow, authorizationCode)).ok).toBe(false);
        const pending = await start(f);
        await f.database.identityMutations?.commit([
          {
            sql: "update meetings_oauth_bindings set expires_at=? where workspace_id is null",
            values: [new Date(Date.now() - 1000).toISOString()],
          },
        ]);
        expect(
          (
            await post(
              f.app,
              "/api/meetings-oauth/select",
              { oauthQuery: pending.oauthQuery, workspaceId: f.A1 },
              f.cookie,
            )
          ).ok,
        ).toBe(false);
        const cancel = await start(f);
        const selected = await post(
          f.app,
          "/api/meetings-oauth/select",
          { oauthQuery: cancel.oauthQuery, workspaceId: f.A1 },
          f.cookie,
        );
        expect(selected.status).toBe(200);
        const resumed = await post(f.app, "/api/meetings-oauth/continue", { oauthQuery: cancel.oauthQuery }, f.cookie);
        const consentQuery = new URL(
          z.object({ url: z.string() }).parse(await resumed.json()).url,
          origin,
        ).search.slice(1);
        const declined = await post(
          f.app,
          "/api/meetings-oauth/consent",
          { oauthQuery: consentQuery, accept: false },
          f.cookie,
        );
        expect(declined.status, await declined.clone().text()).toBe(200);
        const callback = new URL(z.object({ url: z.string() }).parse(await declined.json()).url);
        expect(callback.searchParams.get("error")).toBe("access_denied");
        expect(callback.searchParams.get("code")).toBeNull();
      });

      it("uses one atomic code redemption and revokes raced or replayed grants", async () => {
        const f = await setup(adapter);
        const flow = await start(f);
        const authorizationCode = await code(f, flow);
        const results = await Promise.all([exchange(f, flow, authorizationCode), exchange(f, flow, authorizationCode)]);
        expect(results.filter((response) => response.ok).length).toBeLessThanOrEqual(1);
        expect(results.some((response) => !response.ok)).toBe(true);
        for (const response of results.filter((response) => response.ok)) {
          const tokens = tokensSchema.parse(await response.json());
          expect((await refresh(f, tokens.refresh_token)).ok).toBe(false);
          expect(
            (
              await f.app.request(origin + "/api/meetings", {
                headers: { authorization: "Bearer " + tokens.access_token },
              })
            ).ok,
          ).toBe(false);
        }
      });

      it("retries a lost rotation response, then revokes stale replay only in its original workspace", async () => {
        const f = await setup(adapter);
        const A = await issued(f);
        const B = await issued(f, f.B1);
        const responses = await Promise.all([refresh(f, A.refresh_token), refresh(f, A.refresh_token)]);
        const successful = responses.find((response) => response.ok);
        expect(successful).toBeDefined();
        if (!successful) throw new Error("Rotation failed.");
        const next = tokensSchema.parse(await successful.json());
        const retry = await refresh(f, A.refresh_token);
        expect(retry.status, await retry.clone().text()).toBe(200);
        expect(tokensSchema.parse(await retry.json())).toEqual(next);
        await f.database.identityMutations?.commit(
          [
            {
              sql: "update auth_oauth_refresh_token set rotated_at=?,rotation_replay_expires_at=? where reference_id in (select id from meetings_oauth_bindings where workspace_id=?) and rotated_at is not null",
              values: [new Date(Date.now() - 60000).toISOString(), new Date(Date.now() - 30000).toISOString(), f.A1],
            },
          ],
          f.organizationA,
        );
        expect((await refresh(f, A.refresh_token)).ok).toBe(false);
        expect((await refresh(f, next.refresh_token)).ok).toBe(false);
        expect((await refresh(f, B.refresh_token)).status).toBe(200);
      });

      it("rejects expired tokens and sessions, mixed credentials and malformed consent requests", async () => {
        const f = await setup(adapter);
        const tokens = await issued(f);
        expect(
          (
            await f.app.request(origin + "/api/meetings", {
              headers: { authorization: "Bearer " + tokens.access_token, cookie: f.cookie },
            })
          ).status,
        ).toBe(400);
        const malformed = await f.app.request(origin + "/api/meetings-oauth/select", {
          method: "POST",
          headers: { origin, cookie: f.cookie, "content-type": "application/json" },
          body: "{",
        });
        expect(malformed.status).toBe(400);
        await f.database.identityMutations?.commit(
          [
            {
              sql: "update auth_oauth_access_token set expires_at=? where reference_id in (select id from meetings_oauth_bindings where workspace_id=?)",
              values: [new Date(Date.now() - 1000).toISOString(), f.A1],
            },
          ],
          f.organizationA,
        );
        expect(
          (
            await f.app.request(origin + "/api/meetings", {
              headers: { authorization: "Bearer " + tokens.access_token },
            })
          ).ok,
        ).toBe(false);
        const current = tokensSchema.parse(await (await refresh(f, tokens.refresh_token)).json());
        await f.database.identityMutations?.commit(
          [
            {
              sql: "update auth_session set expires_at=? where user_id=?",
              values: [new Date(Date.now() - 1000).toISOString(), f.userId],
            },
          ],
          f.organizationA,
        );
        expect((await refresh(f, current.refresh_token)).ok).toBe(false);
        expect(
          (
            await f.app.request(origin + "/api/meetings", {
              headers: { authorization: "Bearer " + current.access_token },
            })
          ).ok,
        ).toBe(false);
      });

      it("uses live roles and denies archived or offboarded grants without reviving them", async () => {
        const f = await setup(adapter);
        const A = await issued(f);
        const B = await issued(f, f.B1);
        await f.companies.setWorkspaceGrant(f.ownerId, {
          organizationId: f.organizationA,
          workspaceId: f.A1,
          userId: f.userId,
          role: "manager",
        });
        expect(
          (await f.app.request(origin + "/api/meetings", { headers: { authorization: "Bearer " + A.access_token } }))
            .status,
        ).toBe(200);
        const now = new Date().toISOString();
        expect(
          await f.database.workspaceLifecycleStore?.archive(f.A1, now, new Date(Date.now() + 86400000).toISOString()),
        ).toBe(true);
        expect((await refresh(f, A.refresh_token)).ok).toBe(false);
        expect(await f.database.workspaceLifecycleStore?.restore(f.A1, now)).toBe(true);
        expect((await refresh(f, A.refresh_token)).ok).toBe(false);
        const fresh = await issued(f);
        await f.companies.removeOrganizationMember(f.ownerId, f.organizationA, f.userId);
        expect((await refresh(f, fresh.refresh_token)).ok).toBe(false);
        expect(
          (
            await f.app.request(origin + "/api/meetings", {
              headers: { authorization: "Bearer " + fresh.access_token },
            })
          ).ok,
        ).toBe(false);
        expect((await refresh(f, B.refresh_token)).status).toBe(200);
      });

      it("freezes selection and rejects another browser user or removed access at issuance", async () => {
        const f = await setup(adapter);
        const flow = await start(f);
        expect(
          (
            await post(
              f.app,
              "/api/meetings-oauth/select",
              { oauthQuery: flow.oauthQuery, workspaceId: f.A1 },
              f.otherCookie,
            )
          ).ok,
        ).toBe(false);
        const authorizationCode = await code(f, flow);
        expect(
          (
            await post(
              f.app,
              "/api/meetings-oauth/select",
              { oauthQuery: flow.oauthQuery, workspaceId: f.A2 },
              f.cookie,
            )
          ).ok,
        ).toBe(false);
        await f.companies.removeWorkspaceGrant(f.ownerId, f.organizationA, f.A1, f.userId);
        expect((await exchange(f, flow, authorizationCode)).ok).toBe(false);
        expect((await issued(f, f.B1)).access_token).toMatch(/^cma_/);
      });

      it("rejects removal during a streamed upload before any meeting or audit is persisted", async () => {
        const f = await setup(adapter);
        const tokens = await issued(f);
        let finishBody: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"state":"final",'));
            finishBody = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  '"revision":1,"title":"Delayed upload","transcript":"","transcriptSegments":[]}',
                ),
              );
              controller.close();
            };
          },
        });
        const pending = Promise.resolve(
          f.app.request(
            new Request(origin + "/api/meetings/delayed-original", {
              method: "PUT",
              headers: { authorization: "Bearer " + tokens.access_token, "content-type": "application/json" },
              body: stream,
              duplex: "half",
            } as RequestInit),
          ),
        );
        const deadline = Date.now() + 5000;
        while (!stream.locked && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(stream.locked).toBe(true);
        await f.companies.removeWorkspaceGrant(f.ownerId, f.organizationA, f.A1, f.userId);
        finishBody?.();
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(403);
        expect(await f.database.meetingStore.get(f.A1, "delayed-original")).toBeUndefined();
        expect(
          await f.database.identityMutations?.read({
            sql: "select id from audit_events where workspace_id=? and event in ('meeting.created','meeting.finalized')",
            values: [f.A1],
          }),
        ).toEqual([]);
      });

      it("keeps revoked or removed workspace grants denied after regrant while preserving B", async () => {
        const f = await setup(adapter);
        const A = await issued(f);
        const B = await issued(f, f.B1);
        await f.companies.removeWorkspaceGrant(f.ownerId, f.organizationA, f.A1, f.userId);
        await f.companies.setWorkspaceGrant(f.ownerId, {
          organizationId: f.organizationA,
          workspaceId: f.A1,
          userId: f.userId,
          role: "member",
        });
        expect((await refresh(f, A.refresh_token)).ok).toBe(false);
        expect(
          (await f.app.request(origin + "/api/meetings", { headers: { authorization: "Bearer " + A.access_token } }))
            .ok,
        ).toBe(false);
        expect((await refresh(f, B.refresh_token)).status).toBe(200);
        const response = await f.app.request(origin + "/api/identity/oauth2/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: meetingsOAuthClientId, token: B.refresh_token }).toString(),
        });
        expect(response.status).toBe(200);
        expect((await refresh(f, B.refresh_token)).ok).toBe(false);
      });
    },
  );

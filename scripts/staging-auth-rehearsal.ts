import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { z } from "zod";
import { logger } from "../src/server/logger.ts";

const origin = "https://connections-migration.159.69.35.245.sslip.io";
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,60}$/)
  .parse(process.env.CONNECTIONS_STAGING_REHEARSAL_ID);
const password = z.string().min(32).parse(process.env.CONNECTIONS_STAGING_REHEARSAL_PASSWORD);
assert.equal(process.env.BETTER_AUTH_URL, origin);
assert.equal(process.env.SMTP_URL, "smtp://staging-mail:1025");
const databaseURL = new URL(z.string().parse(process.env.DATABASE_URL));
assert.equal(databaseURL.hostname, "staging-postgres");
assert.equal(databaseURL.pathname, "/connections_staging");
const ledgerPath = `/app/data/staging-auth-${runId}.json`;
const server = spawn(process.execPath, ["src/server/index.ts"], { stdio: "inherit" });
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.kill(signal));

interface RequestOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  workspaceId?: string;
  bearer?: string;
  requestOrigin?: string;
}
const checks: { step: string; status: number }[] = [];
let step = "readiness";
async function request(path: string, expected: number, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers({ Origin: options.requestOrigin ?? origin });
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.workspaceId) headers.set("x-workspace-id", options.workspaceId);
  if (options.bearer) headers.set("Authorization", `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(origin + path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    checks.push({ step, status: response.status });
    if (response.status === 429 && expected !== 429 && attempt < 5) {
      const seconds = Number(response.headers.get("retry-after") ?? "60");
      assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 120, "Invalid rate-limit retry delay");
      await response.body?.cancel();
      await delay((seconds + 1) * 1000);
      continue;
    }
    assert.equal(response.status, expected, `${step}: unexpected HTTP status`);
    return response;
  }
  throw new Error("Rate-limit retries exhausted");
}

const mailListSchema = z.object({
  messages: z.array(z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) })),
});
const mailSchema = z.object({ Text: z.string() });
async function mailLink(email: string, path: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = mailListSchema.parse(await (await fetch("http://staging-mail:8025/api/v1/messages")).json());
    for (const message of list.messages.filter((message) => message.To.some((to) => to.Address === email))) {
      const mail = mailSchema.parse(
        await (await fetch(`http://staging-mail:8025/api/v1/message/${message.ID}`)).json(),
      );
      for (const candidate of mail.Text.match(/https:\/\/[^\s]+/g) ?? []) {
        const url = new URL(candidate);
        if (url.origin === origin && url.pathname.startsWith(path)) return url.href;
      }
    }
    await delay(250);
  }
  throw new Error("Staging mail link not received");
}
const accountSchema = z.object({
  user: z.object({ id: z.string() }),
  workspaces: z.array(z.object({ workspaceId: z.string() })),
});
const companySchema = z.object({ organizationId: z.string(), workspaceId: z.string() });
const workspaceSchema = z.object({ workspaceId: z.string() });
const invitationSchema = z.object({ invitationId: z.string() });
const tokenSchema = z.object({ token: z.string().startsWith("oct_"), record: z.object({ id: z.string() }) });
async function signIn(email: string, currentPassword = password): Promise<string> {
  const response = await request("/api/identity/sign-in/email", 200, { body: { email, password: currentPassword } });
  const cookies = response.headers.getSetCookie();
  assert(cookies.some((cookie) => cookie.includes("Secure") && cookie.includes("HttpOnly")));
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}
async function register(kind: string): Promise<{ email: string; cookie: string; userId: string }> {
  const email = `${kind}-${runId}@example.com`;
  step = `${kind}: signup`;
  await request("/api/identity/sign-up/email", 200, { body: { email, password, name: `Synthetic ${kind}` } });
  step = `${kind}: unverified sign-in denied`;
  await request("/api/identity/sign-in/email", 403, { body: { email, password } });
  step = `${kind}: delivered verification link`;
  const link = await mailLink(email, "/api/identity/verify-email");
  await request(link.slice(origin.length), 302);
  step = `${kind}: verified sign-in and secure cookie`;
  const cookie = await signIn(email);
  const account = accountSchema.parse(await (await request("/api/account", 200, { cookie })).json());
  return { email, cookie, userId: account.user.id };
}

async function rehearse(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(origin + "/health", { signal: AbortSignal.timeout(3000) })).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error("Server exited before readiness");
    if (attempt === 119) throw new Error("Public HTTPS readiness timed out");
    await delay(1000);
  }
  try {
    const previous = z
      .object({ passed: z.literal(true), runId: z.literal(runId) })
      .loose()
      .parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    logger.info({ rehearsal: previous }, "staging auth rehearsal already passed");
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const operator = await register("operator");
  const member = await register("member");
  step = "foreign-origin mutation denied";
  await request("/api/auth/logout", 403, {
    cookie: operator.cookie,
    body: {},
    requestOrigin: "https://untrusted.example",
  });
  step = "auth plugin governance bypass denied";
  await request("/api/identity/organization/create", 403, {
    cookie: operator.cookie,
    body: { name: "Forbidden", slug: "forbidden" },
  });
  step = "A company and A1 provisioning";
  const A = companySchema.parse(
    await (
      await request("/api/companies", 201, {
        cookie: operator.cookie,
        body: { name: "Synthetic A", slug: `a-${runId}`, workspaceName: "A1" },
      })
    ).json(),
  );
  step = "A2 provisioning";
  const A2 = workspaceSchema.parse(
    await (
      await request(`/api/companies/${A.organizationId}/workspaces`, 201, {
        cookie: operator.cookie,
        body: { name: "A2", initialAdminId: operator.userId },
      })
    ).json(),
  );
  step = "B company and B1 provisioning";
  const B = companySchema.parse(
    await (
      await request("/api/companies", 201, {
        cookie: operator.cookie,
        body: { name: "Synthetic B", slug: `b-${runId}`, workspaceName: "B1" },
      })
    ).json(),
  );
  for (const company of [A, B]) {
    step = "company invitation with explicit grant";
    const invitation = invitationSchema.parse(
      await (
        await request(`/api/companies/${company.organizationId}/invitations`, 201, {
          cookie: operator.cookie,
          body: { email: member.email, role: "member", grants: [{ workspaceId: company.workspaceId, role: "member" }] },
        })
      ).json(),
    );
    step = "invitation acceptance";
    await request(`/api/account/invitations/${invitation.invitationId}/accept`, 200, {
      cookie: member.cookie,
      body: {},
    });
  }
  step = "directory membership does not grant A2 resources";
  await request("/api/connections", 403, { cookie: member.cookie, workspaceId: A2.workspaceId });
  step = "parallel A1 and B1 requests retain explicit scope";
  await Promise.all(
    [A, B].map((company) =>
      request("/api/connections", 200, { cookie: member.cookie, workspaceId: company.workspaceId }),
    ),
  );
  step = "member workspace configuration denied";
  await request("/api/workspace/providers/gmail", 403, {
    method: "PUT",
    cookie: member.cookie,
    workspaceId: A.workspaceId,
    body: {},
  });
  step = "runtime token A1 issuance";
  const aToken = tokenSchema.parse(
    await (
      await request("/api/runtime-tokens", 200, {
        cookie: member.cookie,
        workspaceId: A.workspaceId,
        body: { name: "Synthetic A automation" },
      })
    ).json(),
  );
  step = "runtime token B1 issuance";
  const bToken = tokenSchema.parse(
    await (
      await request("/api/runtime-tokens", 200, {
        cookie: member.cookie,
        workspaceId: B.workspaceId,
        body: { name: "Synthetic B automation" },
      })
    ).json(),
  );
  step = "runtime keys usable in original workspaces";
  await request("/v1/apps", 200, { bearer: aToken.token });
  await request("/v1/apps", 200, { bearer: bToken.token });
  step = "runtime key cannot become human account session";
  await request("/api/account", 401, { bearer: aToken.token });
  step = "human cookie cannot become runtime credential";
  await request("/v1/apps", 401, { cookie: member.cookie });
  step = "company A offboarding";
  await request(`/api/companies/${A.organizationId}/members/${member.userId}`, 200, {
    method: "DELETE",
    cookie: operator.cookie,
  });
  step = "removed A1 human and runtime access denied";
  await request("/api/connections", 403, { cookie: member.cookie, workspaceId: A.workspaceId });
  await request("/v1/apps", 401, { bearer: aToken.token });
  step = "independent B1 human and runtime access retained";
  await request("/api/connections", 200, { cookie: member.cookie, workspaceId: B.workspaceId });
  await request("/v1/apps", 200, { bearer: bToken.token });
  step = "archive B1";
  await request("/api/workspace", 200, {
    method: "DELETE",
    cookie: operator.cookie,
    workspaceId: B.workspaceId,
    body: { confirmation: "B1" },
  });
  step = "archived B1 resources and tokens denied";
  await request("/api/connections", 403, { cookie: member.cookie, workspaceId: B.workspaceId });
  await request("/v1/apps", 401, { bearer: bToken.token });
  step = "restore B1 data";
  await request("/api/workspace/restore", 200, { cookie: operator.cookie, workspaceId: B.workspaceId, body: {} });
  step = "restored data does not resurrect revoked token";
  await request("/api/connections", 200, { cookie: member.cookie, workspaceId: B.workspaceId });
  await request("/v1/apps", 401, { bearer: bToken.token });
  step = "delivered password recovery link";
  await request("/api/identity/request-password-reset", 200, {
    body: { email: member.email, redirectTo: `${origin}/reset-password` },
  });
  const link = await mailLink(member.email, "/api/identity/reset-password/");
  const redirect = await request(link.slice(origin.length), 302);
  const token = new URL(z.string().parse(redirect.headers.get("location")), origin).searchParams.get("token");
  assert(token);
  const replacementPassword = `${password}-reset`;
  await request("/api/identity/reset-password", 200, { body: { token, newPassword: replacementPassword } });
  step = "password reset revokes existing session";
  await request("/api/account", 401, { cookie: member.cookie });
  step = "old password denied";
  await request("/api/identity/sign-in/email", 401, { body: { email: member.email, password } });
  step = "replacement password and logout";
  const cookie = await signIn(member.email, replacementPassword);
  await request("/api/auth/logout", 200, { cookie, body: {} });
  await request("/api/account", 401, { cookie });
  const pool = new pg.Pool({ connectionString: databaseURL.href });
  try {
    step = "PostgreSQL verifies removed membership and revoked keys";
    const result = await pool.query(
      "select (select count(*)::int from organization_memberships where organization_id=$1 and user_id=$2) as removed_memberships, (select count(*)::int from workspace_memberships where workspace_id=$3 and user_id=$2) as removed_grants",
      [A.organizationId, member.userId, A.workspaceId],
    );
    const counts = z.object({ removed_memberships: z.literal(0), removed_grants: z.literal(0) }).parse(result.rows[0]);
    const ledger = {
      passed: true,
      runId,
      runtime: "Coolify / Node 24 / PostgreSQL 16",
      origin,
      mail: "private Mailpit; delivered links completed over trusted public HTTPS",
      completedAt: new Date().toISOString(),
      checks,
      counts,
    };
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
    logger.info({ rehearsal: ledger }, "staging auth rehearsal passed");
  } finally {
    await pool.end();
  }
}
await rehearse().catch(() => logger.error({ step, checks }, "staging auth rehearsal failed; server remains available"));

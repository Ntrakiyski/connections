import type { Hono } from "hono";
import type { ChildProcess } from "node:child_process";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { z } from "zod";
import { loadCatalog } from "../src/catalog-store.ts";
import { ActionPolicyService } from "../src/core/action-policy.ts";
import { ProviderLoader } from "../src/providers/provider-loader.ts";
import { executableActionIds, executorModules } from "../src/providers/registry.generated.ts";
import { readDeploymentAuthSettings } from "../src/server/auth-config.ts";
import { createAuthMailDelivery } from "../src/server/auth-mail.ts";
import { createConnectApp } from "../src/server/connect-app.ts";
import { TransitFileService } from "../src/server/files/transit-files.ts";
import { createHumanAuth } from "../src/server/human-auth.ts";
import { createSecretCodec } from "../src/server/secrets/secret-codec.ts";
import { PostgresRuntimeDatabase } from "../src/server/storage/postgres-runtime-store.ts";

const execute = promisify(execFile);
const origin = "https://connections-migration.159.69.35.245.sslip.io";
export interface RecoverySnapshot {
  root: string;
  dumpSHA256: string;
  filesSHA256: string;
}

function target(): URL {
  const url = new URL(z.string().parse(process.env.DATABASE_URL));
  assert.equal(url.hostname, "staging-postgres");
  assert.equal(url.pathname, "/connections_staging");
  assert.equal(process.env.BETTER_AUTH_URL, origin);
  return url;
}
function postgresEnvironment(url: URL): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
  };
}

/** Freezes the sole staging application writer; backs up only its isolated database and transit files. */
export async function takeRecoverySnapshot(runId: string, server: ChildProcess): Promise<RecoverySnapshot> {
  z.string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .parse(runId);
  const url = target();
  const root = `/app/data/recovery-${runId}`;
  await mkdir(root, { mode: 0o700 });
  assert(server.kill("SIGSTOP"), "Could not freeze the staging writer");
  try {
    await execute("pg_dump", ["--format=custom", "--file", `${root}/database.dump`], {
      env: postgresEnvironment(url),
      timeout: 30000,
    });
    await execute("tar", ["-czf", `${root}/files.tar.gz`, "-C", "/app/data/files", "."], { timeout: 30000 });
    await chmod(`${root}/database.dump`, 0o600);
    await chmod(`${root}/files.tar.gz`, 0o600);
  } finally {
    assert(server.kill("SIGCONT"), "Could not resume the staging writer");
  }
  return {
    root,
    dumpSHA256: createHash("sha256")
      .update(await readFile(`${root}/database.dump`))
      .digest("hex"),
    filesSHA256: createHash("sha256")
      .update(await readFile(`${root}/files.tar.gz`))
      .digest("hex"),
  };
}

export interface RecoveryOptions {
  snapshot: RecoverySnapshot;
  runId: string;
  operatorCookie: string;
  memberCookie: string;
  memberId: string;
  companyA: string;
  workspaceA: string;
  workspaceB: string;
  tokenA: string;
  tokenB: string;
  fileId: string;
  fileText: string;
}

/** Restores separately, proves the snapshot boundary, then reconciles the known security delta through Hono. */
export async function rehearseRecovery(
  options: RecoveryOptions,
): Promise<{ passed: true; dumpSHA256: string; filesSHA256: string; requests: number; reconciledMutations: string[] }> {
  const source = target();
  z.string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .parse(options.runId);
  const name = `connections_recovery_${options.runId.replaceAll("-", "_")}`;
  const admin = new pg.Pool({ connectionString: source.href });
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(source);
  url.pathname = `/${name}`;
  await execute("pg_restore", ["--exit-on-error", "--dbname", name, `${options.snapshot.root}/database.dump`], {
    env: postgresEnvironment(url),
    timeout: 30000,
  });
  const filesRoot = `${options.snapshot.root}/restored-files`;
  await mkdir(filesRoot, { mode: 0o700 });
  await execute("tar", ["-xzf", `${options.snapshot.root}/files.tar.gz`, "-C", filesRoot], { timeout: 30000 });
  const settings = readDeploymentAuthSettings(process.env);
  assert.equal(settings.kind, "sessions");
  if (settings.kind !== "sessions") throw new Error("Recovery requires human authentication");
  const codec = createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY);
  const database = new PostgresRuntimeDatabase(new pg.Pool({ connectionString: url.href }), codec);
  let requests = 0;
  async function request(
    app: Hono,
    path: string,
    status: number,
    headers: Record<string, string>,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const response = await app.request(origin + path, {
      method,
      headers: { ...headers, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    requests++;
    assert.equal(response.status, status, "Recovery Hono authorization mismatch");
    return response;
  }
  try {
    const sendMail = createAuthMailDelivery(settings);
    const { app } = await createConnectApp({
      catalog: await loadCatalog(undefined, { executableActionIds: Object.values(executableActionIds).flat() }),
      providerLoader: new ProviderLoader(executorModules),
      runtimeDatabase: database,
      transitFiles: new TransitFileService({
        rootDir: filesRoot,
        publicOrigin: origin,
        ttlSeconds: 86400,
        maxBytes: 104857600,
      }),
      publicOrigin: origin,
      secretCodec: codec,
      authMailDelivery: sendMail,
      humanAuth: createHumanAuth(
        { baseURL: origin, secret: settings.secret, trustedOrigins: settings.trustedOrigins, sendMail },
        database.authDatabase,
      ),
      trustedAuthOrigins: settings.trustedOrigins,
      actionPolicy: new ActionPolicyService({}),
    });
    const aHuman = { Cookie: options.memberCookie, "x-workspace-id": options.workspaceA };
    const bHuman = { Cookie: options.memberCookie, "x-workspace-id": options.workspaceB };
    const aRuntime = { Authorization: `Bearer ${options.tokenA}` };
    const bRuntime = { Authorization: `Bearer ${options.tokenB}` };
    await request(app, "/api/connections", 200, aHuman);
    await request(app, "/api/connections", 200, bHuman);
    await request(app, "/v1/apps", 200, aRuntime);
    await request(app, "/v1/apps", 200, bRuntime);
    const file = await request(app, `/api/files/${options.fileId}`, 200, aHuman);
    assert.equal(await file.text(), options.fileText);
    await request(app, `/api/files/${options.fileId}`, 404, bHuman);
    await request(
      app,
      `/api/companies/${options.companyA}/members/${options.memberId}`,
      200,
      { Cookie: options.operatorCookie },
      "DELETE",
    );
    const operatorB = { Cookie: options.operatorCookie, "x-workspace-id": options.workspaceB };
    await request(app, "/api/workspace", 200, operatorB, "DELETE", { confirmation: "B1" });
    await request(app, "/api/workspace/restore", 200, operatorB, "POST", {});
    await request(app, "/api/connections", 403, aHuman);
    await request(app, "/v1/apps", 401, aRuntime);
    await request(app, "/api/connections", 200, bHuman);
    await request(app, "/v1/apps", 401, bRuntime);
    return {
      passed: true,
      dumpSHA256: options.snapshot.dumpSHA256,
      filesSHA256: options.snapshot.filesSHA256,
      requests,
      reconciledMutations: ["company A offboarding", "B1 archive", "B1 restore without revoked-token resurrection"],
    };
  } finally {
    await database.close();
  }
}

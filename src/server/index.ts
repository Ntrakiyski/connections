import { serve } from "@hono/node-server";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadCatalog } from "../catalog-store.ts";
import { ActionPolicyService, parseActionPolicyList } from "../core/action-policy.ts";
import { parsePrivateNetworkAccessFlag, setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executableActionIds, executorModules } from "../providers/registry.generated.ts";
import { registerStaticRoutes } from "./api/static-routes.ts";
import { createConnectApp } from "./connect-app.ts";
import { TransitFileService } from "./files/transit-files.ts";
import { logger } from "./logger.ts";
import { createSecretCodec } from "./secrets/secret-codec.ts";
import { normalizePostgresConnectionString } from "./storage/postgres-config.ts";
import { PostgresRuntimeDatabase } from "./storage/postgres-runtime-store.ts";
import { SqliteRuntimeDatabase } from "./storage/sqlite-runtime-store.ts";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const publicOrigin = process.env.OOMOL_CONNECT_ORIGIN ?? `http://localhost:${port}`;
const dataDir = process.env.OOMOL_CONNECT_DATA_DIR ?? join(process.cwd(), "data");
const transitFileTtlSeconds = readPositiveIntegerEnv("OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS", 86_400);
const transitFileMaxBytes = readPositiveIntegerEnv("OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES", 100 * 1024 * 1024);
const secretCodec = createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY);
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const clerkOptional = !clerkSecretKey;
const actionPolicy = new ActionPolicyService({
  allowedActions: parseActionPolicyList(process.env.OOMOL_CONNECT_ALLOWED_ACTIONS),
  blockedActions: parseActionPolicyList(process.env.OOMOL_CONNECT_BLOCKED_ACTIONS),
  allowedProxies: parseActionPolicyList(process.env.OOMOL_CONNECT_ALLOWED_PROXIES),
  blockedProxies: parseActionPolicyList(process.env.OOMOL_CONNECT_BLOCKED_PROXIES),
});
setPrivateNetworkAccessAllowed(parsePrivateNetworkAccessFlag(process.env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK));
const builtRoot = join(process.cwd(), "dist/web");
const staticRoot = await resolveStaticRoot(builtRoot);
await mkdir(dataDir, { recursive: true });
const catalog = await loadCatalog(undefined, {
  executableActionIds: Object.values(executableActionIds).flat(),
});
const providerLoader = new ProviderLoader(executorModules);
const runtimeDatabase = process.env.DATABASE_URL
  ? new PostgresRuntimeDatabase(
      new pg.Pool({ connectionString: normalizePostgresConnectionString(process.env.DATABASE_URL) }),
      secretCodec,
    )
  : new SqliteRuntimeDatabase(join(dataDir, "connect.sqlite"), { secretCodec });
const transitFiles = new TransitFileService({
  rootDir: join(dataDir, "files"),
  publicOrigin,
  ttlSeconds: transitFileTtlSeconds,
  maxBytes: transitFileMaxBytes,
});
await transitFiles.cleanupExpired();
const { app, runtimeAuthConfigured } = await createConnectApp({
  catalog,
  providerLoader,
  runtimeDatabase,
  transitFiles,
  publicOrigin,
  secretCodec,
  clerkSecretKey,
  clerkPublishableKey,
  clerkOptional,
  actionPolicy,
  registerStaticRoutes: (app) => registerStaticRoutes(app, staticRoot),
  logger,
});

process.once("SIGINT", () => {
  void runtimeDatabase.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  void runtimeDatabase.close();
  process.exit(0);
});

serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    logger.info({ url: `http://${hostname}:${info.port}` }, "connect server listening");
    logger.info({ dataDir }, "runtime data directory");
    if (clerkOptional) {
      logger.warn("Clerk authentication is disabled; running in local dev mode.");
    }
    if (!runtimeAuthConfigured) {
      logger.warn("runtime API authentication is disabled; create a runtime token in the web console.");
    }
    if (!secretCodec.encrypted) {
      logger.warn(
        "local credential encryption is disabled; set OOMOL_CONNECT_ENCRYPTION_KEY to encrypt stored credentials",
      );
    }
    if (!staticRoot) {
      logger.warn("web console assets are not built; use http://localhost:5173 for local console development");
    }
  },
);

async function resolveStaticRoot(root: string): Promise<string | undefined> {
  try {
    await access(join(root, "index.html"));
    return root;
  } catch {
    return undefined;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

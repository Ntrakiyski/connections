import type { CatalogStore } from "../catalog-store.ts";
import type { DeploymentAuthSettings } from "./auth-config.ts";
import type { AssetsBinding, KVNamespaceBinding, R2BucketBinding } from "./cloudflare/cloudflare-bindings.ts";
import type { CloudflareEnv } from "./cloudflare/cloudflare-env.ts";
import type { ConnectApp } from "./connect-app.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";

import { ActionPolicyService, parseActionPolicyList } from "../core/action-policy.ts";
import { parsePrivateNetworkAccessFlag, setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executableActionIds, executorModules } from "../providers/registry.cloudflare.generated.ts";
import { isConsoleShellPath } from "./api/console-paths.ts";
import { readDeploymentAuthSettings } from "./auth-config.ts";
import { createAuthMailDelivery } from "./auth-mail.ts";
import { loadCatalogFromAssets } from "./cloudflare/catalog-assets.ts";
import { readPositiveInteger, resolvePublicOrigin } from "./cloudflare/cloudflare-env.ts";
import { createD1AuthDatabase } from "./cloudflare/d1-auth-database.ts";
import { createConnectApp } from "./connect-app.ts";
import { KVTransitFileService } from "./files/kv-transit-files.ts";
import { R2TransitFileService } from "./files/r2-transit-files.ts";
import { createHumanAuth } from "./human-auth.ts";
import { createWorkerSecretCodec } from "./secrets/worker-secret-codec.ts";
import { D1RuntimeDatabase } from "./storage/d1-runtime-store.ts";

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

let catalogPromise: Promise<CatalogStore> | undefined;
let cachedSecretCodec: { key: string; codec: Promise<ISecretCodec> } | undefined;
let cachedApp: { key: string; env: CloudflareEnv; app: Promise<ConnectApp> } | undefined;

export default {
  async fetch(request: Request, env: CloudflareEnv, _ctx: CloudflareExecutionContext): Promise<Response> {
    setPrivateNetworkAccessAllowed(parsePrivateNetworkAccessFlag(env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK));
    const publicOrigin = resolvePublicOrigin(request, env);
    const settings = readWorkerAuthSettings(env, publicOrigin);
    if (
      settings.kind === "development-bypass" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
    )
      throw new Error("Worker development authentication bypass requires a loopback request URL.");
    const cacheKey = createCacheKey(env, publicOrigin);
    if (
      !cachedApp ||
      cachedApp.key !== cacheKey ||
      cachedApp.env.DB !== env.DB ||
      cachedApp.env.TRANSIT_FILES !== env.TRANSIT_FILES ||
      cachedApp.env.ASSETS !== env.ASSETS
    ) {
      cachedApp = { key: cacheKey, env, app: createCloudflareApp(env, publicOrigin) };
    }

    const { app } = await cachedApp.app;
    const response = await app.fetch(request, env);
    if (response.status === 404 && env.ASSETS && shouldServeAsset(request)) {
      return env.ASSETS.fetch(request);
    }

    return response;
  },
};

async function createCloudflareApp(env: CloudflareEnv, publicOrigin: string): Promise<ConnectApp> {
  const authSettings = readWorkerAuthSettings(env, publicOrigin);
  const assets = env.ASSETS;
  if (!assets) {
    throw new Error("Cloudflare ASSETS binding is required to load the catalog");
  }
  const secretCodec = await createSecretCodec(env.OOMOL_CONNECT_ENCRYPTION_KEY);
  const database = new D1RuntimeDatabase(env.DB, { secretCodec });
  const authMailDelivery = authSettings.kind === "sessions" ? createAuthMailDelivery(authSettings) : undefined;
  const humanAuth =
    authMailDelivery && authSettings.kind === "sessions"
      ? createHumanAuth(
          {
            baseURL: authSettings.baseURL,
            secret: authSettings.secret,
            trustedOrigins: authSettings.trustedOrigins,
            sendMail: authMailDelivery,
          },
          createD1AuthDatabase(env.DB),
        )
      : undefined;
  // OAuth resource initialization performs D1 I/O. Finish it in the current
  // request before caching auth, so a completed health request cannot strand it.
  if (humanAuth) await humanAuth.$context;
  return await createConnectApp({
    catalog: await loadCatalogOnce(assets),
    providerLoader: new ProviderLoader(executorModules),
    runtimeDatabase: database,
    transitFiles: (() => {
      const transitFileOptions = {
        publicOrigin,
        ttlSeconds: readPositiveInteger(env.OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS, 86_400),
        maxBytes: readPositiveInteger(env.OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES, 100 * 1024 * 1024),
      };
      return env.TRANSIT_FILES_BACKEND === "kv"
        ? new KVTransitFileService({
            namespace: env.TRANSIT_FILES as KVNamespaceBinding,
            ...transitFileOptions,
          })
        : new R2TransitFileService({
            bucket: env.TRANSIT_FILES as R2BucketBinding,
            ...transitFileOptions,
          });
    })(),
    publicOrigin,
    secretCodec,
    authMailDelivery,
    humanAuth,
    trustedAuthOrigins: authSettings.kind === "sessions" ? authSettings.trustedOrigins : undefined,
    clerkOptional: authSettings.kind === "development-bypass",
    actionPolicy: new ActionPolicyService({
      allowedActions: parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_ACTIONS),
      blockedActions: parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_ACTIONS),
      allowedProxies: parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_PROXIES),
      blockedProxies: parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_PROXIES),
    }),
    logger: workerLogger,
    computeRuntimeAuthConfigured: false,
  });
}

function readWorkerAuthSettings(env: CloudflareEnv, publicOrigin: string): DeploymentAuthSettings {
  return readDeploymentAuthSettings(
    {
      NODE_ENV: env.NODE_ENV,
      HOST: env.HOST,
      CONNECTIONS_DEV_AUTH_BYPASS: env.CONNECTIONS_DEV_AUTH_BYPASS,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      BETTER_AUTH_TRUSTED_ORIGINS: env.BETTER_AUTH_TRUSTED_ORIGINS,
      OOMOL_CONNECT_ORIGIN: publicOrigin,
      OOMOL_CONNECT_ENCRYPTION_KEY: env.OOMOL_CONNECT_ENCRYPTION_KEY,
      SMTP_URL: env.SMTP_URL,
      SMTP_FROM: env.SMTP_FROM,
    },
    "worker",
  );
}

const workerLogger = {
  error: writeWorkerLog("error"),
  info: writeWorkerLog("info"),
  warn: writeWorkerLog("warn"),
} as unknown as Logger;

function writeWorkerLog(level: "error" | "info" | "warn"): (fields: unknown, message?: string) => void {
  return (fields, message) => {
    const write = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    if (message) {
      write(message, fields);
      return;
    }

    write(fields);
  };
}

function loadCatalogOnce(assets: AssetsBinding): Promise<CatalogStore> {
  catalogPromise ??= loadCatalogFromAssets(assets, {
    executableActionIds: Object.values(executableActionIds).flat(),
  });
  return catalogPromise;
}

function createSecretCodec(encryptionKey: string | undefined): Promise<ISecretCodec> {
  const key = encryptionKey ?? "";
  if (!cachedSecretCodec || cachedSecretCodec.key !== key) {
    cachedSecretCodec = { key, codec: createWorkerSecretCodec(encryptionKey) };
  }
  return cachedSecretCodec.codec;
}

function createCacheKey(env: CloudflareEnv, publicOrigin: string): string {
  return JSON.stringify({
    publicOrigin,
    authSecret: env.BETTER_AUTH_SECRET ?? "",
    authURL: env.BETTER_AUTH_URL ?? "",
    trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS ?? "",
    smtpURL: env.SMTP_URL ?? "",
    smtpFrom: env.SMTP_FROM ?? "",
    nodeEnv: env.NODE_ENV ?? "",
    hostname: env.HOST ?? "",
    developmentBypass: env.CONNECTIONS_DEV_AUTH_BYPASS ?? "",
    clerkSecretKey: env.CLERK_SECRET_KEY ?? "",
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? "",
    meetingsOAuthClientId: env.CLERK_MEETINGLY_OAUTH_CLIENT_ID ?? "",
    encryptionKey: env.OOMOL_CONNECT_ENCRYPTION_KEY ?? "",
    allowedActions: env.OOMOL_CONNECT_ALLOWED_ACTIONS ?? "",
    blockedActions: env.OOMOL_CONNECT_BLOCKED_ACTIONS ?? "",
    allowedProxies: env.OOMOL_CONNECT_ALLOWED_PROXIES ?? "",
    blockedProxies: env.OOMOL_CONNECT_BLOCKED_PROXIES ?? "",
    transitFileTtlSeconds: env.OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS ?? "",
    transitFileMaxBytes: env.OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES ?? "",
  });
}

function shouldServeAsset(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return !pathname.startsWith("/catalog") && isConsoleShellPath(pathname);
}

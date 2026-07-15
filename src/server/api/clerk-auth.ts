import type { IWorkspaceMembershipStore, IWorkspaceStore } from "../storage/runtime-database.ts";
import type { WorkspaceContext } from "../storage/runtime-token-service.ts";
import type { Context, MiddlewareHandler } from "hono";

import { getCookie } from "hono/cookie";
import { isConsoleShellRequest } from "./console-paths.ts";
import { HttpRequestError } from "./http-utils.ts";

export interface ClerkAuthSession extends WorkspaceContext {
  sessionClaims: Record<string, unknown>;
}

export interface ClerkAuthOptions {
  /** Clerk secret key from CLERK_SECRET_KEY. */
  secretKey?: string;
  /** Clerk publishable key from CLERK_PUBLISHABLE_KEY. */
  publishableKey?: string;
  /** Allows the single-user local development fallback. */
  optional?: boolean;
  workspaceStore?: IWorkspaceStore;
  membershipStore?: IWorkspaceMembershipStore;
}

declare module "hono" {
  interface ContextVariableMap {
    clerkSession: ClerkAuthSession;
    workspace: WorkspaceContext;
  }
}

const localWorkspace: WorkspaceContext = {
  workspaceId: "default",
  userId: "local-dev",
  role: "admin",
};

interface ClerkBackendModule {
  verifyToken(token: string, options: { secretKey: string }): Promise<Record<string, unknown>>;
}

/**
 * Verifies human Clerk sessions and resolves the Connections workspace role.
 */
export function createClerkAuthMiddleware(options: ClerkAuthOptions): MiddlewareHandler {
  if (options.optional || !options.secretKey) {
    return async (context, next) => {
      context.set("workspace", localWorkspace);
      context.set("clerkSession", { ...localWorkspace, sessionClaims: {} });
      await next();
    };
  }

  if (!options.workspaceStore || !options.membershipStore) {
    throw new Error("Clerk authentication requires workspace and membership stores.");
  }

  return async (context, next) => {
    if (isPublicPath(context.req.path, context.req.method)) {
      if (context.req.path === "/api/auth/session" && readSessionToken(context)) {
        await authenticateClerkRequest(context, options);
      }
      await next();
      return;
    }

    // Runtime tokens are verified by the dedicated middleware after this one.
    if (isRuntimePath(context.req.path) && readBearerToken(context)?.startsWith("oct_")) {
      await next();
      return;
    }

    await authenticateClerkRequest(context, options);
    await next();
  };
}

export function getClerkAuthSession(context: Context): ClerkAuthSession | undefined {
  return context.get("clerkSession");
}

async function authenticateClerkRequest(context: Context, options: ClerkAuthOptions): Promise<void> {
  const token = readSessionToken(context);
  if (!token || !options.secretKey || !options.workspaceStore || !options.membershipStore) {
    throw new HttpRequestError("unauthorized", "A valid Clerk session is required.", 401);
  }
  const stores = { workspaceStore: options.workspaceStore, membershipStore: options.membershipStore };

  let claims: Record<string, unknown>;
  try {
    claims = await verifyClerkToken(token, options.secretKey);
  } catch {
    throw new HttpRequestError("unauthorized", "A valid Clerk session is required.", 401);
  }

  const userId = readClaim(claims, "sub");
  const clerkOrgId = readClaim(claims, "org_id");
  if (!userId || !clerkOrgId) {
    throw new HttpRequestError("workspace_required", "An active Clerk Organization is required.", 403);
  }

  const workspace = await findOrCreateWorkspace(stores, claims, clerkOrgId, userId);

  const role = (await options.membershipStore.getRole(workspace.id, userId)) ?? "member";
  const workspaceContext = { workspaceId: workspace.id, userId, role };
  context.set("workspace", workspaceContext);
  context.set("clerkSession", { ...workspaceContext, sessionClaims: claims });
}

async function findOrCreateWorkspace(
  options: Required<Pick<ClerkAuthOptions, "workspaceStore" | "membershipStore">>,
  claims: Record<string, unknown>,
  clerkOrgId: string,
  userId: string,
): Promise<{ id: string }> {
  const existing = await options.workspaceStore.getByClerkOrgId(clerkOrgId);
  if (existing) {
    return existing;
  }

  if (claims.org_role !== "org:admin") {
    throw new HttpRequestError("workspace_not_found", "The active workspace has not been configured.", 403);
  }

  const now = new Date().toISOString();
  const workspace = {
    id: crypto.randomUUID(),
    clerkOrgId,
    name: readClaim(claims, "org_name") ?? clerkOrgId,
    createdAt: now,
    updatedAt: now,
  };
  await options.workspaceStore.create(workspace);
  await options.membershipStore.setRole(workspace.id, userId, "admin");
  return workspace;
}

async function verifyClerkToken(token: string, secretKey: string): Promise<Record<string, unknown>> {
  // Keep the dependency lazy so local development does not require Clerk to be installed or configured.
  const packageName = "@clerk/backend";
  const clerk = (await import(packageName)) as ClerkBackendModule;
  return await clerk.verifyToken(token, { secretKey });
}

function isPublicPath(path: string, method: string): boolean {
  return (
    path === "/health" ||
    path === "/oauth/callback" ||
    path.startsWith("/oauth/callback/") ||
    (method === "GET" && path === "/api/auth/session") ||
    (method === "POST" && path === "/api/auth/logout") ||
    (method === "GET" && path.startsWith("/api/files/")) ||
    isConsoleShellRequest(path, method)
  );
}

function isRuntimePath(path: string): boolean {
  return path.startsWith("/v1/") || path.startsWith("/mcp");
}

function readSessionToken(context: Context): string | undefined {
  return readBearerToken(context) ?? getCookie(context, "__session");
}

function readBearerToken(context: Context): string | undefined {
  const authorization = context.req.header("authorization") ?? "";
  const prefix = "Bearer ";
  const token = authorization.startsWith(prefix) ? authorization.slice(prefix.length).trim() : "";
  return token || undefined;
}

function readClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value ? value : undefined;
}

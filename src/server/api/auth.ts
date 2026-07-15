import type { IWorkspaceMembershipStore } from "../storage/runtime-database.ts";
import type { RuntimeTokenService, WorkspaceContext } from "../storage/runtime-token-service.ts";
import type { Context, MiddlewareHandler } from "hono";

import { jsonError } from "./http-utils.ts";

export const workspaceContextVar = "workspaceContext";

export interface WorkspaceAuthOptions {
  adminToken?: string;
  runtimeToken?: string;
  tokenService?: RuntimeTokenService;
  memberships?: IWorkspaceMembershipStore;
  syntheticWorkspaceId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    workspaceContext: WorkspaceContext;
  }
}

/**
 * Resolves a bearer token to the workspace boundary used by API and MCP routes.
 */
export function createWorkspaceAuthMiddleware(options: WorkspaceAuthOptions): MiddlewareHandler {
  const adminToken = normalizeToken(options.adminToken);
  const runtimeToken = normalizeToken(options.runtimeToken);
  const workspaceId = options.syntheticWorkspaceId ?? "default";

  return async (context, next) => {
    const workspace = await resolveWorkspaceContext(context, {
      ...options,
      adminToken,
      runtimeToken,
      syntheticWorkspaceId: workspaceId,
    });
    if (!workspace) {
      return jsonError(context, 401, "unauthorized", "A valid bearer token is required.");
    }

    context.set(workspaceContextVar, workspace);
    await next();
  };
}

export function getWorkspaceContext(context: Context): WorkspaceContext | undefined {
  return context.get(workspaceContextVar);
}

export function requireWorkspaceContext(context: Context): WorkspaceContext {
  const workspace = getWorkspaceContext(context);
  if (!workspace) {
    throw new Error("Workspace context not set — workspace authentication middleware not applied.");
  }
  return workspace;
}

interface ResolvedWorkspaceAuthOptions extends WorkspaceAuthOptions {
  adminToken?: string;
  runtimeToken?: string;
  syntheticWorkspaceId: string;
}

async function resolveWorkspaceContext(
  context: Context,
  options: ResolvedWorkspaceAuthOptions,
): Promise<WorkspaceContext | undefined> {
  if (!options.adminToken && !options.runtimeToken && !options.tokenService) {
    return syntheticWorkspaceContext(options.syntheticWorkspaceId, "admin");
  }

  const token = readBearerToken(context);
  if (!token) {
    return undefined;
  }
  if (token === options.adminToken) {
    return syntheticWorkspaceContext(options.syntheticWorkspaceId, "admin");
  }
  if (token === options.runtimeToken) {
    return syntheticWorkspaceContext(options.syntheticWorkspaceId, "runtime");
  }
  if (!options.tokenService || !options.memberships) {
    return undefined;
  }

  const runtime = await options.tokenService.verifyToken(token);
  if (!runtime) {
    return undefined;
  }
  const role = await options.memberships.getRole(runtime.workspaceId, runtime.userId);
  return role ? { ...runtime, role } : undefined;
}

function syntheticWorkspaceContext(workspaceId: string, userId: string): WorkspaceContext {
  return { workspaceId, userId, role: "admin" };
}

function readBearerToken(context: Context): string | undefined {
  const authorization = context.req.header("authorization") ?? "";
  const prefix = "Bearer ";
  return authorization.startsWith(prefix) ? normalizeToken(authorization.slice(prefix.length)) : undefined;
}

function normalizeToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value || undefined;
}

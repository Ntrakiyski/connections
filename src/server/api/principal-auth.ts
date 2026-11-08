import type { ConnectionsHumanAuth } from "../human-auth.ts";
import type { MeetingsOAuthService } from "../meetings-oauth.ts";
import type { IIdentityDirectory } from "../storage/identity-directory.ts";
import type { IWorkspaceMembershipStore, IWorkspaceStore } from "../storage/runtime-database.ts";
import type { RuntimeTokenService, WorkspaceContext } from "../storage/runtime-token-service.ts";
import type { MiddlewareHandler } from "hono";

import { isConsoleShellPath } from "./console-paths.ts";
import { HttpRequestError } from "./http-utils.ts";

export type RequestPrincipal =
  | { kind: "human"; userId: string; sessionId: string }
  | {
      kind: "meetings";
      userId: string;
      organizationId: string;
      workspaceId: string;
      referenceId: string;
      tokenId: string;
      expiresAt: number;
    }
  | { kind: "runtime"; userId: string; workspaceId: string; tokenId: string };

declare module "hono" {
  interface ContextVariableMap {
    principal: RequestPrincipal;
  }
}

export interface PrincipalAuthOptions {
  auth: ConnectionsHumanAuth;
  directory: IIdentityDirectory;
  workspaceStore: IWorkspaceStore;
  membershipStore: IWorkspaceMembershipStore;
  runtimeTokens: RuntimeTokenService;
  trustedOrigins: string[];
  meetingsOAuth?: MeetingsOAuthService;
}

/** Resolves only stored, live grants. Neither company role nor request intent grants access. */
export async function resolveWorkspaceAccess(
  options: Pick<PrincipalAuthOptions, "directory" | "workspaceStore" | "membershipStore">,
  userId: string,
  workspaceId: string,
  allowArchived = false,
): Promise<WorkspaceContext> {
  const workspace = await options.workspaceStore.getById(workspaceId);
  if (!workspace?.organizationId || !(await options.directory.getOrganizationRole(workspace.organizationId, userId))) {
    throw new HttpRequestError("workspace_forbidden", "Workspace access is not available.", 403);
  }
  const role = await options.membershipStore.getRole(workspaceId, userId);
  if (!role) throw new HttpRequestError("workspace_forbidden", "Workspace access is not available.", 403);
  if (workspace.deletedAt && !(allowArchived && role === "admin")) {
    throw new HttpRequestError("workspace_deleted", "This workspace is archived and unavailable.", 403);
  }
  return { workspaceId, userId, organizationId: workspace.organizationId, role };
}

export function assertTrustedMutation(request: Request, trustedOrigins: string[]): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins.includes(origin)) {
    throw new HttpRequestError("origin_forbidden", "A trusted request origin is required.", 403);
  }
}

/** Principal matrix: console = cookie, runtime = oct_ key, Meetings = dedicated grant. */
export function createPrincipalAuthMiddleware(options: PrincipalAuthOptions): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path;
    if (isPublicRequest(path, context.req.method)) {
      await next();
      return;
    }
    const authorization = context.req.header("authorization");
    const meetingsPath =
      path === "/api/meetings" ||
      path.startsWith("/api/meetings/") ||
      path === "/api/meetings-identity" ||
      path === "/api/meetings-identity/legacy";
    if (meetingsPath) {
      const match = /^Bearer (cma_[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
      if (!match?.[1] || !options.meetingsOAuth)
        throw new HttpRequestError("principal_forbidden", "A dedicated Meetings access token is required.", 401);
      if (hasSessionCookie(context.req.raw))
        throw new HttpRequestError("conflicting_credentials", "Use one principal per request.", 400);
      const access = await options.meetingsOAuth.verify(
        match[1],
        context.req.method === "GET" ? "meetings:read" : "meetings:write",
      );
      if (
        [context.req.header("x-workspace-id"), ...(context.req.queries("workspaceId") ?? [])].some(
          (value) => value && value !== access.workspaceId,
        )
      )
        throw new HttpRequestError("workspace_scope_conflict", "Meetings grants cannot select another workspace.", 403);
      const workspace = await resolveWorkspaceAccess(options, access.userId, access.workspaceId);
      context.set("principal", { kind: "meetings", ...access });
      context.set("workspace", workspace);
      await next();
      return;
    }
    if (authorization) {
      const match = /^Bearer (oct_[A-Za-z0-9_-]+)$/.exec(authorization);
      const runtimePath = path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/v1/");
      if (!match?.[1] || !runtimePath)
        throw new HttpRequestError("principal_forbidden", "This credential cannot access this endpoint.", 401);
      if (hasSessionCookie(context.req.raw))
        throw new HttpRequestError("conflicting_credentials", "Use one principal per request.", 400);
      const access = await options.runtimeTokens.verifyToken(match[1]);
      if (!access) throw new HttpRequestError("unauthorized", "A valid runtime token is required.", 401);
      const headerWorkspace = context.req.header("x-workspace-id");
      const queryWorkspace = context.req.query("workspaceId");
      if ([headerWorkspace, queryWorkspace].some((selector) => selector && selector !== access.workspaceId))
        throw new HttpRequestError("workspace_scope_conflict", "Runtime keys cannot select another workspace.", 403);
      const workspace = await resolveWorkspaceAccess(options, access.userId, access.workspaceId);
      context.set("principal", { kind: "runtime", ...access });
      context.set("workspace", { ...workspace, tokenId: access.tokenId });
      await next();
      return;
    }
    if (
      path === "/mcp" ||
      path.startsWith("/mcp/") ||
      path.startsWith("/v1/") ||
      path === "/api/meetings" ||
      path.startsWith("/api/meetings/")
    ) {
      throw new HttpRequestError("principal_forbidden", "This endpoint requires its dedicated credential.", 401);
    }
    const session = await options.auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user.emailVerified)
      throw new HttpRequestError("unauthorized", "A verified Connections session is required.", 401);
    assertTrustedMutation(context.req.raw, options.trustedOrigins);
    const workspaceId = context.req.header("x-workspace-id");
    if (!workspaceId) throw new HttpRequestError("workspace_required", "Select a workspace for this request.", 400);
    const queryWorkspace = context.req.query("workspaceId");
    if (queryWorkspace && queryWorkspace !== workspaceId)
      throw new HttpRequestError("workspace_scope_conflict", "Conflicting workspace selectors.", 400);
    const workspace = await resolveWorkspaceAccess(
      options,
      session.user.id,
      workspaceId,
      path === "/api/workspace/restore",
    );
    context.set("principal", { kind: "human", userId: session.user.id, sessionId: session.session.id });
    context.set("workspace", workspace);
    await next();
  };
}

function hasSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") ?? "");
}

function isPublicRequest(path: string, method: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    (path === "/health" ||
      path === "/openapi.json" ||
      path === "/docs" ||
      path === "/oauth/callback" ||
      path.startsWith("/assets/") ||
      isConsoleShellPath(path))
  );
}

import type { IWorkspaceMembershipStore, IWorkspaceStore } from "../storage/runtime-database.ts";
import type { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import type { MiddlewareHandler } from "hono";

import { HttpRequestError } from "./http-utils.ts";

export interface RuntimeTokenAuthOptions {
  runtimeTokens: RuntimeTokenService;
  memberships: IWorkspaceMembershipStore;
  workspaceStore?: IWorkspaceStore;
}

/** Resolves opaque runtime tokens after Clerk has handled human sessions. */
export function createRuntimeTokenAuthMiddleware(options: RuntimeTokenAuthOptions): MiddlewareHandler {
  return async (context, next) => {
    const token = readBearerToken(context);
    if (!token?.startsWith("oct_")) {
      await next();
      return;
    }

    const runtime = await options.runtimeTokens.verifyToken(token);
    if (!runtime) {
      throw new HttpRequestError("unauthorized", "A valid runtime token is required.", 401);
    }
    const role = await options.memberships.getRole(runtime.workspaceId, runtime.userId);
    if (!role) {
      throw new HttpRequestError("unauthorized", "The runtime token owner is no longer a workspace member.", 401);
    }
    const workspace = await options.workspaceStore?.getById(runtime.workspaceId);
    if (workspace?.deletedAt) {
      throw new HttpRequestError("workspace_deleted", "This workspace is archived and unavailable.", 403);
    }
    context.set("workspace", { ...runtime, role });
    await next();
  };
}

function readBearerToken(context: { req: { header(name: string): string | undefined } }): string | undefined {
  const authorization = context.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return token || undefined;
}

import type { WorkspaceContext } from "../storage/runtime-token-service.ts";
import type { MiddlewareHandler } from "hono";

import { HttpRequestError } from "./http-utils.ts";

declare module "hono" {
  interface ContextVariableMap {
    workspace: WorkspaceContext;
  }
}

/** Used only after the entrypoint validates an explicit loopback development bypass. */
export function createDevelopmentAuthMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    if (
      context.req.path === "/api/meetings" ||
      context.req.path.startsWith("/api/meetings/") ||
      context.req.path.startsWith("/api/identity/") ||
      context.req.path.startsWith("/api/companies") ||
      context.req.path.startsWith("/api/account")
    ) {
      throw new HttpRequestError("unauthorized", "This endpoint requires configured human authentication.", 401);
    }
    context.set("workspace", { workspaceId: "default", userId: "local-dev", role: "admin" });
    await next();
  };
}

import type { WorkspaceContext } from "../storage/runtime-token-service.ts";
import type { Context } from "hono";

import { HttpRequestError } from "./http-utils.ts";

export function getWorkspaceContext(context: Context): WorkspaceContext {
  const workspace = context.get("workspace");
  if (!workspace) {
    throw new Error("Workspace context not set — is Clerk authentication middleware applied?");
  }
  return workspace;
}

/** Require the manager or admin workspace role. */
export function requireManager(context: Context): WorkspaceContext {
  const workspace = getWorkspaceContext(context);
  if (workspace.role === "member") {
    throw new HttpRequestError("forbidden", "Manager role required.", 403);
  }
  return workspace;
}

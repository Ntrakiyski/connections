import type { ClerkAuthOptions } from "./clerk-auth.ts";
import type { Hono } from "hono";

import { deleteCookie } from "hono/cookie";
import { getClerkAuthSession } from "./clerk-auth.ts";
import { jsonError } from "./http-utils.ts";
import { getWorkspaceContext } from "./workspace-helpers.ts";

/** Registers the session endpoints owned by Clerk rather than local bearer cookies. */
export function registerClerkRoutes(app: Hono, _options: ClerkAuthOptions): void {
  app.get("/api/auth/session", (context) => {
    const session = getClerkAuthSession(context);
    if (!session) {
      return jsonError(context, 401, "unauthorized", "A valid Clerk session is required.");
    }
    return context.json(session);
  });
  app.post("/api/auth/logout", (context) => {
    deleteCookie(context, "__session", { httpOnly: true, path: "/", sameSite: "Lax" });
    return context.json({ ok: true });
  });
  app.post("/api/auth/workspace", (context) => context.json(getWorkspaceContext(context)));
}

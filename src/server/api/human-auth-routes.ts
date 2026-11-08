import type { ConnectionsHumanAuth } from "../human-auth.ts";
import type { IIdentityDirectory } from "../storage/identity-directory.ts";
import type { Hono } from "hono";

import { HttpRequestError } from "./http-utils.ts";
import { assertTrustedMutation } from "./principal-auth.ts";

const allowedIdentityRoutes = new Set([
  "GET /get-session",
  "POST /sign-up/email",
  "POST /sign-in/email",
  "POST /sign-out",
  "GET /verify-email",
  "POST /send-verification-email",
  "POST /request-password-reset",
  "POST /reset-password",
  "POST /change-password",
  "POST /update-user",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
]);

/** Only account/session endpoints are public; company mutations belong to application services. */
export function registerHumanAuthRoutes(
  app: Hono,
  auth: ConnectionsHumanAuth,
  directory: IIdentityDirectory,
  trustedOrigins: string[],
): void {
  app.all("/api/identity/*", async (context) => {
    assertTrustedMutation(context.req.raw, trustedOrigins);
    if (context.req.header("authorization"))
      throw new HttpRequestError("principal_forbidden", "Account endpoints require session authentication.", 401);
    const route = `${context.req.method} ${context.req.path.slice("/api/identity".length)}`;
    const resetCallback =
      context.req.method === "GET" && /^\/reset-password\/[^/]+$/.test(context.req.path.slice("/api/identity".length));
    if (!allowedIdentityRoutes.has(route) && !resetCallback)
      throw new HttpRequestError("auth_route_forbidden", "Authentication endpoint is not available.", 403);
    return auth.handler(context.req.raw);
  });
  app.get("/api/account", async (context) => {
    if (context.req.header("authorization"))
      throw new HttpRequestError("principal_forbidden", "Account endpoints require session authentication.", 401);
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user.emailVerified)
      throw new HttpRequestError("unauthorized", "A verified session is required.", 401);
    return context.json({
      user: { id: session.user.id, name: session.user.name, email: session.user.email },
      workspaces: await directory.listWorkspaces(session.user.id),
    });
  });
  app.post("/api/auth/logout", (context) => {
    assertTrustedMutation(context.req.raw, trustedOrigins);
    if (context.req.header("authorization"))
      throw new HttpRequestError("principal_forbidden", "Logout requires session authentication.", 401);
    const url = new URL("/api/identity/sign-out", context.req.url);
    return auth.handler(new Request(url, { method: "POST", headers: context.req.raw.headers, body: "{}" }));
  });
}

import type { ConnectionsHumanAuth } from "../human-auth.ts";
import type { MeetingsOAuthService } from "../meetings-oauth.ts";
import type { Hono } from "hono";

import { z } from "zod";
import { HttpRequestError } from "./http-utils.ts";
import { assertTrustedMutation } from "./principal-auth.ts";

export interface MeetingsOAuthRouteOptions {
  auth: ConnectionsHumanAuth;
  service: MeetingsOAuthService;
  trustedOrigins: string[];
}

/** Protocol endpoints precede the personal-account allowlist; no OAuth CRUD endpoint is exposed. */
export function registerMeetingsOAuthRoutes(app: Hono, options: MeetingsOAuthRouteOptions): void {
  for (const path of [
    "/api/identity/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/identity",
  ]) {
    app.get(path, (context) =>
      options.auth.handler(
        new Request(`${options.service.issuer}/.well-known/oauth-authorization-server`, {
          headers: context.req.raw.headers,
        }),
      ),
    );
  }
  app.get("/.well-known/oauth-protected-resource/api/meetings", (context) =>
    context.json({
      resource: options.service.resource,
      authorization_servers: [options.service.issuer],
      scopes_supported: ["meetings:read", "meetings:write"],
      bearer_methods_supported: ["header"],
    }),
  );
  app.get("/api/identity/oauth2/authorize", async (context) => {
    return protocol(() => {
      if (context.req.header("authorization")) throw forbidden();
      return options.service.start(context.req.raw);
    });
  });
  app.post("/api/identity/oauth2/token", async (context) => {
    return protocol(async () => {
      if (context.req.header("authorization") || hasSessionCookie(context.req.raw)) throw forbidden();
      if (!(context.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
        throw new HttpRequestError("invalid_request", "OAuth token requests require form encoding.", 400);
      return options.service.token(context.req.raw, new URLSearchParams(await boundedBody(context.req.raw)));
    });
  });
  app.post("/api/identity/oauth2/revoke", async (context) => {
    return protocol(async () => {
      if (context.req.header("authorization") || hasSessionCookie(context.req.raw)) throw forbidden();
      if (!(context.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
        throw new HttpRequestError("invalid_request", "OAuth token requests require form encoding.", 400);
      return options.service.revoke(context.req.raw, new URLSearchParams(await boundedBody(context.req.raw)));
    });
  });
  app.post("/api/meetings-oauth/request", async (context) => {
    const session = await verifiedSession(context.req.raw, options);
    const body = await readJson(context.req.raw, z.strictObject({ oauthQuery: z.string().max(8192) }));
    return context.json(await options.service.selection(body.oauthQuery, session.user.id));
  });
  app.post("/api/meetings-oauth/select", async (context) => {
    const session = await verifiedSession(context.req.raw, options);
    const body = await readJson(
      context.req.raw,
      z.strictObject({ oauthQuery: z.string().max(8192), workspaceId: z.string().min(1).max(200) }),
    );
    return context.json(
      await options.service.select(body.oauthQuery, session.user.id, session.session.id, body.workspaceId),
    );
  });
  app.post("/api/meetings-oauth/continue", async (context) => {
    const session = await verifiedSession(context.req.raw, options);
    const body = await readJson(context.req.raw, z.strictObject({ oauthQuery: z.string().max(8192) }));
    return options.service.continue(context.req.raw, body.oauthQuery, session.user.id);
  });
  app.post("/api/meetings-oauth/consent", async (context) => {
    const session = await verifiedSession(context.req.raw, options);
    const body = await readJson(
      context.req.raw,
      z.strictObject({ oauthQuery: z.string().max(8192), accept: z.boolean() }),
    );
    return options.service.consent(context.req.raw, body.oauthQuery, session.user.id, body.accept);
  });
}

async function verifiedSession(
  request: Request,
  options: MeetingsOAuthRouteOptions,
): Promise<NonNullable<Awaited<ReturnType<ConnectionsHumanAuth["api"]["getSession"]>>>> {
  if (request.headers.has("authorization")) throw forbidden();
  assertTrustedMutation(request, options.trustedOrigins);
  const session = await options.auth.api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified)
    throw new HttpRequestError("unauthorized", "A verified Connections session is required.", 401);
  return session;
}

async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new HttpRequestError("invalid_request", "OAuth request is too large.", 413);
      }
      body += decoder.decode(result.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
async function protocol(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof HttpRequestError)) throw error;
    const code = error.code === "principal_forbidden" ? "invalid_request" : error.code;
    const status = code === "invalid_grant" || code === "invalid_request" ? 400 : error.status;
    return Response.json({ error: code, error_description: error.message }, { status });
  }
}
function hasSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") ?? "");
}
function forbidden(): HttpRequestError {
  return new HttpRequestError("principal_forbidden", "Use one dedicated OAuth principal.", 401);
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await boundedBody(request);
  try {
    return schema.parse(JSON.parse(body));
  } catch {
    throw new HttpRequestError("invalid_request", "The OAuth request body is invalid.", 400);
  }
}

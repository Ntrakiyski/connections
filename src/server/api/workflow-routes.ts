import type { PrincipalAuthOptions } from "./principal-auth.ts";
import type { Hono } from "hono";

import { z } from "zod";
import { HttpRequestError, notFound } from "./http-utils.ts";
import { assertTrustedMutation, requireVerifiedSession, resolveWorkspaceAccess } from "./principal-auth.ts";

const backendSchema = z.strictObject({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  origin: z.url({ protocol: /^https?$/ }).refine((value) => new URL(value).origin === value),
  token: z.string().regex(/^ofp_[A-Za-z0-9_-]{43}$/),
});

export interface WorkflowBackend {
  workspaceId: string;
  userId: string;
  origin: string;
  token: string;
}

/** Backends are deployment-owned. Browser input can select a workspace, never an upstream URL or key. */
export function parseWorkflowBackends(value: string | undefined): WorkflowBackend[] {
  if (!value) return [];
  try {
    const backends = z.array(backendSchema).parse(JSON.parse(value));
    for (const key of ["workspaceId", "origin", "token"] as const) {
      if (new Set(backends.map((backend) => backend[key])).size !== backends.length) throw new Error();
    }
    return backends;
  } catch {
    throw new Error(
      "CONNECTIONS_OPEN_FLOW_BACKENDS must contain unique workspace IDs, Open Flow origins, and personal tokens.",
    );
  }
}

const route = "/api/workflows/:workspaceId";
const editorApi = /^\/v1\/(?:flows|runs|tags|variables|trigger-keys)(?:\/|$)/;
const connectorReads =
  /^\/v1\/connector\/(?:proxy\/(?:providers|actions)|providers|actions(?:\/[^/]+)?|action-metadata(?:\/[^/]+)?|connections(?:\/[^/]+)?|leina\/bots)$/;
const forwardedRequestHeaders = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "idempotency-key",
  "x-open-flow-client",
];
const forwardedResponseHeaders = ["content-type", "content-disposition", "etag", "retry-after"];

export function registerWorkflowRoutes(
  app: Hono,
  auth: PrincipalAuthOptions,
  backends: readonly WorkflowBackend[],
): void {
  const findBackend = async (request: Request, workspaceId: string): Promise<WorkflowBackend | undefined> => {
    if (request.headers.has("authorization"))
      throw new HttpRequestError("principal_forbidden", "Workflows require a Connections session.", 401);
    const session = await requireVerifiedSession(auth.auth, request);
    await resolveWorkspaceAccess(auth, session.user.id, workspaceId);
    return backends.find((backend) => backend.workspaceId === workspaceId && backend.userId === session.user.id);
  };

  app.get(route, async (context) => {
    const backend = await findBackend(context.req.raw, context.req.param("workspaceId"));
    return context.json({ enabled: Boolean(backend) });
  });

  app.all(`${route}/*`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const request = context.req.raw;
    const incoming = new URL(request.url);
    const path = `/${incoming.pathname.split("/").slice(4).join("/")}`;
    if (/%(?:2f|5c|25|00)/i.test(path)) return notFound(context);
    const readable = request.method === "GET" || request.method === "HEAD";
    if (!editorApi.test(path) && !(readable && connectorReads.test(path))) return notFound(context);

    assertTrustedMutation(request, auth.trustedOrigins);
    const backend = await findBackend(request, workspaceId);
    if (!backend)
      throw new HttpRequestError(
        "workflow_access_forbidden",
        "Workflows are unavailable for this account in this workspace.",
        403,
      );
    const headers = copyHeaders(request.headers, forwardedRequestHeaders);
    headers.set("authorization", `Bearer ${backend.token}`);
    const destination = new URL(backend.origin);
    destination.pathname = path;
    destination.search = incoming.search;
    const response = await fetch(destination, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    } as RequestInit).catch(() => undefined);
    if (
      !response ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400 && response.status !== 304)
    ) {
      await response?.body?.cancel();
      return context.json(
        { error: { code: "workflow_backend_unavailable", message: "Open Flow is unavailable for this workspace." } },
        502,
      );
    }

    const outputHeaders = copyHeaders(response.headers, forwardedResponseHeaders);
    outputHeaders.set("x-content-type-options", "nosniff");
    outputHeaders.set("content-security-policy", "default-src 'none'; sandbox");
    let body = response.body;
    if (body && outputHeaders.get("content-type")?.startsWith("text/event-stream")) {
      outputHeaders.set("x-accel-buffering", "no");
      body = body.pipeThrough(
        new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
          async transform(chunk, controller) {
            const current = await findBackend(request, workspaceId).catch(() => undefined);
            if (current === backend) controller.enqueue(chunk);
            else controller.terminate();
          },
        }),
      );
    }
    return new Response(body, { status: response.status, headers: outputHeaders });
  });
}

function copyHeaders(source: Headers, names: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

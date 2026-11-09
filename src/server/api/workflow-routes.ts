import type { WorkflowPool, WorkflowScope } from "../workflow-runtime.ts";
import type { PrincipalAuthOptions } from "./principal-auth.ts";
import type { Hono } from "hono";

import { z } from "zod";
import { isWorkflowEditorRequest, workflowScope } from "../workflow-runtime.ts";
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
interface WorkflowTarget {
  origin: string;
  token: string;
  scope?: WorkflowScope;
}
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
  pool?: WorkflowPool,
): void {
  const findBackend = async (request: Request, workspaceId: string): Promise<WorkflowTarget | undefined> => {
    if (request.headers.has("authorization"))
      throw new HttpRequestError("principal_forbidden", "Workflows require a Connections session.", 401);
    const session = await requireVerifiedSession(auth.auth, request);
    await resolveWorkspaceAccess(auth, session.user.id, workspaceId);
    const existing = backends.find(
      (backend) => backend.workspaceId === workspaceId && backend.userId === session.user.id,
    );
    if (existing) return existing;
    const scope = workflowScope(workspaceId, session.user.id);
    if (pool && scope) return { origin: pool.origin, token: pool.secret, scope };
  };

  app.get(route, async (context) => {
    const backend = await findBackend(context.req.raw, context.req.param("workspaceId"));
    return context.json({ enabled: Boolean(backend) });
  });

  app.post(route, async (context) => {
    assertTrustedMutation(context.req.raw, auth.trustedOrigins);
    const backend = await findBackend(context.req.raw, context.req.param("workspaceId"));
    if (!backend?.scope) return context.json({ enabled: Boolean(backend) });
    const response = await fetch(new URL("/provision", backend.origin), {
      method: "POST",
      headers: backendHeaders(backend),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    await response?.body?.cancel();
    if (!response?.ok)
      return context.json(
        { error: { code: "workflow_backend_unavailable", message: "The workspace runner could not start." } },
        502,
      );
    return context.json({ enabled: true });
  });

  app.all(`${route}/*`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const request = context.req.raw;
    const incoming = new URL(request.url);
    const path = `/${incoming.pathname.split("/").slice(4).join("/")}`;
    if (!isWorkflowEditorRequest(path, request.method)) return notFound(context);

    assertTrustedMutation(request, auth.trustedOrigins);
    const backend = await findBackend(request, workspaceId);
    if (!backend)
      throw new HttpRequestError(
        "workflow_access_forbidden",
        "Workflows are unavailable for this account in this workspace.",
        403,
      );
    const headers = backendHeaders(backend, copyHeaders(request.headers, forwardedRequestHeaders));
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
            if (
              current?.origin === backend.origin &&
              current.token === backend.token &&
              current.scope?.userId === backend.scope?.userId
            )
              controller.enqueue(chunk);
            else controller.terminate();
          },
        }),
      );
    }
    return new Response(body, { status: response.status, headers: outputHeaders });
  });
}

function backendHeaders(backend: WorkflowTarget, headers = new Headers()): Headers {
  headers.set("authorization", `Bearer ${backend.token}`);
  if (backend.scope) {
    headers.set("x-connections-workspace-id", backend.scope.workspaceId);
    headers.set("x-connections-user-id", backend.scope.userId);
  }
  return headers;
}

function copyHeaders(source: Headers, names: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

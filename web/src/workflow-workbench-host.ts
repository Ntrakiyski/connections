import type { WorkspaceIntent, WorkspaceScope } from "./workspace-scope";
import type {
  FlowCatalogEvent,
  FlowChangeEvent,
  WorkbenchHost,
  WorkbenchNotification,
} from "@oomol-lab/open-flow/workbench";

import { canvasCommandSchema } from "@oomol-lab/open-flow/control-requests";
import { workspaceHref } from "./workspace-scope";

export function workflowGatewayPath(workspaceId: string): string {
  return `/api/workflows/${encodeURIComponent(workspaceId)}`;
}

export function workflowProviderHref(service: string, intent: WorkspaceIntent): string {
  return workspaceHref(`/providers/${encodeURIComponent(service)}`, intent);
}

export function createWorkflowWorkbenchHost(
  scope: WorkspaceScope,
  notify: (notification: WorkbenchNotification | undefined) => void,
): WorkbenchHost {
  const prefix = workflowGatewayPath(scope.intent.workspaceId);
  const workspaceSignal = scope.requests.signal;
  return {
    cacheEnvironment: prefix,
    notify,
    async request(input, init) {
      const origin = window.location.origin;
      const request = input instanceof Request ? input : undefined;
      const target = new URL(request?.url ?? String(input), origin);
      if (target.origin !== origin || !target.pathname.startsWith("/v1/")) {
        throw new Error("Expected a local workflow API path.");
      }
      const signals = [workspaceSignal, init?.signal ?? request?.signal].filter((signal) => signal != null);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const method = init?.method ?? request?.method;
      const provider = /^\/v1\/connector\/connections\/([A-Za-z0-9_-]+)\/page$/.exec(target.pathname)?.[1];
      if (method === "POST" && provider) {
        // The Workbench asks the host for account setup. Connections owns that page and its OAuth session.
        const url = new URL(workflowProviderHref(provider, scope.intent), origin);
        return Response.json({ url: url.href, version: 1 });
      }
      const url = new URL(`${prefix}${target.pathname}${target.search}`, origin);
      const response = await fetch(request ? new Request(url, request) : url, {
        ...init,
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
      signal.throwIfAborted();
      if (response.status === 401) window.dispatchEvent(new Event("connections-session-invalidated"));
      return response;
    },
    async openExternalPage(resolveUrl) {
      const tab = window.open("about:blank", "_blank");
      if (!tab) return false;
      tab.opener = null;
      try {
        const url = new URL(await resolveUrl());
        workspaceSignal?.throwIfAborted();
        if (url.origin !== window.location.origin || !url.pathname.startsWith("/providers/")) {
          throw new Error("Expected a Connections provider page.");
        }
        tab.location.href = workspaceHref(`${url.pathname}${url.search}`, scope.intent);
        return true;
      } catch (error) {
        tab.close();
        throw error;
      }
    },
    subscribeFlow(flowId, listener) {
      return subscribe(
        `${prefix}/v1/flows/${encodeURIComponent(flowId)}/notifications`,
        listener,
        decodeFlowEvent,
        workspaceSignal,
      );
    },
    subscribeFlowCatalog(listener) {
      return subscribe(`${prefix}/v1/flows/notifications`, listener, decodeCatalogEvent, workspaceSignal);
    },
  };
}

function subscribe<T>(
  path: string,
  listener: (event?: T) => void,
  decode: (event: Record<string, unknown>) => T | undefined,
  signal?: AbortSignal,
): { ready: Promise<void>; stop(): void } {
  if (signal?.aborted) return { ready: Promise.resolve(), stop() {} };
  const source = new EventSource(path);
  const { promise: ready, resolve } = Promise.withResolvers<void>();
  let initialized = false;
  const finish = () => {
    initialized = true;
    resolve();
  };
  const timeout = window.setTimeout(finish, 5_000);
  const stop = () => {
    source.close();
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
    resolve();
  };
  signal?.addEventListener("abort", stop, { once: true });
  source.onopen = () => {
    window.clearTimeout(timeout);
    if (initialized) listener();
    finish();
  };
  source.onmessage = (message: MessageEvent<string>) => {
    let event: T | undefined;
    try {
      const value: unknown = JSON.parse(message.data);
      if (value && typeof value === "object") event = decode(value as Record<string, unknown>);
    } catch {
      return;
    }
    if (event) listener(event);
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) stop();
  };
  return { ready, stop };
}

function decodeCatalogEvent(value: Record<string, unknown>): FlowCatalogEvent | undefined {
  if (value.version !== 1) return;
  if (value.kind === "flows.changed") return { version: 1, kind: value.kind };
  if (value.kind === "flow.created" && typeof value.flowId === "string") {
    return { version: 1, kind: value.kind, flowId: value.flowId };
  }
}

function decodeFlowEvent(value: Record<string, unknown>): FlowChangeEvent | undefined {
  if (value.version !== 1 || typeof value.flowId !== "string") return;
  const { flowId, kind } = value;
  switch (kind) {
    case "draft.changed":
      if (typeof value.revisionId === "string") return { version: 1, kind, flowId, revisionId: value.revisionId };
      break;
    case "access.changed":
      if (typeof value.accessRevision === "number" && Number.isSafeInteger(value.accessRevision)) {
        return { version: 1, kind, flowId, accessRevision: value.accessRevision };
      }
      break;
    case "canvas.command": {
      const command = canvasCommandSchema.safeParse(value.command);
      if (command.success) return { version: 1, kind, flowId, command: command.data };
      break;
    }
    case "run.created":
    case "run.changed":
      if (typeof value.runId === "string") return { version: 1, kind, flowId, runId: value.runId };
      break;
  }
}

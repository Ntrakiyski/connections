import type { RequestOptions } from "./api";

import { z } from "zod";

export interface WorkspaceIntent {
  userId: string;
  organizationId: string;
  workspaceId: string;
}
export interface WorkspaceScope {
  readonly intent: Readonly<WorkspaceIntent>;
  readonly requests: Readonly<RequestOptions>;
  rememberConsent(state: string, service: string): void;
  consumeCompletion(value: unknown): boolean;
  close(): void;
}
const completionSchema = z.object({
  type: z.literal("oauth.completed"),
  service: z.string(),
  state: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
});

/** A mounted tab context owns its requests and consent; another tab cannot change its destination. */
export function createWorkspaceScope(intent: WorkspaceIntent): WorkspaceScope {
  const identity = Object.freeze({ ...intent });
  const controller = new AbortController();
  const pending = new Map<string, string>();
  return {
    intent: identity,
    requests: Object.freeze({ workspaceId: identity.workspaceId, signal: controller.signal }),
    rememberConsent(state, service) {
      if (!controller.signal.aborted) pending.set(state, service);
    },
    consumeCompletion(value) {
      if (controller.signal.aborted) return false;
      const message = completionSchema.safeParse(value);
      if (
        !message.success ||
        message.data.userId !== identity.userId ||
        message.data.workspaceId !== identity.workspaceId ||
        pending.get(message.data.state) !== message.data.service
      )
        return false;
      pending.delete(message.data.state);
      return true;
    },
    close() {
      controller.abort();
      pending.clear();
    },
  };
}

export function workspaceHref(path: string, intent: Pick<WorkspaceIntent, "organizationId" | "workspaceId">): string {
  const url = new URL(path, "https://connections.invalid");
  if (url.origin !== "https://connections.invalid") throw new Error("Workspace navigation requires a local path.");
  url.searchParams.set("companyId", intent.organizationId);
  url.searchParams.set("workspaceId", intent.workspaceId);
  return `${url.pathname}${url.search}${url.hash}`;
}

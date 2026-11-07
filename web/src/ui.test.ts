import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeData, subscribeToOAuthCompletions } from "./ui";
import { createWorkspaceScope } from "./workspace-scope";

afterEach(() => vi.unstubAllGlobals());

describe("workspace console requests", () => {
  it("sends the captured workspace on all requests without a bearer credential", async () => {
    const calls: Array<{ path: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(path), headers: new Headers(init?.headers) });
        if (path === "/api/auth/session")
          return Response.json({
            authenticated: true,
            adminAuthConfigured: true,
            workspaceId: "A1",
            workspaceName: "A1",
            userId: "operator",
            role: "member",
          });
        if (path === "/api/runs") return Response.json({ items: [] });
        if (path === "/api/workspace/safety-config") return Response.json({});
        return Response.json([]);
      }),
    );
    const scope = createWorkspaceScope({ userId: "operator", organizationId: "A", workspaceId: "A1" });
    const result = await loadRuntimeData(scope);
    expect(result.data.workspaceId).toBe("A1");
    expect(calls).toHaveLength(8);
    for (const call of calls) {
      expect(call.headers.get("x-workspace-id")).toBe("A1");
      expect(call.headers.has("authorization")).toBe(false);
    }
    scope.close();
  });

  it("rejects a session response for a different user or workspace before resource loading", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ authenticated: true, workspaceId: "B1", userId: "operator", role: "admin" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const scope = createWorkspaceScope({ userId: "operator", organizationId: "A", workspaceId: "A1" });
    await expect(loadRuntimeData(scope)).rejects.toThrow("no longer available");
    expect(fetcher).toHaveBeenCalledTimes(1);
    scope.close();
  });

  it("accepts only a pending completion for the mounted user and workspace, once", () => {
    class Channel {
      static current: Channel | undefined;
      private listener?: (event: MessageEvent<unknown>) => void;
      closed = false;
      constructor(_name: string) {
        Channel.current = this;
      }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void): void {
        this.listener = listener;
      }
      close(): void {
        this.closed = true;
      }
      emit(data: unknown): void {
        this.listener?.({ data } as MessageEvent<unknown>);
      }
    }
    vi.stubGlobal("BroadcastChannel", Channel);
    const scope = createWorkspaceScope({ userId: "operator", organizationId: "A", workspaceId: "A1" });
    const refresh = vi.fn();
    const unsubscribe = subscribeToOAuthCompletions(scope, refresh);
    scope.rememberConsent("original-consent", "gmail");
    const completed = {
      type: "oauth.completed",
      state: "original-consent",
      service: "gmail",
      userId: "operator",
      workspaceId: "A1",
    };
    Channel.current?.emit({ ...completed, workspaceId: "B1" });
    Channel.current?.emit({ ...completed, userId: "other" });
    Channel.current?.emit({ ...completed, state: "old-consent" });
    expect(refresh).not.toHaveBeenCalled();
    Channel.current?.emit(completed);
    Channel.current?.emit(completed);
    expect(refresh).toHaveBeenCalledTimes(1);
    scope.close();
    unsubscribe();
    expect(Channel.current?.closed).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToOAuthCompletions, subscribeToWorkspaceChanges, loadRuntimeData } from "./ui";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscribeToOAuthCompletions", () => {
  it("refreshes when the OAuth callback broadcasts completion", () => {
    const addEventListener = vi.fn();
    class FakeBroadcastChannel {
      static instance: FakeBroadcastChannel | undefined;
      private listener: ((event: MessageEvent) => void) | undefined;
      closed = false;

      constructor(readonly name: string) {
        FakeBroadcastChannel.instance = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        if (type === "message") {
          this.listener = listener;
        }
      }

      close(): void {
        this.closed = true;
      }

      emit(data: unknown): void {
        this.listener?.({ data } as MessageEvent);
      }
    }
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const refresh = vi.fn();

    const unsubscribe = subscribeToOAuthCompletions(refresh);
    FakeBroadcastChannel.instance?.emit({ type: "oauth.completed", service: "gmail" });

    expect(FakeBroadcastChannel.instance?.name).toBe("oomol-connect-oauth");
    expect(addEventListener).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ type: "oauth.completed", service: "gmail" });
    unsubscribe();
    expect(FakeBroadcastChannel.instance?.closed).toBe(true);
  });
});

describe("subscribeToWorkspaceChanges", () => {
  it("refreshes when Clerk changes the active organization", () => {
    const refresh = vi.fn();
    vi.stubGlobal("window", new EventTarget());
    const unsubscribe = subscribeToWorkspaceChanges(refresh);

    window.dispatchEvent(new Event("clerk:organization-change"));

    expect(refresh).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

describe("loadRuntimeData", () => {
  it("passes the Clerk token to all API calls", async () => {
    const calls: Array<{ path: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(path), headers: new Headers(init?.headers) });
        if (path === "/api/auth/session") {
          return Response.json({ adminAuthConfigured: true, authenticated: true });
        }
        if (path === "/api/runs") {
          return Response.json({ items: [], nextCursor: null });
        }
        return Response.json([]);
      }),
    );

    await loadRuntimeData("clerk-token");

    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/session",
      "/api/providers",
      "/api/connections",
      "/api/oauth/configs",
      "/api/runtime-tokens",
      "/api/runs",
      "/api/auth/workspaces",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer clerk-token");
    }
  });

  it("works without a Clerk token (null)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL) => {
        if (path === "/api/auth/session") {
          return Response.json({ adminAuthConfigured: true, authenticated: true });
        }
        if (path === "/api/runs") return Response.json({ items: [] });
        return Response.json([]);
      }),
    );

    const result = await loadRuntimeData(null);
    expect(result.data.providers).toEqual([]);
  });

  it("keeps the active workspace usable when the optional workspace list route is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL) => {
        if (path === "/api/auth/session") {
          return Response.json({
            workspaceId: "workspace-1",
            userId: "user-1",
            role: "admin",
            sessionClaims: { org_name: "Platform" },
          });
        }
        if (path === "/api/runs") return Response.json({ items: [] });
        if (path === "/api/auth/workspaces") return Response.json({ code: "not_found" }, { status: 404 });
        return Response.json([]);
      }),
    );

    const result = await loadRuntimeData("");

    expect(result.data.workspaceName).toBe("Platform");
    expect(result.workspaces).toEqual([{ workspaceId: "workspace-1", name: "Platform", role: "admin" }]);
  });
});

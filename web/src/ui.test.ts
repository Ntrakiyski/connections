import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrganizationToken, subscribeToOAuthCompletions, loadRuntimeData } from "./ui";

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

describe("loadRuntimeData", () => {
  it("requests a Clerk token scoped to the selected organization", async () => {
    const getToken = vi.fn().mockResolvedValue("organization-token");

    await expect(getOrganizationToken(getToken, "org_selected")).resolves.toBe("organization-token");
    expect(getToken).toHaveBeenCalledWith({ organizationId: "org_selected", skipCache: true });
  });

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
        if (path === "/api/workspace/safety-config") {
          return Response.json(testSafetyConfig());
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
      "/api/workspace/safety-config",
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
        if (path === "/api/workspace/safety-config") return Response.json(testSafetyConfig());
        return Response.json([]);
      }),
    );

    const result = await loadRuntimeData(null);
    expect(result.data.providers).toEqual([]);
  });
});

function testSafetyConfig() {
  const resolved = {
    scopePreflight: { mode: "observe" },
    idempotency: { mode: "observe" },
    retry: { mode: "observe", maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 },
    rateLimit: { mode: "observe", maxConcurrent: 4 },
  };
  return { workspace: resolved, resolved };
}

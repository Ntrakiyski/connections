import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowWorkbenchHost } from "./workflow-workbench-host";
import { createWorkspaceScope } from "./workspace-scope";

const intent = { userId: "owner", organizationId: "company", workspaceId: "workspace-a" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("workspace workflow editor", () => {
  it("binds requests and their lifetime to the selected workspace", async () => {
    const scope = createWorkspaceScope(intent);
    const fetcher = vi.fn((_request: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ flows: [] })),
    );
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", { location: { origin: "https://connections.example" } });
    const host = createWorkflowWorkbenchHost(scope, () => {});
    await host.request("/v1/flows?limit=5");
    const [path, init] = fetcher.mock.calls[0]!;
    expect(String(path)).toBe("https://connections.example/api/workflows/workspace-a/v1/flows?limit=5");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.redirect).toBe("error");
    scope.close();
    expect(init?.signal?.aborted).toBe(true);
    await expect(host.request("/v1/flows")).rejects.toHaveProperty("name", "AbortError");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects requests outside the workflow API and handles provider setup in the selected workspace", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", { location: { origin: "https://connections.example" } });
    const host = createWorkflowWorkbenchHost(createWorkspaceScope(intent), () => {});
    await expect(host.request("https://other.example/v1/flows")).rejects.toThrow("workflow API");
    await expect(host.request("/v1/../api/account")).rejects.toThrow("workflow API");
    const page = await host.request("/v1/connector/connections/gmail/page?flowId=flow_1", { method: "POST" });
    expect(await page.json()).toEqual({
      url: "https://connections.example/providers/gmail?companyId=company&workspaceId=workspace-a",
      version: 1,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes after a delayed notification connection and closes it on workspace exit", async () => {
    vi.useFakeTimers();
    const scope = createWorkspaceScope(intent);
    const listener = vi.fn();
    const stream = {
      onopen: null as (() => void) | null,
      close: vi.fn(),
    };
    const eventSource = vi.fn(function (_path: string) {
      return stream;
    });
    vi.stubGlobal("EventSource", eventSource);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const host = createWorkflowWorkbenchHost(scope, () => {});
    const subscription = host.subscribeFlowCatalog(listener);
    expect(eventSource).toHaveBeenCalledWith("/api/workflows/workspace-a/v1/flows/notifications");
    await vi.advanceTimersByTimeAsync(5_000);
    await subscription.ready;
    stream.onopen?.();
    expect(listener).toHaveBeenCalledTimes(1);
    scope.close();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
});

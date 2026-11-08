import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "./api";
import { createWorkspaceScope, workspaceHref } from "./workspace-scope";

afterEach(() => vi.unstubAllGlobals());
describe("tab workspace lifetime", () => {
  it("captures the destination of a delayed mutation and rejects its response after switching away", async () => {
    const first = createWorkspaceScope({ userId: "operator", organizationId: "A", workspaceId: "A1" });
    const second = createWorkspaceScope({ userId: "operator", organizationId: "B", workspaceId: "B1" });
    const reply = Promise.withResolvers<Response>();
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: RequestInfo | URL, init: RequestInit) => {
        requests.push(init);
        return reply.promise;
      }),
    );
    const pending = apiPost(
      "/api/connections/sentinel",
      { authType: "api_key", values: { apiKey: "synthetic" } },
      first.requests,
    );
    const rejected = expect(pending).rejects.toHaveProperty("name", "AbortError");
    first.close();
    reply.resolve(Response.json({ connected: true }));
    await rejected;
    expect(new Headers(requests[0]?.headers).get("x-workspace-id")).toBe("A1");
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(second.requests.signal?.aborted).toBe(false);
    second.close();
  });
  it("rejects resource requests without a workspace before contacting the API", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(apiGet("/api/connections")).rejects.toThrow("Choose a workspace");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps consent ownership immutable and refuses late completions after the context closes", () => {
    const scope = createWorkspaceScope({ userId: "operator", organizationId: "A", workspaceId: "A1" });
    expect(Reflect.set(scope.intent, "workspaceId", "B1")).toBe(false);
    scope.rememberConsent("pending", "sentinel");
    scope.close();
    expect(
      scope.consumeCompletion({
        type: "oauth.completed",
        userId: "operator",
        workspaceId: "A1",
        state: "pending",
        service: "sentinel",
      }),
    ).toBe(false);
  });
  it("preserves filters and puts exact workspace intent in bookmarkable URLs", () => {
    expect(
      workspaceHref("/runs?service=gmail&workspaceId=wrong#recent", { organizationId: "company-B", workspaceId: "B1" }),
    ).toBe("/runs?service=gmail&workspaceId=B1&companyId=company-B#recent");
  });
});

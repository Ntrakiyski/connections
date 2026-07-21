import type { IWorkspaceMembershipStore, IWorkspaceStore } from "../storage/runtime-database.ts";

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkAuthMiddleware, readClerkOrganization } from "./clerk-auth.ts";
import { HttpRequestError } from "./http-utils.ts";

const authenticateRequest = vi.hoisted(() => vi.fn());
const createClerkClient = vi.hoisted(() => vi.fn(() => ({ authenticateRequest })));
vi.mock("@clerk/backend", () => ({ createClerkClient }));

describe("readClerkOrganization", () => {
  it("reads Clerk's current compact version-2 organization claim", () => {
    expect(readClerkOrganization({ o: { id: "org_current", rol: "admin" } })).toEqual({
      id: "org_current",
      role: "org:admin",
    });
  });

  it("keeps support for the legacy organization claims", () => {
    expect(readClerkOrganization({ org_id: "org_legacy", org_role: "org:member" })).toEqual({
      id: "org_legacy",
      role: "org:member",
    });
  });
});

describe("createClerkAuthMiddleware", () => {
  beforeEach(() => {
    authenticateRequest.mockReset();
    authenticateRequest.mockResolvedValue({ isAuthenticated: true });
    createClerkClient.mockClear();
  });

  it("accepts an existing Clerk session on a Meetings request without OAuth claims", async () => {
    const response = await createApp().request("/api/meetings", {
      headers: authorization(claims()),
    });

    expect(response.status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      acceptsToken: ["session_token", "oauth_token"],
    });
  });

  it("accepts a Clerk OAuth access token whose client is in azp instead of aud", async () => {
    const response = await createApp().request("/api/meetings", {
      headers: authorization(claims({ azp: "meetings-client", scope: "openid profile email user:org:read" })),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: "workspace-a", userId: "user-a" });
  });

  it.each([
    {
      name: "wrong audience",
      claims: { aud: "other-client", scope: "openid profile email user:org:read" },
      clientId: "meetings-client",
      status: 401,
      code: "oauth_audience_invalid",
    },
    {
      name: "missing scope",
      claims: { aud: "meetings-client", scope: "openid profile email" },
      clientId: "meetings-client",
      status: 403,
      code: "oauth_scope_missing",
    },
    {
      name: "unconfigured client",
      claims: { aud: "meetings-client", scope: "openid profile email user:org:read" },
      clientId: null,
      status: 500,
      code: "oauth_client_unconfigured",
    },
  ])("rejects a Meetings request with $name", async ({ claims: tokenClaims, clientId, status, code }) => {
    const response = await createApp({ meetingsOAuthClientId: clientId }).request("/api/meetings", {
      headers: authorization(claims(tokenClaims)),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("accepts a Meetings OAuth token with its exact audience and required scopes", async () => {
    const response = await createApp().request("/api/meetings", {
      headers: authorization(claims({ aud: "meetings-client", scope: "openid profile email user:org:read" })),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: "workspace-a", userId: "user-a" });
  });

  it("rejects a Meetings OAuth token on non-Meetings endpoints", async () => {
    const response = await createApp().request("/api/connections", {
      headers: authorization(claims({ aud: "meetings-client", scope: "openid profile email user:org:read" })),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "oauth_scope_forbidden" } });
  });

  it("does not treat another Clerk audience as a Meetings token", async () => {
    const response = await createApp().request("/api/connections", {
      headers: authorization(claims({ aud: "connections-web-client" })),
    });

    expect(response.status).toBe(200);
  });

  it("does not treat a Meetings-like sibling path as the Meetings API", async () => {
    const response = await createApp().request("/api/meetingship", {
      headers: authorization(claims()),
    });

    expect(response.status).toBe(200);
  });

  it("rejects the exact Meetings API in optional-auth mode but allows its sibling path", async () => {
    const app = createApp({ optional: true });

    expect((await app.request("/api/meetings")).status).toBe(401);
    expect((await app.request("/api/meetings/meeting-a")).status).toBe(401);
    expect((await app.request("/api/meetingship")).status).toBe(200);
  });
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user-a",
    org_id: "org-a",
    org_role: "org:member",
    ...overrides,
  };
}

function authorization(tokenClaims: Record<string, unknown>): { authorization: string } {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(tokenClaims)).toString("base64url");
  return { authorization: `Bearer ${header}.${payload}.c2ln` };
}

function createApp(options: { optional?: boolean; meetingsOAuthClientId?: string | null } = {}): Hono {
  const workspace = {
    id: "workspace-a",
    clerkOrgId: "org-a",
    name: "Workspace A",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  const workspaceStore: IWorkspaceStore = {
    async getByClerkOrgId(clerkOrgId) {
      return clerkOrgId === workspace.clerkOrgId ? workspace : undefined;
    },
    async getById(id) {
      return id === workspace.id ? workspace : undefined;
    },
    async create() {},
    async updateName() {},
  };
  const membershipStore: IWorkspaceMembershipStore = {
    async getRole(workspaceId, userId) {
      return workspaceId === workspace.id && userId === "user-a" ? "member" : undefined;
    },
    async setRole() {},
    async listMembers() {
      return [];
    },
    async removeMember() {},
  };
  const app = new Hono();
  app.use(
    "*",
    createClerkAuthMiddleware({
      secretKey: "secret",
      publishableKey: "pk_test_example",
      workspaceStore,
      membershipStore,
      meetingsOAuthClientId:
        options.meetingsOAuthClientId === null ? undefined : (options.meetingsOAuthClientId ?? "meetings-client"),
      optional: options.optional,
    }),
  );
  app.get("/api/meetings", (context) => context.json(context.get("workspace")));
  app.get("/api/connections", (context) => context.json(context.get("workspace")));
  app.get("/api/meetingship", (context) => context.json(context.get("workspace")));
  app.onError((error, context) => {
    if (error instanceof HttpRequestError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    throw error;
  });
  return app;
}

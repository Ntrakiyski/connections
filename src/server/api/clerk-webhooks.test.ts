import type {
  IWorkspaceControlStore,
  IWorkspaceMembershipStore,
  IWorkspaceStore,
  Workspace,
} from "../storage/runtime-database.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "../storage/runtime-token-service.ts";

import { Hono } from "hono";
import { Webhook } from "svix";
import { describe, expect, it } from "vitest";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { registerClerkWebhookRoutes, mapClerkRole } from "./clerk-webhooks.ts";

describe("mapClerkRole", () => {
  it("maps Clerk organization roles to the Connections authorization roles", () => {
    expect(mapClerkRole("org:admin")).toBe("admin");
    expect(mapClerkRole("org:manager")).toBe("manager");
    expect(mapClerkRole("org:member")).toBe("member");
    expect(mapClerkRole("org:basic_member")).toBe("member");
  });

  it("synchronizes membership creation and revokes data access when Clerk removes a member", async () => {
    const workspaces = new MemoryWorkspaceStore();
    const memberships = new MemoryMembershipStore();
    const controls = new MemoryControlStore();
    const runtimeTokens = new RuntimeTokenService(new MemoryRuntimeTokenStore());
    const removedConnections: Array<{ workspaceId: string; userId: string }> = [];
    const app = new Hono();
    registerClerkWebhookRoutes(app, {
      signingSecret: signingSecret,
      workspaceStore: workspaces,
      membershipStore: memberships,
      workspaceControls: controls,
      runtimeTokens,
      removeMemberConnections: async (workspaceId, userId) => {
        removedConnections.push({ workspaceId, userId });
      },
    });

    const created = await app.request(
      signedWebhook({
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_1", name: "Workspace One" },
          public_user_data: { user_id: "user_1" },
          role: "org:manager",
        },
      }),
    );
    expect(created.status).toBe(200);
    const workspace = await workspaces.getByClerkOrgId("org_1");
    expect(workspace).toBeDefined();
    await expect(memberships.getRole(workspace!.id, "user_1")).resolves.toBe("manager");
    expect(controls.events).toMatchObject([{ event: "membership.synced", userId: "user_1" }]);

    const removed = await app.request(
      signedWebhook({
        type: "organizationMembership.deleted",
        data: {
          organization: { id: "org_1", name: "Workspace One" },
          public_user_data: { user_id: "user_1" },
          role: "org:manager",
        },
      }),
    );
    expect(removed.status).toBe(200);
    await expect(memberships.getRole(workspace!.id, "user_1")).resolves.toBeUndefined();
    expect(removedConnections).toEqual([{ workspaceId: workspace!.id, userId: "user_1" }]);
    expect(controls.events[0]).toMatchObject({ event: "membership.removed", userId: "user_1" });
  });
});

const signingSecret = "whsec_dGVzdC1zaWduaW5nLXNlY3JldC1mb3ItY2xlcms=";

function signedWebhook(event: Record<string, unknown>): Request {
  const payload = JSON.stringify(event);
  const id = "msg_test";
  const timestamp = new Date();
  const signature = new Webhook(signingSecret).sign(id, timestamp, payload);
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}

class MemoryWorkspaceStore implements IWorkspaceStore {
  private readonly workspaces = new Map<string, Workspace>();

  async getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined> {
    return [...this.workspaces.values()].find((workspace) => workspace.clerkOrgId === clerkOrgId);
  }

  async getById(id: string): Promise<Workspace | undefined> {
    return this.workspaces.get(id);
  }

  async create(workspace: Workspace): Promise<void> {
    this.workspaces.set(workspace.id, workspace);
  }
}

class MemoryMembershipStore implements IWorkspaceMembershipStore {
  private readonly roles = new Map<string, "member" | "manager" | "admin">();

  async getRole(workspaceId: string, userId: string): Promise<"member" | "manager" | "admin" | undefined> {
    return this.roles.get(`${workspaceId}:${userId}`);
  }

  async setRole(workspaceId: string, userId: string, role: "member" | "manager" | "admin"): Promise<void> {
    this.roles.set(`${workspaceId}:${userId}`, role);
  }

  async listMembers(): Promise<[]> {
    return [];
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.roles.delete(`${workspaceId}:${userId}`);
  }
}

class MemoryControlStore implements IWorkspaceControlStore {
  readonly events: Array<{ event: string; userId: string }> = [];

  async listProviders(): Promise<[]> {
    return [];
  }

  async enableProvider(): Promise<void> {}

  async disableProvider(): Promise<boolean> {
    return false;
  }

  async getActionPolicy(): Promise<undefined> {
    return undefined;
  }

  async setActionPolicy(): Promise<void> {}

  async addAuditEvent(event: { event: string; userId: string }): Promise<void> {
    this.events.unshift(event);
  }

  async listAuditEvents(): Promise<[]> {
    return [];
  }
}

class MemoryRuntimeTokenStore implements IRuntimeTokenStore {
  async add(): Promise<void> {}

  async list(): Promise<RuntimeTokenRecord[]> {
    return [];
  }

  async findByHash(): Promise<undefined> {
    return undefined;
  }

  async revoke(): Promise<boolean> {
    return false;
  }

  async revokeByUser(): Promise<void> {}

  async markUsed(): Promise<void> {}
}

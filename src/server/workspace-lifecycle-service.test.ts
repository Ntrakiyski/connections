import type {
  AuditEvent,
  IWorkspaceControlStore,
  IWorkspaceLifecycleStore,
  Workspace,
} from "./storage/runtime-database.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./storage/runtime-token-service.ts";

import { describe, expect, it } from "vitest";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { WorkspaceLifecycleError, WorkspaceLifecycleService } from "./workspace-lifecycle-service.ts";

describe("WorkspaceLifecycleService", () => {
  it("archives a confirmed admin workspace, revokes its tokens, and restores its encrypted data window", async () => {
    const workspaces = new MemoryLifecycleStore();
    const tokens = new MemoryTokenStore();
    const audits = new MemoryAuditStore();
    const service = new WorkspaceLifecycleService(
      workspaces,
      new RuntimeTokenService(tokens),
      audits,
      { workspaceId: "workspace-1", userId: "admin-1", role: "admin" },
      async () => workspaces.workspace,
    );

    await expect(service.archive("wrong name")).rejects.toBeInstanceOf(WorkspaceLifecycleError);
    await service.archive("Operations");

    expect(workspaces.workspace.deletedAt).toBeDefined();
    expect(workspaces.workspace.purgeAt).toBeDefined();
    expect(tokens.revokedWorkspaceIds).toEqual(["workspace-1"]);
    expect(audits.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: "workspace.deleted", resourceType: "workspace" })]),
    );

    await service.restore();
    expect(workspaces.workspace.deletedAt).toBeUndefined();
    expect(workspaces.workspace.purgeAt).toBeUndefined();
    expect(audits.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: "workspace.restored", resourceType: "workspace" })]),
    );
  });

  it("rejects deletion by a non-admin", async () => {
    const service = new WorkspaceLifecycleService(
      new MemoryLifecycleStore(),
      new RuntimeTokenService(new MemoryTokenStore()),
      new MemoryAuditStore(),
      { workspaceId: "workspace-1", userId: "member-1", role: "member" },
      async () => new MemoryLifecycleStore().workspace,
    );

    await expect(service.archive("Operations")).rejects.toMatchObject({ code: "workspace_forbidden" });
  });
});

class MemoryLifecycleStore implements IWorkspaceLifecycleStore {
  workspace: Workspace = {
    id: "workspace-1",
    clerkOrgId: "org_1",
    name: "Operations",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };

  async archive(workspaceId: string, deletedAt: string, purgeAt: string): Promise<boolean> {
    if (workspaceId !== this.workspace.id || this.workspace.deletedAt) return false;
    this.workspace = { ...this.workspace, deletedAt, purgeAt, updatedAt: deletedAt };
    return true;
  }

  async restore(workspaceId: string, restoredAt: string): Promise<boolean> {
    if (workspaceId !== this.workspace.id || !this.workspace.deletedAt) return false;
    this.workspace = { ...this.workspace, deletedAt: undefined, purgeAt: undefined, updatedAt: restoredAt };
    return true;
  }

  async purgeExpired(): Promise<string[]> {
    return [];
  }
}

class MemoryTokenStore implements IRuntimeTokenStore {
  readonly revokedWorkspaceIds: string[] = [];
  async add(_record: RuntimeTokenRecord): Promise<void> {}
  async list(): Promise<RuntimeTokenRecord[]> {
    return [];
  }
  async findByHash(): Promise<RuntimeTokenRecord | undefined> {
    return undefined;
  }
  async revoke(): Promise<boolean> {
    return false;
  }
  async revokeByUser(): Promise<void> {}
  async revokeByWorkspace(workspaceId: string): Promise<void> {
    this.revokedWorkspaceIds.push(workspaceId);
  }
  async markUsed(): Promise<void> {}
}

class MemoryAuditStore implements Pick<IWorkspaceControlStore, "addAuditEvent"> {
  readonly events: AuditEvent[] = [];
  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

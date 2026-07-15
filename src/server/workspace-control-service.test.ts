import type { ActionDefinition, ProviderDefinition } from "../core/types.ts";
import type {
  AuditEvent,
  IWorkspaceControlStore,
  WorkspaceActionPolicy,
  WorkspaceProvider,
} from "./storage/runtime-database.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { WorkspaceControlService } from "./workspace-control-service.ts";

const action: ActionDefinition = {
  id: "example.echo",
  service: "example",
  name: "echo",
  description: "Echo input.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

const provider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [action],
};

describe("WorkspaceControlService", () => {
  it("restricts provider configuration to managers and persists the approval policy with an audit event", async () => {
    const store = new MemoryWorkspaceControlStore();
    const catalog = createCatalogStore([provider], { executableActionIds: [action.id] });
    const member = new WorkspaceControlService(catalog, store, {
      workspaceId: "workspace-a",
      userId: "member-a",
      role: "member",
    });
    await expect(member.enableProvider(provider.service)).rejects.toMatchObject({ code: "forbidden" });

    const manager = new WorkspaceControlService(catalog, store, {
      workspaceId: "workspace-a",
      userId: "manager-a",
      role: "manager",
    });
    await expect(manager.enableProvider(provider.service)).resolves.toMatchObject({
      workspaceId: "workspace-a",
      service: provider.service,
      enabledBy: "manager-a",
    });
    await expect(manager.providers()).resolves.toMatchObject([{ service: provider.service }]);
    await expect(manager.setActionPolicy(action.id, false)).resolves.toMatchObject({ requireApproval: false });
    await expect(manager.getActionPolicy(catalog.actionsById.get(action.id)!)).resolves.toMatchObject({
      requireApproval: false,
      updatedBy: "manager-a",
    });
    await expect(manager.listAuditEvents()).resolves.toMatchObject([
      { event: "action_policy.updated", resourceId: action.id },
      { event: "provider.enabled", resourceId: provider.service },
    ]);
  });
});

class MemoryWorkspaceControlStore implements IWorkspaceControlStore {
  private readonly providers = new Map<string, WorkspaceProvider>();
  private readonly policies = new Map<string, WorkspaceActionPolicy>();
  private readonly auditEvents: AuditEvent[] = [];

  async listProviders(workspaceId: string): Promise<WorkspaceProvider[]> {
    return [...this.providers.values()].filter((provider) => provider.workspaceId === workspaceId);
  }

  async enableProvider(provider: WorkspaceProvider): Promise<void> {
    this.providers.set(`${provider.workspaceId}:${provider.service}`, provider);
  }

  async disableProvider(workspaceId: string, service: string): Promise<boolean> {
    return this.providers.delete(`${workspaceId}:${service}`);
  }

  async getActionPolicy(workspaceId: string, actionId: string): Promise<WorkspaceActionPolicy | undefined> {
    return this.policies.get(`${workspaceId}:${actionId}`);
  }

  async setActionPolicy(policy: WorkspaceActionPolicy): Promise<void> {
    this.policies.set(`${policy.workspaceId}:${policy.actionId}`, policy);
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.unshift(event);
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    return this.auditEvents.filter((event) => event.workspaceId === workspaceId).slice(0, limit);
  }
}

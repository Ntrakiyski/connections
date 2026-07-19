import type { ActionDefinition, ProviderDefinition } from "../core/types.ts";
import type {
  AuditEvent,
  IWorkspaceControlStore,
  WorkspaceActionPolicy,
  WorkspaceIdempotencyRecord,
  WorkspaceProvider,
  WorkspaceProviderSafetySettings,
  WorkspaceSafetySettings,
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

const createAction: ActionDefinition = {
  ...action,
  id: "example.create_record",
  name: "create record",
};

const readAction: ActionDefinition = {
  ...action,
  id: "example.read_record",
  name: "read record",
};

const deleteAction: ActionDefinition = {
  ...action,
  id: "example.delete_record",
  name: "delete record",
};

const updateAction: ActionDefinition = {
  ...action,
  id: "example.update_record",
  name: "update record",
};

const moveAction: ActionDefinition = {
  ...action,
  id: "example.move_record",
  name: "move record",
};

const additionalMutationActions = ["send", "add", "remove", "submit", "upload", "archive", "revoke", "transfer"].map(
  (verb) => ({
    ...action,
    id: `example.${verb}_record`,
    name: `${verb} record`,
  }),
);

const camelCaseMutationAction: ActionDefinition = {
  ...action,
  id: "example.notification",
  name: "sendEmail",
};

const provider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [
    createAction,
    deleteAction,
    updateAction,
    moveAction,
    ...additionalMutationActions,
    camelCaseMutationAction,
    readAction,
  ],
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
    await expect(manager.getActionPolicy(catalog.actionsById.get(createAction.id)!)).resolves.toMatchObject({
      requireApproval: true,
    });
    await expect(manager.getActionPolicy(catalog.actionsById.get(deleteAction.id)!)).resolves.toMatchObject({
      requireApproval: true,
    });
    await expect(manager.getActionPolicy(catalog.actionsById.get(updateAction.id)!)).resolves.toMatchObject({
      requireApproval: true,
    });
    await expect(manager.getActionPolicy(catalog.actionsById.get(moveAction.id)!)).resolves.toMatchObject({
      requireApproval: true,
    });
    for (const additionalMutationAction of additionalMutationActions) {
      await expect(
        manager.getActionPolicy(catalog.actionsById.get(additionalMutationAction.id)!),
      ).resolves.toMatchObject({
        requireApproval: true,
      });
    }
    await expect(manager.getActionPolicy(catalog.actionsById.get(camelCaseMutationAction.id)!)).resolves.toMatchObject({
      requireApproval: true,
    });
    await expect(manager.getActionPolicy(catalog.actionsById.get(readAction.id)!)).resolves.toMatchObject({
      requireApproval: false,
    });
    await expect(manager.setActionPolicy(createAction.id, false)).resolves.toMatchObject({ requireApproval: false });
    await expect(manager.getActionPolicy(catalog.actionsById.get(createAction.id)!)).resolves.toMatchObject({
      requireApproval: false,
      updatedBy: "manager-a",
    });
    await expect(manager.listAuditEvents()).resolves.toMatchObject([
      { event: "action_policy.updated", resourceId: createAction.id },
      { event: "provider.enabled", resourceId: provider.service },
    ]);
  });
});

class MemoryWorkspaceControlStore implements IWorkspaceControlStore {
  private readonly providers = new Map<string, WorkspaceProvider>();
  private readonly policies = new Map<string, WorkspaceActionPolicy>();
  private readonly workspaceSafety = new Map<string, WorkspaceSafetySettings>();
  private readonly providerSafety = new Map<string, WorkspaceProviderSafetySettings>();
  private readonly idempotencyRecords = new Map<string, WorkspaceIdempotencyRecord>();
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

  async getWorkspaceSafetySettings(workspaceId: string): Promise<WorkspaceSafetySettings | undefined> {
    return this.workspaceSafety.get(workspaceId);
  }

  async setWorkspaceSafetySettings(settings: WorkspaceSafetySettings): Promise<void> {
    this.workspaceSafety.set(settings.workspaceId, settings);
  }

  async getProviderSafetySettings(
    workspaceId: string,
    service: string,
  ): Promise<WorkspaceProviderSafetySettings | undefined> {
    return this.providerSafety.get(`${workspaceId}:${service}`);
  }

  async setProviderSafetySettings(settings: WorkspaceProviderSafetySettings): Promise<void> {
    this.providerSafety.set(`${settings.workspaceId}:${settings.service}`, settings);
  }

  async getIdempotencyRecord(
    workspaceId: string,
    actionId: string,
    connectionName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceIdempotencyRecord | undefined> {
    return this.idempotencyRecords.get(`${workspaceId}:${actionId}:${connectionName}:${idempotencyKey}`);
  }

  async setIdempotencyRecord(record: WorkspaceIdempotencyRecord): Promise<void> {
    this.idempotencyRecords.set(
      `${record.workspaceId}:${record.actionId}:${record.connectionName}:${record.idempotencyKey}`,
      record,
    );
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.unshift(event);
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    return this.auditEvents.filter((event) => event.workspaceId === workspaceId).slice(0, limit);
  }
}

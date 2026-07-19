import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ResolvedProviderSafetyConfig } from "../core/action-safety.ts";
import type { ProviderDefinition } from "../core/types.ts";
import type {
  AuditEvent,
  IWorkspaceControlStore,
  WorkspaceActionPolicy,
  WorkspaceIdempotencyRecord,
  WorkspaceProvider,
} from "./storage/runtime-database.ts";
import type { WorkspaceContext } from "./storage/runtime-token-service.ts";

import { normalizeSafetyConfigPatch, resolveWorkspaceSafetyConfig } from "../core/action-safety.ts";
import { HttpRequestError } from "./api/http-utils.ts";

const defaultApprovalVerbs = new Set([
  "acknowledge",
  "activate",
  "add",
  "append",
  "apply",
  "approve",
  "archive",
  "assign",
  "attach",
  "ban",
  "cancel",
  "change",
  "clear",
  "close",
  "copy",
  "create",
  "deactivate",
  "decline",
  "delete",
  "detach",
  "disable",
  "edit",
  "enable",
  "execute",
  "export",
  "forward",
  "import",
  "insert",
  "mark",
  "merge",
  "modify",
  "move",
  "mute",
  "patch",
  "pin",
  "post",
  "publish",
  "purge",
  "put",
  "remove",
  "rename",
  "replace",
  "reply",
  "reset",
  "restore",
  "revoke",
  "rollback",
  "save",
  "schedule",
  "send",
  "set",
  "share",
  "start",
  "stop",
  "submit",
  "suspend",
  "tag",
  "toggle",
  "transfer",
  "trigger",
  "unarchive",
  "unassign",
  "unban",
  "unfollow",
  "unlock",
  "unmute",
  "unpin",
  "untrash",
  "update",
  "upload",
  "upsert",
  "void",
  "write",
]);

export class WorkspaceControlService {
  private readonly catalog: CatalogStore;
  private readonly store: IWorkspaceControlStore;
  private readonly workspace: WorkspaceContext;

  constructor(catalog: CatalogStore, store: IWorkspaceControlStore, workspace: WorkspaceContext) {
    this.catalog = catalog;
    this.store = store;
    this.workspace = workspace;
  }

  async providers(): Promise<ProviderDefinition[]> {
    if (this.isLocalDefaultWorkspace()) return this.catalog.providers;
    const enabled = new Set(
      (await this.store.listProviders(this.workspace.workspaceId)).map((provider) => provider.service),
    );
    return this.catalog.providers.filter((provider) => enabled.has(provider.service));
  }

  async isProviderEnabled(service: string): Promise<boolean> {
    if (this.isLocalDefaultWorkspace()) return this.catalog.providers.some((provider) => provider.service === service);
    return (await this.store.listProviders(this.workspace.workspaceId)).some(
      (provider) => provider.service === service,
    );
  }

  async assertProviderEnabled(service: string): Promise<void> {
    if (!(await this.isProviderEnabled(service))) {
      throw new HttpRequestError("provider_disabled", `Provider ${service} is not enabled for this workspace.`, 403);
    }
  }

  async enableProvider(service: string): Promise<WorkspaceProvider> {
    this.requireManager();
    if (!this.catalog.providers.some((provider) => provider.service === service)) {
      throw new HttpRequestError("unknown_service", `Unknown provider: ${service}.`, 404);
    }
    const provider = {
      workspaceId: this.workspace.workspaceId,
      service,
      enabledBy: this.workspace.userId,
      enabledAt: new Date().toISOString(),
    };
    if (this.isLocalDefaultWorkspace()) return provider;
    await this.store.enableProvider(provider);
    await this.audit("provider.enabled", "provider", service);
    return provider;
  }

  async disableProvider(service: string): Promise<boolean> {
    this.requireManager();
    if (this.isLocalDefaultWorkspace()) return false;
    const disabled = await this.store.disableProvider(this.workspace.workspaceId, service);
    if (disabled) await this.audit("provider.disabled", "provider", service);
    return disabled;
  }

  async getActionPolicy(action: RuntimeActionDefinition): Promise<WorkspaceActionPolicy> {
    if (this.isLocalDefaultWorkspace()) {
      return this.defaultActionPolicy(action.id);
    }
    const existing = await this.store.getActionPolicy(this.workspace.workspaceId, action.id);
    return existing ?? this.defaultActionPolicy(action.id);
  }

  async setActionPolicy(actionId: string, requireApproval: boolean): Promise<WorkspaceActionPolicy> {
    this.requireManager();
    const action = this.catalog.actionsById.get(actionId);
    if (!action) throw new HttpRequestError("unknown_action", `Unknown action: ${actionId}.`, 404);
    await this.assertProviderEnabled(action.service);
    const policy = {
      workspaceId: this.workspace.workspaceId,
      actionId,
      requireApproval,
      updatedBy: this.workspace.userId,
      updatedAt: new Date().toISOString(),
    };
    if (this.isLocalDefaultWorkspace()) return policy;
    await this.store.setActionPolicy(policy);
    await this.audit("action_policy.updated", "action", actionId, { requireApproval });
    return policy;
  }

  async getWorkspaceSafetyConfig(): Promise<ResolvedProviderSafetyConfig> {
    const settings = await this.store.getWorkspaceSafetySettings(this.workspace.workspaceId);
    return resolveWorkspaceSafetyConfig(settings?.value, undefined);
  }

  async setWorkspaceSafetyConfig(value: unknown): Promise<ResolvedProviderSafetyConfig> {
    this.requireManager();
    const patch = normalizeSafetyConfigPatch(value);
    await this.store.setWorkspaceSafetySettings({
      workspaceId: this.workspace.workspaceId,
      value: patch,
      updatedBy: this.workspace.userId,
      updatedAt: new Date().toISOString(),
    });
    await this.audit("safety_config.updated", "workspace", this.workspace.workspaceId, { value: patch });
    return resolveWorkspaceSafetyConfig(patch, undefined);
  }

  async getProviderSafetyConfig(service: string): Promise<ResolvedProviderSafetyConfig> {
    if (!this.catalog.providers.some((provider) => provider.service === service)) {
      throw new HttpRequestError("unknown_service", `Unknown provider: ${service}.`, 404);
    }
    await this.assertProviderEnabled(service);
    const workspaceSettings = await this.store.getWorkspaceSafetySettings(this.workspace.workspaceId);
    const providerSettings = await this.store.getProviderSafetySettings(this.workspace.workspaceId, service);
    return resolveWorkspaceSafetyConfig(workspaceSettings?.value, providerSettings?.value);
  }

  async setProviderSafetyConfig(service: string, value: unknown): Promise<ResolvedProviderSafetyConfig> {
    this.requireManager();
    if (!this.catalog.providers.some((provider) => provider.service === service)) {
      throw new HttpRequestError("unknown_service", `Unknown provider: ${service}.`, 404);
    }
    await this.assertProviderEnabled(service);
    const patch = normalizeSafetyConfigPatch(value);
    await this.store.setProviderSafetySettings({
      workspaceId: this.workspace.workspaceId,
      service,
      value: patch,
      updatedBy: this.workspace.userId,
      updatedAt: new Date().toISOString(),
    });
    await this.audit("safety_config.updated", "provider", service, { value: patch });
    const workspaceSettings = await this.store.getWorkspaceSafetySettings(this.workspace.workspaceId);
    return resolveWorkspaceSafetyConfig(workspaceSettings?.value, patch);
  }

  async getIdempotencyRecord(
    actionId: string,
    connectionName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceIdempotencyRecord | undefined> {
    return await this.store.getIdempotencyRecord(this.workspace.workspaceId, actionId, connectionName, idempotencyKey);
  }

  async setIdempotencyRecord(input: {
    actionId: string;
    connectionName: string;
    idempotencyKey: string;
    inputHash: string;
    executionId: string;
    result: unknown;
  }): Promise<void> {
    await this.store.setIdempotencyRecord({
      workspaceId: this.workspace.workspaceId,
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  async audit(
    event: string,
    resourceType: string,
    resourceId?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (this.isLocalDefaultWorkspace()) return;
    await this.store.addAuditEvent({
      id: crypto.randomUUID(),
      workspaceId: this.workspace.workspaceId,
      userId: this.workspace.userId,
      event,
      resourceType,
      resourceId,
      details,
      createdAt: new Date().toISOString(),
    });
  }

  async listAuditEvents(limit = 100): Promise<AuditEvent[]> {
    this.requireManager();
    return await this.store.listAuditEvents(this.workspace.workspaceId, Math.min(Math.max(limit, 1), 100));
  }

  private requireManager(): void {
    if (this.workspace.role === "member") {
      throw new HttpRequestError("forbidden", "Manager role required.", 403);
    }
  }

  /** The unauthenticated local runtime remains fully available for OSS users. */
  private isLocalDefaultWorkspace(): boolean {
    return this.workspace.workspaceId === "default";
  }

  private defaultActionPolicy(actionId: string): WorkspaceActionPolicy {
    const action = this.catalog.actionsById.get(actionId);
    return {
      workspaceId: this.workspace.workspaceId,
      actionId,
      requireApproval: action ? actionRequiresApprovalByDefault(action) : false,
      updatedBy: "",
      updatedAt: "",
    };
  }
}

function actionRequiresApprovalByDefault(action: RuntimeActionDefinition): boolean {
  const words = `${action.id} ${action.name}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/);
  return words.some((word) => defaultApprovalVerbs.has(word));
}

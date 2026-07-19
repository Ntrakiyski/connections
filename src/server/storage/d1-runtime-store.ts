import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type {
  IWorkspaceMembershipStore,
  IWorkspaceControlStore,
  IWorkspaceStore,
  IWorkspaceLifecycleStore,
  RuntimeDatabase,
  Workspace,
  WorkspaceActionPolicy,
  WorkspaceIdempotencyRecord,
  WorkspaceProvider,
  WorkspaceProviderSafetySettings,
  WorkspaceSafetySettings,
  AuditEvent,
  WorkspaceMember,
  WorkspaceScopedStores,
} from "./runtime-database.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord, WorkspaceRole } from "./runtime-token-service.ts";

import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;

export interface D1RuntimeDatabaseOptions {
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

/** D1 implementation of the same workspace-scoped runtime store contract as SQLite. */
export class D1RuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: D1ConnectionStore;
  readonly oauthClientConfigStore: D1OAuthClientConfigStore;
  readonly oauthStateStore: D1OAuthStateStore;
  readonly runtimeTokenStore: D1RuntimeTokenStore;
  readonly runLogStore: D1RunLogStore;
  readonly workspaceStore: D1WorkspaceStore;
  readonly workspaceLifecycleStore: D1WorkspaceLifecycleStore;
  readonly membershipStore: D1WorkspaceMembershipStore;
  readonly workspaceControlStore: D1WorkspaceControlStore;

  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;
  private readonly runLimit: number;

  constructor(database: D1DatabaseBinding, options: D1RuntimeDatabaseOptions = {}) {
    this.database = database;
    this.secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.runLimit = options.runLimit ?? 100;
    const defaults = this.createScopedStores("default");
    this.connectionStore = defaults.connectionStore as D1ConnectionStore;
    this.oauthClientConfigStore = defaults.oauthClientConfigStore as D1OAuthClientConfigStore;
    this.oauthStateStore = defaults.oauthStateStore as D1OAuthStateStore;
    this.runLogStore = defaults.runLogStore as D1RunLogStore;
    this.runtimeTokenStore = new D1RuntimeTokenStore(database);
    this.workspaceStore = new D1WorkspaceStore(database);
    this.workspaceLifecycleStore = new D1WorkspaceLifecycleStore(database);
    this.membershipStore = new D1WorkspaceMembershipStore(database);
    this.workspaceControlStore = new D1WorkspaceControlStore(database);
  }

  createScopedStores(workspaceId: string): WorkspaceScopedStores {
    return {
      connectionStore: new D1ConnectionStore(this.database, this.secretCodec, workspaceId),
      oauthClientConfigStore: new D1OAuthClientConfigStore(this.database, this.secretCodec, workspaceId),
      oauthStateStore: new D1OAuthStateStore(this.database, workspaceId),
      runtimeTokenStore: new D1RuntimeTokenStore(this.database, workspaceId),
      runLogStore: new D1RunLogStore(this.database, workspaceId, this.runLimit),
    };
  }
}

export class D1ConnectionStore implements IConnectionStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;
  private readonly workspaceId: string;
  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec, workspaceId: string) {
    this.database = database;
    this.secretCodec = secretCodec;
    this.workspaceId = workspaceId;
  }

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    return (await this.getStored(service, connectionName))?.credential;
  }

  async getStored(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = await this.database
      .prepare(
        "select service, connection_name, value, created_by from connections where workspace_id = ? and service = ? and connection_name = ?",
      )
      .bind(this.workspaceId, service, connectionName)
      .first<RuntimeRow>();
    return row
      ? {
          service: readString(row, "service"),
          connectionName: readString(row, "connection_name"),
          credential: parseJson(await this.secretCodec.decode(readString(row, "value"))),
          createdBy: readString(row, "created_by"),
        }
      : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential, createdBy = ""): Promise<void> {
    await this.database
      .prepare(
        `
          insert into connections (workspace_id, service, connection_name, label, value, created_by, updated_at)
          values (?, ?, ?, '', ?, ?, ?)
          on conflict(workspace_id, service, connection_name) do update set
            value = excluded.value,
            created_by = case when connections.created_by = '' then excluded.created_by else connections.created_by end,
            updated_at = excluded.updated_at
        `,
      )
      .bind(
        this.workspaceId,
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        createdBy,
        new Date().toISOString(),
      )
      .run();
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.database
      .prepare("delete from connections where workspace_id = ? and service = ? and connection_name = ?")
      .bind(this.workspaceId, service, connectionName)
      .run();
  }

  async deleteByOwner(userId: string): Promise<void> {
    await this.database
      .prepare("delete from connections where workspace_id = ? and created_by = ?")
      .bind(this.workspaceId, userId)
      .run();
  }

  async list(): Promise<StoredConnection[]> {
    const { results } = await this.database
      .prepare(
        "select service, connection_name, value, created_by from connections where workspace_id = ? order by service, connection_name",
      )
      .bind(this.workspaceId)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => ({
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson(await this.secretCodec.decode(readString(row, "value"))),
        createdBy: readString(row, "created_by"),
      })),
    );
  }
}

export class D1OAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;
  private readonly workspaceId: string;
  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec, workspaceId: string) {
    this.database = database;
    this.secretCodec = secretCodec;
    this.workspaceId = workspaceId;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    const row = await this.database
      .prepare("select value from oauth_client_configs where workspace_id = ? and service = ?")
      .bind(this.workspaceId, service)
      .first<RuntimeRow>();
    return row ? parseJson(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.database
      .prepare(
        `
          insert into oauth_client_configs (workspace_id, service, value, created_by, updated_at)
          values (?, ?, ?, '', ?)
          on conflict(workspace_id, service) do update set value = excluded.value, updated_at = excluded.updated_at
        `,
      )
      .bind(
        this.workspaceId,
        config.service,
        await this.secretCodec.encode(JSON.stringify(config)),
        new Date().toISOString(),
      )
      .run();
  }

  async delete(service: string): Promise<void> {
    await this.database
      .prepare("delete from oauth_client_configs where workspace_id = ? and service = ?")
      .bind(this.workspaceId, service)
      .run();
  }

  async list(): Promise<OAuthClientConfig[]> {
    const { results } = await this.database
      .prepare("select value from oauth_client_configs where workspace_id = ? order by service")
      .bind(this.workspaceId)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class D1OAuthStateStore implements IOAuthStateStore {
  private readonly database: D1DatabaseBinding;
  private readonly workspaceId: string;
  constructor(database: D1DatabaseBinding, workspaceId: string) {
    this.database = database;
    this.workspaceId = workspaceId;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    await this.database
      .prepare(
        `
          insert into oauth_states (workspace_id, state, value, created_at)
          values (?, ?, ?, ?)
          on conflict(workspace_id, state) do update set value = excluded.value, created_at = excluded.created_at
        `,
      )
      .bind(this.workspaceId, state.state, JSON.stringify(state), state.createdAt)
      .run();
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = await this.database
      .prepare("delete from oauth_states where workspace_id = ? and state = ? returning value")
      .bind(this.workspaceId, state)
      .first<RuntimeRow>();
    return row ? parseJson(readString(row, "value")) : undefined;
  }
}

export class D1RuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: D1DatabaseBinding;
  private readonly workspaceId: string | undefined;
  constructor(database: D1DatabaseBinding, workspaceId?: string) {
    this.database = database;
    this.workspaceId = workspaceId;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.assertWorkspace(record.workspaceId);
    await this.database
      .prepare(
        "insert into runtime_tokens (id, workspace_id, user_id, name, token_hash, created_at, last_used_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.id,
        record.workspaceId,
        record.userId,
        record.name,
        record.tokenHash,
        record.createdAt,
        record.lastUsedAt ?? null,
      )
      .run();
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const statement = this.workspaceId
      ? this.database
          .prepare(
            "select id, workspace_id, user_id, name, token_hash, created_at, last_used_at from runtime_tokens where workspace_id = ? and revoked_at is null order by created_at desc, id desc",
          )
          .bind(this.workspaceId)
      : this.database.prepare(
          "select id, workspace_id, user_id, name, token_hash, created_at, last_used_at from runtime_tokens where revoked_at is null order by created_at desc, id desc",
        );
    const { results } = await statement.all<RuntimeRow>();
    return results.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        "select id, workspace_id, user_id, name, token_hash, created_at, last_used_at from runtime_tokens where token_hash = ? and revoked_at is null",
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    const record = row ? readRuntimeTokenRow(row) : undefined;
    return record && (!this.workspaceId || record.workspaceId === this.workspaceId) ? record : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = this.workspaceId
      ? await this.database
          .prepare("delete from runtime_tokens where workspace_id = ? and id = ?")
          .bind(this.workspaceId, id)
          .run()
      : await this.database.prepare("delete from runtime_tokens where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async revokeByUser(workspaceId: string, userId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.database
      .prepare("update runtime_tokens set revoked_at = ? where workspace_id = ? and user_id = ? and revoked_at is null")
      .bind(new Date().toISOString(), workspaceId, userId)
      .run();
  }

  async revokeByWorkspace(workspaceId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.database
      .prepare("update runtime_tokens set revoked_at = ? where workspace_id = ? and revoked_at is null")
      .bind(new Date().toISOString(), workspaceId)
      .run();
  }

  async markUsed(id: string, workspaceId: string, usedAt: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.database
      .prepare("update runtime_tokens set last_used_at = ? where workspace_id = ? and id = ? and revoked_at is null")
      .bind(usedAt, workspaceId, id)
      .run();
  }

  private assertWorkspace(workspaceId: string): void {
    if (this.workspaceId && this.workspaceId !== workspaceId) {
      throw new Error("Runtime token workspace does not match its scoped store.");
    }
  }
}

export class D1RunLogStore implements IRunLogStore {
  private readonly database: D1DatabaseBinding;
  private readonly workspaceId: string;
  private readonly limit: number;
  constructor(database: D1DatabaseBinding, workspaceId: string, limit: number) {
    this.database = database;
    this.workspaceId = workspaceId;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<void> {
    if (run.workspaceId !== this.workspaceId) {
      throw new Error("Run workspace does not match its scoped store.");
    }
    await this.database
      .prepare(
        `
          insert into runs (id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(workspace_id, id) do update set user_id = excluded.user_id, service = excluded.service,
            action_id = excluded.action_id, started_at = excluded.started_at, completed_at = excluded.completed_at,
            ok = excluded.ok, value = excluded.value
        `,
      )
      .bind(
        run.id,
        this.workspaceId,
        run.userId,
        run.service,
        run.actionId,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      )
      .run();
    await this.database
      .prepare(
        "delete from runs where workspace_id = ? and id in (select id from runs where workspace_id = ? order by started_at desc, id desc limit -1 offset ?)",
      )
      .bind(this.workspaceId, this.workspaceId, this.limit)
      .run();
  }

  async list(input: RunLogListInput = {}): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const filters = ["workspace_id = ?"];
    const values: unknown[] = [this.workspaceId];
    if (input.service) {
      filters.push("service = ?");
      values.push(input.service);
    }
    if (input.userId) {
      filters.push("user_id = ?");
      values.push(input.userId);
    }
    if (cursor) {
      filters.push("(started_at < ? or (started_at = ? and id < ?))");
      values.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }
    values.push(limit + 1);
    const { results } = await this.database
      .prepare(
        `select service, value from runs where ${filters.join(" and ")} order by started_at desc, id desc limit ?`,
      )
      .bind(...values)
      .all<RuntimeRow>();
    const runs = results.map(readRunLogRow);
    const items = runs.slice(0, limit);
    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

class D1WorkspaceStore implements IWorkspaceStore {
  private readonly database: D1DatabaseBinding;
  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined> {
    const row = await this.database
      .prepare(
        "select id, clerk_org_id, name, created_at, updated_at, deleted_at, purge_at from workspaces where clerk_org_id = ?",
      )
      .bind(clerkOrgId)
      .first<RuntimeRow>();
    return row ? readWorkspace(row) : undefined;
  }

  async getById(id: string): Promise<Workspace | undefined> {
    const row = await this.database
      .prepare(
        "select id, clerk_org_id, name, created_at, updated_at, deleted_at, purge_at from workspaces where id = ?",
      )
      .bind(id)
      .first<RuntimeRow>();
    return row ? readWorkspace(row) : undefined;
  }

  async create(workspace: Workspace): Promise<void> {
    await this.database
      .prepare("insert into workspaces (id, clerk_org_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .bind(workspace.id, workspace.clerkOrgId, workspace.name, workspace.createdAt, workspace.updatedAt)
      .run();
  }

  async updateName(workspaceId: string, name: string, updatedAt: string): Promise<void> {
    await this.database
      .prepare("update workspaces set name = ?, updated_at = ? where id = ?")
      .bind(name, updatedAt, workspaceId)
      .run();
  }
}

class D1WorkspaceLifecycleStore implements IWorkspaceLifecycleStore {
  private readonly database: D1DatabaseBinding;
  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async archive(workspaceId: string, deletedAt: string, purgeAt: string): Promise<boolean> {
    const result = await this.database
      .prepare("update workspaces set deleted_at = ?, purge_at = ?, updated_at = ? where id = ? and deleted_at is null")
      .bind(deletedAt, purgeAt, deletedAt, workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async restore(workspaceId: string, restoredAt: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "update workspaces set deleted_at = null, purge_at = null, updated_at = ? where id = ? and deleted_at is not null",
      )
      .bind(restoredAt, workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async purgeExpired(now: string): Promise<string[]> {
    const { results } = await this.database
      .prepare("select id from workspaces where purge_at is not null and purge_at <= ?")
      .bind(now)
      .all<RuntimeRow>();
    const workspaceIds = results.map((row) => readString(row, "id"));
    for (const workspaceId of workspaceIds) {
      for (const table of [
        "connections",
        "oauth_client_configs",
        "oauth_states",
        "runtime_tokens",
        "runs",
        "audit_events",
        "workspace_providers",
        "workspace_action_policies",
        "workspace_memberships",
      ]) {
        await this.database.prepare(`delete from ${table} where workspace_id = ?`).bind(workspaceId).run();
      }
      await this.database.prepare("delete from workspaces where id = ?").bind(workspaceId).run();
    }
    return workspaceIds;
  }
}

class D1WorkspaceMembershipStore implements IWorkspaceMembershipStore {
  private readonly database: D1DatabaseBinding;
  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
    const row = await this.database
      .prepare("select role from workspace_memberships where workspace_id = ? and user_id = ?")
      .bind(workspaceId, userId)
      .first<RuntimeRow>();
    return row ? readWorkspaceRole(row) : undefined;
  }

  async setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const now = new Date().toISOString();
    await this.database
      .prepare(
        "insert into workspace_memberships (workspace_id, user_id, role, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(workspace_id, user_id) do update set role = excluded.role, updated_at = excluded.updated_at",
      )
      .bind(workspaceId, userId, role, now, now)
      .run();
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const { results } = await this.database
      .prepare(
        "select workspace_id, user_id, role, created_at, updated_at from workspace_memberships where workspace_id = ?",
      )
      .bind(workspaceId)
      .all<RuntimeRow>();
    return results.map(readWorkspaceMember);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.database
      .prepare("delete from workspace_memberships where workspace_id = ? and user_id = ?")
      .bind(workspaceId, userId)
      .run();
  }
}

class D1WorkspaceControlStore implements IWorkspaceControlStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async listProviders(workspaceId: string): Promise<WorkspaceProvider[]> {
    const { results } = await this.database
      .prepare(
        "select workspace_id, service, enabled_by, enabled_at from workspace_providers where workspace_id = ? order by service",
      )
      .bind(workspaceId)
      .all<RuntimeRow>();
    return results.map((row) => ({
      workspaceId: readString(row, "workspace_id"),
      service: readString(row, "service"),
      enabledBy: readString(row, "enabled_by"),
      enabledAt: readString(row, "enabled_at"),
    }));
  }

  async enableProvider(provider: WorkspaceProvider): Promise<void> {
    await this.database
      .prepare(
        "insert into workspace_providers (workspace_id, service, enabled_by, enabled_at) values (?, ?, ?, ?) on conflict(workspace_id, service) do nothing",
      )
      .bind(provider.workspaceId, provider.service, provider.enabledBy, provider.enabledAt)
      .run();
  }

  async disableProvider(workspaceId: string, service: string): Promise<boolean> {
    const result = await this.database
      .prepare("delete from workspace_providers where workspace_id = ? and service = ?")
      .bind(workspaceId, service)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getActionPolicy(workspaceId: string, actionId: string): Promise<WorkspaceActionPolicy | undefined> {
    const row = await this.database
      .prepare(
        "select workspace_id, action_id, require_approval, updated_by, updated_at from workspace_action_policies where workspace_id = ? and action_id = ?",
      )
      .bind(workspaceId, actionId)
      .first<RuntimeRow>();
    return row
      ? {
          workspaceId: readString(row, "workspace_id"),
          actionId: readString(row, "action_id"),
          requireApproval: readNumber(row, "require_approval") === 1,
          updatedBy: readString(row, "updated_by"),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async setActionPolicy(policy: WorkspaceActionPolicy): Promise<void> {
    await this.database
      .prepare(
        "insert into workspace_action_policies (workspace_id, action_id, require_approval, updated_by, updated_at) values (?, ?, ?, ?, ?) on conflict(workspace_id, action_id) do update set require_approval = excluded.require_approval, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .bind(policy.workspaceId, policy.actionId, policy.requireApproval ? 1 : 0, policy.updatedBy, policy.updatedAt)
      .run();
  }

  async getWorkspaceSafetySettings(workspaceId: string): Promise<WorkspaceSafetySettings | undefined> {
    const row = await this.database
      .prepare(
        "select workspace_id, value, updated_by, updated_at from workspace_safety_settings where workspace_id = ?",
      )
      .bind(workspaceId)
      .first<RuntimeRow>();
    return row
      ? {
          workspaceId: readString(row, "workspace_id"),
          value: parseJson(readString(row, "value")),
          updatedBy: readString(row, "updated_by"),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async setWorkspaceSafetySettings(settings: WorkspaceSafetySettings): Promise<void> {
    await this.database
      .prepare(
        "insert into workspace_safety_settings (workspace_id, value, updated_by, updated_at) values (?, ?, ?, ?) on conflict(workspace_id) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .bind(settings.workspaceId, JSON.stringify(settings.value), settings.updatedBy, settings.updatedAt)
      .run();
  }

  async getProviderSafetySettings(
    workspaceId: string,
    service: string,
  ): Promise<WorkspaceProviderSafetySettings | undefined> {
    const row = await this.database
      .prepare(
        "select workspace_id, service, value, updated_by, updated_at from workspace_provider_safety_settings where workspace_id = ? and service = ?",
      )
      .bind(workspaceId, service)
      .first<RuntimeRow>();
    return row
      ? {
          workspaceId: readString(row, "workspace_id"),
          service: readString(row, "service"),
          value: parseJson(readString(row, "value")),
          updatedBy: readString(row, "updated_by"),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async setProviderSafetySettings(settings: WorkspaceProviderSafetySettings): Promise<void> {
    await this.database
      .prepare(
        "insert into workspace_provider_safety_settings (workspace_id, service, value, updated_by, updated_at) values (?, ?, ?, ?, ?) on conflict(workspace_id, service) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .bind(
        settings.workspaceId,
        settings.service,
        JSON.stringify(settings.value),
        settings.updatedBy,
        settings.updatedAt,
      )
      .run();
  }

  async getIdempotencyRecord(
    workspaceId: string,
    actionId: string,
    connectionName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceIdempotencyRecord | undefined> {
    const row = await this.database
      .prepare(
        "select workspace_id, action_id, connection_name, idempotency_key, input_hash, execution_id, result, created_at from workspace_idempotency_records where workspace_id = ? and action_id = ? and connection_name = ? and idempotency_key = ?",
      )
      .bind(workspaceId, actionId, connectionName, idempotencyKey)
      .first<RuntimeRow>();
    return row
      ? {
          workspaceId: readString(row, "workspace_id"),
          actionId: readString(row, "action_id"),
          connectionName: readString(row, "connection_name"),
          idempotencyKey: readString(row, "idempotency_key"),
          inputHash: readString(row, "input_hash"),
          executionId: readString(row, "execution_id"),
          result: parseJson(readString(row, "result")),
          createdAt: readString(row, "created_at"),
        }
      : undefined;
  }

  async setIdempotencyRecord(record: WorkspaceIdempotencyRecord): Promise<void> {
    await this.database
      .prepare(
        "insert into workspace_idempotency_records (workspace_id, action_id, connection_name, idempotency_key, input_hash, execution_id, result, created_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(workspace_id, action_id, connection_name, idempotency_key) do nothing",
      )
      .bind(
        record.workspaceId,
        record.actionId,
        record.connectionName,
        record.idempotencyKey,
        record.inputHash,
        record.executionId,
        JSON.stringify(record.result),
        record.createdAt,
      )
      .run();
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    await this.database
      .prepare(
        "insert into audit_events (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        event.id,
        event.workspaceId,
        event.userId,
        event.event,
        event.resourceType,
        event.resourceId ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.createdAt,
      )
      .run();
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    const { results } = await this.database
      .prepare(
        "select id, workspace_id, user_id, event, resource_type, resource_id, details, created_at from audit_events where workspace_id = ? order by created_at desc, id desc limit ?",
      )
      .bind(workspaceId, limit)
      .all<RuntimeRow>();
    return results.map((row) => ({
      id: readString(row, "id"),
      workspaceId: readString(row, "workspace_id"),
      userId: readString(row, "user_id"),
      event: readString(row, "event"),
      resourceType: readString(row, "resource_type"),
      resourceId: readOptionalString(row, "resource_id"),
      details: readJsonRecord(row, "details"),
      createdAt: readString(row, "created_at"),
    }));
  }
}

function readRuntimeTokenRow(row: RuntimeRow): RuntimeTokenRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    userId: readString(row, "user_id"),
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

function readRunLogRow(row: RuntimeRow): RunLog {
  return { ...parseJson<RunLog>(readString(row, "value")), service: readString(row, "service") };
}

function readWorkspace(row: RuntimeRow): Workspace {
  return {
    id: readString(row, "id"),
    clerkOrgId: readString(row, "clerk_org_id"),
    name: readString(row, "name"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    deletedAt: readOptionalString(row, "deleted_at"),
    purgeAt: readOptionalString(row, "purge_at"),
  };
}

function readWorkspaceMember(row: RuntimeRow): WorkspaceMember {
  return {
    workspaceId: readString(row, "workspace_id"),
    userId: readString(row, "user_id"),
    role: readWorkspaceRole(row),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readWorkspaceRole(row: RuntimeRow): WorkspaceRole {
  const role = readString(row, "role");
  if (role === "member" || role === "manager" || role === "admin") return role;
  throw new Error(`Invalid workspace role: ${role}`);
}

function readString(row: RuntimeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected D1 column ${key} to be a string.`);
  return value;
}

function readOptionalString(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`Expected D1 column ${key} to be a string.`);
  return value;
}

function readNumber(row: RuntimeRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Expected D1 column ${key} to be a number.`);
  return value;
}

function readJsonRecord(row: RuntimeRow, key: string): Record<string, unknown> | undefined {
  const value = readOptionalString(row, key);
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

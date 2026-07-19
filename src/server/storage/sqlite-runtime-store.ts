import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
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

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;
const migrationDirectory = new URL("../../../sqlite-migrations/", import.meta.url);

export interface SqliteRuntimeDatabaseOptions {
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

/** Shared SQLite runtime state with workspace-scoped store factories. */
export class SqliteRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: SqliteConnectionStore;
  readonly oauthClientConfigStore: SqliteOAuthClientConfigStore;
  readonly oauthStateStore: SqliteOAuthStateStore;
  readonly runtimeTokenStore: SqliteRuntimeTokenStore;
  readonly runLogStore: SqliteRunLogStore;
  readonly workspaceStore: SqliteWorkspaceStore;
  readonly workspaceLifecycleStore: SqliteWorkspaceLifecycleStore;
  readonly membershipStore: SqliteWorkspaceMembershipStore;
  readonly workspaceControlStore: SqliteWorkspaceControlStore;

  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;
  private readonly runLimit: number;

  constructor(filename: string, options: SqliteRuntimeDatabaseOptions = {}) {
    this.database = new DatabaseSync(filename);
    this.secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.runLimit = options.runLimit ?? 100;
    this.initialize();
    const defaults = this.createScopedStores("default");
    this.connectionStore = defaults.connectionStore as SqliteConnectionStore;
    this.oauthClientConfigStore = defaults.oauthClientConfigStore as SqliteOAuthClientConfigStore;
    this.oauthStateStore = defaults.oauthStateStore as SqliteOAuthStateStore;
    this.runLogStore = defaults.runLogStore as SqliteRunLogStore;
    // Token verification starts from a token hash, before its workspace is known.
    this.runtimeTokenStore = new SqliteRuntimeTokenStore(this.database);
    this.workspaceStore = new SqliteWorkspaceStore(this.database);
    this.workspaceLifecycleStore = new SqliteWorkspaceLifecycleStore(this.database);
    this.membershipStore = new SqliteWorkspaceMembershipStore(this.database);
    this.workspaceControlStore = new SqliteWorkspaceControlStore(this.database);
  }

  createScopedStores(workspaceId: string): WorkspaceScopedStores {
    return {
      connectionStore: new SqliteConnectionStore(this.database, this.secretCodec, workspaceId),
      oauthClientConfigStore: new SqliteOAuthClientConfigStore(this.database, this.secretCodec, workspaceId),
      oauthStateStore: new SqliteOAuthStateStore(this.database, workspaceId),
      runtimeTokenStore: new SqliteRuntimeTokenStore(this.database, workspaceId),
      runLogStore: new SqliteRunLogStore(this.database, workspaceId, this.runLimit),
    };
  }

  close(): void {
    this.database.close();
  }

  async rotateSecretCodec(nextSecretCodec: ISecretCodec): Promise<void> {
    const connectionRows = this.database
      .prepare("select workspace_id, service, connection_name, value from connections")
      .all();
    const oauthRows = this.database.prepare("select workspace_id, service, value from oauth_client_configs").all();
    const connections = await Promise.all(
      connectionRows.map(async (row) => ({
        workspaceId: readString(row, "workspace_id"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        value: await nextSecretCodec.encode(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
    const configs = await Promise.all(
      oauthRows.map(async (row) => ({
        workspaceId: readString(row, "workspace_id"),
        service: readString(row, "service"),
        value: await nextSecretCodec.encode(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
    this.database.exec("begin immediate");
    try {
      const updateConnection = this.database.prepare(
        "update connections set value = ? where workspace_id = ? and service = ? and connection_name = ?",
      );
      for (const connection of connections) {
        updateConnection.run(connection.value, connection.workspaceId, connection.service, connection.connectionName);
      }
      const updateConfig = this.database.prepare(
        "update oauth_client_configs set value = ? where workspace_id = ? and service = ?",
      );
      for (const config of configs) {
        updateConfig.run(config.value, config.workspaceId, config.service);
      }
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  resetRuntimeData(): void {
    this.database.exec(`
      delete from connections;
      delete from oauth_client_configs;
      delete from oauth_states;
      delete from runtime_tokens;
      delete from runs;
    `);
  }

  private initialize(): void {
    this.database.exec("pragma journal_mode = wal;");
    runSqliteMigrations(this.database);
  }
}

export class SqliteConnectionStore implements IConnectionStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;
  private readonly workspaceId: string;
  constructor(database: DatabaseSync, secretCodec: ISecretCodec, workspaceId: string) {
    this.database = database;
    this.secretCodec = secretCodec;
    this.workspaceId = workspaceId;
  }

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    return (await this.getStored(service, connectionName))?.credential;
  }

  async getStored(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = this.database
      .prepare(
        "select service, connection_name, value, created_by from connections where workspace_id = ? and service = ? and connection_name = ?",
      )
      .get(this.workspaceId, service, connectionName);
    return row
      ? {
          service: readString(row, "service"),
          connectionName: readString(row, "connection_name"),
          credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
          createdBy: readString(row, "created_by"),
        }
      : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential, createdBy = ""): Promise<void> {
    this.database
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
      .run(
        this.workspaceId,
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        createdBy,
        new Date().toISOString(),
      );
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.database
      .prepare("delete from connections where workspace_id = ? and service = ? and connection_name = ?")
      .run(this.workspaceId, service, connectionName);
  }

  async deleteByOwner(userId: string): Promise<void> {
    this.database
      .prepare("delete from connections where workspace_id = ? and created_by = ?")
      .run(this.workspaceId, userId);
  }

  async list(): Promise<StoredConnection[]> {
    const rows = this.database
      .prepare(
        "select service, connection_name, value, created_by from connections where workspace_id = ? order by service, connection_name",
      )
      .all(this.workspaceId);
    return await Promise.all(
      rows.map(async (row) => ({
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
        createdBy: readString(row, "created_by"),
      })),
    );
  }
}

export class SqliteOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;
  private readonly workspaceId: string;
  constructor(database: DatabaseSync, secretCodec: ISecretCodec, workspaceId: string) {
    this.database = database;
    this.secretCodec = secretCodec;
    this.workspaceId = workspaceId;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    const row = this.database
      .prepare("select value from oauth_client_configs where workspace_id = ? and service = ?")
      .get(this.workspaceId, service);
    return row ? parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.database
      .prepare(
        `
          insert into oauth_client_configs (workspace_id, service, value, created_by, updated_at)
          values (?, ?, ?, '', ?)
          on conflict(workspace_id, service) do update set value = excluded.value, updated_at = excluded.updated_at
        `,
      )
      .run(
        this.workspaceId,
        config.service,
        await this.secretCodec.encode(JSON.stringify(config)),
        new Date().toISOString(),
      );
  }

  async delete(service: string): Promise<void> {
    this.database
      .prepare("delete from oauth_client_configs where workspace_id = ? and service = ?")
      .run(this.workspaceId, service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const rows = this.database
      .prepare("select value from oauth_client_configs where workspace_id = ? order by service")
      .all(this.workspaceId);
    return await Promise.all(
      rows.map(async (row) => parseJson(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class SqliteOAuthStateStore implements IOAuthStateStore {
  private readonly database: DatabaseSync;
  private readonly workspaceId: string;
  constructor(database: DatabaseSync, workspaceId: string) {
    this.database = database;
    this.workspaceId = workspaceId;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    this.database
      .prepare(
        `
          insert into oauth_states (workspace_id, state, value, created_at)
          values (?, ?, ?, ?)
          on conflict(workspace_id, state) do update set value = excluded.value, created_at = excluded.created_at
        `,
      )
      .run(this.workspaceId, state.state, JSON.stringify(state), state.createdAt);
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = this.database
      .prepare("select value from oauth_states where workspace_id = ? and state = ?")
      .get(this.workspaceId, state);
    this.database.prepare("delete from oauth_states where workspace_id = ? and state = ?").run(this.workspaceId, state);
    return row ? parseJson<OAuthAuthorizationState>(readString(row, "value")) : undefined;
  }
}

export class SqliteRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: DatabaseSync;
  private readonly workspaceId: string | undefined;
  constructor(database: DatabaseSync, workspaceId?: string) {
    this.database = database;
    this.workspaceId = workspaceId;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.assertWorkspace(record.workspaceId);
    this.database
      .prepare(
        `
          insert into runtime_tokens (id, workspace_id, user_id, name, token_hash, created_at, last_used_at)
          values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.id,
        record.workspaceId,
        record.userId,
        record.name,
        record.tokenHash,
        record.createdAt,
        record.lastUsedAt ?? null,
      );
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const rows = this.workspaceId
      ? this.database
          .prepare(
            `
              select id, workspace_id, user_id, name, token_hash, created_at, last_used_at
              from runtime_tokens where workspace_id = ? and revoked_at is null order by created_at desc, id desc
            `,
          )
          .all(this.workspaceId)
      : this.database
          .prepare(
            `
              select id, workspace_id, user_id, name, token_hash, created_at, last_used_at
              from runtime_tokens where revoked_at is null order by created_at desc, id desc
            `,
          )
          .all();
    return rows.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = this.database
      .prepare(
        "select id, workspace_id, user_id, name, token_hash, created_at, last_used_at from runtime_tokens where token_hash = ? and revoked_at is null",
      )
      .get(tokenHash);
    const record = row ? readRuntimeTokenRow(row) : undefined;
    return record && (!this.workspaceId || record.workspaceId === this.workspaceId) ? record : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = this.workspaceId
      ? this.database.prepare("delete from runtime_tokens where workspace_id = ? and id = ?").run(this.workspaceId, id)
      : this.database.prepare("delete from runtime_tokens where id = ?").run(id);
    return result.changes > 0;
  }

  async revokeByUser(workspaceId: string, userId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    this.database
      .prepare("update runtime_tokens set revoked_at = ? where workspace_id = ? and user_id = ? and revoked_at is null")
      .run(new Date().toISOString(), workspaceId, userId);
  }

  async revokeByWorkspace(workspaceId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    this.database
      .prepare("update runtime_tokens set revoked_at = ? where workspace_id = ? and revoked_at is null")
      .run(new Date().toISOString(), workspaceId);
  }

  async markUsed(id: string, workspaceId: string, usedAt: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    this.database
      .prepare("update runtime_tokens set last_used_at = ? where workspace_id = ? and id = ? and revoked_at is null")
      .run(usedAt, workspaceId, id);
  }

  private assertWorkspace(workspaceId: string): void {
    if (this.workspaceId && this.workspaceId !== workspaceId) {
      throw new Error("Runtime token workspace does not match its scoped store.");
    }
  }
}

export class SqliteRunLogStore implements IRunLogStore {
  private readonly database: DatabaseSync;
  private readonly workspaceId: string;
  private readonly limit: number;
  constructor(database: DatabaseSync, workspaceId: string, limit: number) {
    this.database = database;
    this.workspaceId = workspaceId;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<void> {
    if (run.workspaceId !== this.workspaceId) {
      throw new Error("Run workspace does not match its scoped store.");
    }
    this.database
      .prepare(
        `
          insert into runs (id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(workspace_id, id) do update set
            user_id = excluded.user_id, service = excluded.service, action_id = excluded.action_id,
            started_at = excluded.started_at, completed_at = excluded.completed_at, ok = excluded.ok, value = excluded.value
        `,
      )
      .run(
        run.id,
        this.workspaceId,
        run.userId,
        run.service,
        run.actionId,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      );
    this.database
      .prepare(
        `
          delete from runs where workspace_id = ? and id in (
            select id from runs where workspace_id = ? order by started_at desc, id desc limit -1 offset ?
          )
        `,
      )
      .run(this.workspaceId, this.workspaceId, this.limit);
  }

  async list(input: RunLogListInput = {}): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const filters = ["workspace_id = ?"];
    const values: Array<string | number | bigint | null | Uint8Array> = [this.workspaceId];
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
    const rows = this.database
      .prepare(
        `select service, value from runs where ${filters.join(" and ")} order by started_at desc, id desc limit ?`,
      )
      .all(...values, limit + 1);
    const runs = rows.map(readRunLogRow);
    const items = runs.slice(0, limit);
    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

class SqliteWorkspaceStore implements IWorkspaceStore {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined> {
    const row = this.database
      .prepare(
        "select id, clerk_org_id, name, created_at, updated_at, deleted_at, purge_at from workspaces where clerk_org_id = ?",
      )
      .get(clerkOrgId);
    return row ? readWorkspace(row) : undefined;
  }

  async getById(id: string): Promise<Workspace | undefined> {
    const row = this.database
      .prepare(
        "select id, clerk_org_id, name, created_at, updated_at, deleted_at, purge_at from workspaces where id = ?",
      )
      .get(id);
    return row ? readWorkspace(row) : undefined;
  }

  async create(workspace: Workspace): Promise<void> {
    this.database
      .prepare("insert into workspaces (id, clerk_org_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run(workspace.id, workspace.clerkOrgId, workspace.name, workspace.createdAt, workspace.updatedAt);
  }

  async updateName(workspaceId: string, name: string, updatedAt: string): Promise<void> {
    this.database
      .prepare("update workspaces set name = ?, updated_at = ? where id = ?")
      .run(name, updatedAt, workspaceId);
  }
}

class SqliteWorkspaceLifecycleStore implements IWorkspaceLifecycleStore {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async archive(workspaceId: string, deletedAt: string, purgeAt: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          "update workspaces set deleted_at = ?, purge_at = ?, updated_at = ? where id = ? and deleted_at is null",
        )
        .run(deletedAt, purgeAt, deletedAt, workspaceId).changes > 0
    );
  }

  async restore(workspaceId: string, restoredAt: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          "update workspaces set deleted_at = null, purge_at = null, updated_at = ? where id = ? and deleted_at is not null",
        )
        .run(restoredAt, workspaceId).changes > 0
    );
  }

  async purgeExpired(now: string): Promise<string[]> {
    const workspaceIds = this.database
      .prepare("select id from workspaces where purge_at is not null and purge_at <= ?")
      .all(now)
      .map((row) => readString(row, "id"));
    this.database.exec("begin");
    try {
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
          "workspace_safety_settings",
          "workspace_provider_safety_settings",
          "workspace_idempotency_records",
          "workspace_memberships",
        ]) {
          this.database.prepare(`delete from ${table} where workspace_id = ?`).run(workspaceId);
        }
        this.database.prepare("delete from workspaces where id = ?").run(workspaceId);
      }
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
    return workspaceIds;
  }
}

class SqliteWorkspaceMembershipStore implements IWorkspaceMembershipStore {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
    const row = this.database
      .prepare("select role from workspace_memberships where workspace_id = ? and user_id = ?")
      .get(workspaceId, userId);
    return row ? readWorkspaceRole(row) : undefined;
  }

  async setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
          insert into workspace_memberships (workspace_id, user_id, role, created_at, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict(workspace_id, user_id) do update set role = excluded.role, updated_at = excluded.updated_at
        `,
      )
      .run(workspaceId, userId, role, now, now);
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.database
      .prepare(
        "select workspace_id, user_id, role, created_at, updated_at from workspace_memberships where workspace_id = ?",
      )
      .all(workspaceId)
      .map(readWorkspaceMember);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.database
      .prepare("delete from workspace_memberships where workspace_id = ? and user_id = ?")
      .run(workspaceId, userId);
  }
}

class SqliteWorkspaceControlStore implements IWorkspaceControlStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async listProviders(workspaceId: string): Promise<WorkspaceProvider[]> {
    return this.database
      .prepare(
        "select workspace_id, service, enabled_by, enabled_at from workspace_providers where workspace_id = ? order by service",
      )
      .all(workspaceId)
      .map((row) => ({
        workspaceId: readString(row, "workspace_id"),
        service: readString(row, "service"),
        enabledBy: readString(row, "enabled_by"),
        enabledAt: readString(row, "enabled_at"),
      }));
  }

  async enableProvider(provider: WorkspaceProvider): Promise<void> {
    this.database
      .prepare(
        "insert into workspace_providers (workspace_id, service, enabled_by, enabled_at) values (?, ?, ?, ?) on conflict(workspace_id, service) do nothing",
      )
      .run(provider.workspaceId, provider.service, provider.enabledBy, provider.enabledAt);
  }

  async disableProvider(workspaceId: string, service: string): Promise<boolean> {
    return (
      this.database
        .prepare("delete from workspace_providers where workspace_id = ? and service = ?")
        .run(workspaceId, service).changes > 0
    );
  }

  async getActionPolicy(workspaceId: string, actionId: string): Promise<WorkspaceActionPolicy | undefined> {
    const row = this.database
      .prepare(
        "select workspace_id, action_id, require_approval, updated_by, updated_at from workspace_action_policies where workspace_id = ? and action_id = ?",
      )
      .get(workspaceId, actionId);
    return row
      ? {
          workspaceId: readString(row, "workspace_id"),
          actionId: readString(row, "action_id"),
          requireApproval: readInteger(row, "require_approval") === 1,
          updatedBy: readString(row, "updated_by"),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async setActionPolicy(policy: WorkspaceActionPolicy): Promise<void> {
    this.database
      .prepare(
        "insert into workspace_action_policies (workspace_id, action_id, require_approval, updated_by, updated_at) values (?, ?, ?, ?, ?) on conflict(workspace_id, action_id) do update set require_approval = excluded.require_approval, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .run(policy.workspaceId, policy.actionId, policy.requireApproval ? 1 : 0, policy.updatedBy, policy.updatedAt);
  }

  async getWorkspaceSafetySettings(workspaceId: string): Promise<WorkspaceSafetySettings | undefined> {
    const row = this.database
      .prepare(
        "select workspace_id, value, updated_by, updated_at from workspace_safety_settings where workspace_id = ?",
      )
      .get(workspaceId);
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
    this.database
      .prepare(
        "insert into workspace_safety_settings (workspace_id, value, updated_by, updated_at) values (?, ?, ?, ?) on conflict(workspace_id) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .run(settings.workspaceId, JSON.stringify(settings.value), settings.updatedBy, settings.updatedAt);
  }

  async getProviderSafetySettings(
    workspaceId: string,
    service: string,
  ): Promise<WorkspaceProviderSafetySettings | undefined> {
    const row = this.database
      .prepare(
        "select workspace_id, service, value, updated_by, updated_at from workspace_provider_safety_settings where workspace_id = ? and service = ?",
      )
      .get(workspaceId, service);
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
    this.database
      .prepare(
        "insert into workspace_provider_safety_settings (workspace_id, service, value, updated_by, updated_at) values (?, ?, ?, ?, ?) on conflict(workspace_id, service) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .run(
        settings.workspaceId,
        settings.service,
        JSON.stringify(settings.value),
        settings.updatedBy,
        settings.updatedAt,
      );
  }

  async getIdempotencyRecord(
    workspaceId: string,
    actionId: string,
    connectionName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceIdempotencyRecord | undefined> {
    const row = this.database
      .prepare(
        "select workspace_id, action_id, connection_name, idempotency_key, input_hash, execution_id, result, created_at from workspace_idempotency_records where workspace_id = ? and action_id = ? and connection_name = ? and idempotency_key = ?",
      )
      .get(workspaceId, actionId, connectionName, idempotencyKey);
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
    this.database
      .prepare(
        "insert into workspace_idempotency_records (workspace_id, action_id, connection_name, idempotency_key, input_hash, execution_id, result, created_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(workspace_id, action_id, connection_name, idempotency_key) do nothing",
      )
      .run(
        record.workspaceId,
        record.actionId,
        record.connectionName,
        record.idempotencyKey,
        record.inputHash,
        record.executionId,
        JSON.stringify(record.result),
        record.createdAt,
      );
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.database
      .prepare(
        "insert into audit_events (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.workspaceId,
        event.userId,
        event.event,
        event.resourceType,
        event.resourceId ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.createdAt,
      );
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    return this.database
      .prepare(
        "select id, workspace_id, user_id, event, resource_type, resource_id, details, created_at from audit_events where workspace_id = ? order by created_at desc, id desc limit ?",
      )
      .all(workspaceId, limit)
      .map((row) => ({
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

function runSqliteMigrations(database: DatabaseSync): void {
  database.exec("create table if not exists runtime_migrations (name text primary key, applied_at text not null);");
  const applied = new Set(
    database
      .prepare("select name from runtime_migrations")
      .all()
      .map((row) => readString(row, "name")),
  );
  for (const file of readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()) {
    const legacyName = file.replace(/-/g, "_");
    if (!applied.has(file) && !applied.has(legacyName)) {
      database.exec(readFileSync(new URL(file, migrationDirectory), "utf8"));
      database
        .prepare("insert into runtime_migrations (name, applied_at) values (?, ?)")
        .run(file, new Date().toISOString());
    }
  }
}

function readRuntimeTokenRow(row: unknown): RuntimeTokenRecord {
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

function readRunLogRow(row: unknown): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function readWorkspace(row: unknown): Workspace {
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

function readWorkspaceMember(row: unknown): WorkspaceMember {
  return {
    workspaceId: readString(row, "workspace_id"),
    userId: readString(row, "user_id"),
    role: readWorkspaceRole(row),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readWorkspaceRole(row: unknown): WorkspaceRole {
  const role = readString(row, "role");
  if (role === "member" || role === "manager" || role === "admin") {
    return role;
  }
  throw new Error(`Invalid workspace role: ${role}`);
}

function readString(row: unknown, key: string): string {
  const value = (row as RuntimeRow)[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string.`);
  }
  return value;
}

function readOptionalString(row: unknown, key: string): string | undefined {
  const value = (row as RuntimeRow)[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string.`);
  }
  return value;
}

function readInteger(row: unknown, key: string): number {
  const value = (row as RuntimeRow)[key];
  if (typeof value !== "number") {
    throw new Error(`Expected SQLite column ${key} to be a number.`);
  }
  return value;
}

function readJsonRecord(row: unknown, key: string): Record<string, unknown> | undefined {
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

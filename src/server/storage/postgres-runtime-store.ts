import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type {
  IWorkspaceMembershipStore,
  IWorkspaceControlStore,
  IWorkspaceStore,
  RuntimeDatabase,
  Workspace,
  WorkspaceActionPolicy,
  WorkspaceProvider,
  AuditEvent,
  WorkspaceMember,
  WorkspaceScopedStores,
} from "./runtime-database.ts";
import type { IRunLogStore, RunLog, RunLogCaller, RunLogListInput, RunLogPage } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord, WorkspaceRole } from "./runtime-token-service.ts";
import type { Pool, QueryResultRow } from "pg";

function now(): string {
  return new Date().toISOString();
}

export class PostgresRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: IConnectionStore;
  readonly oauthClientConfigStore: IOAuthClientConfigStore;
  readonly oauthStateStore: IOAuthStateStore;
  readonly runtimeTokenStore: IRuntimeTokenStore;
  readonly runLogStore: IRunLogStore;
  readonly workspaceStore: IWorkspaceStore;
  readonly membershipStore: IWorkspaceMembershipStore;
  readonly workspaceControlStore: IWorkspaceControlStore;
  readonly #pool: Pool;
  readonly #codec: ISecretCodec;

  constructor(pool: Pool, secretCodec: ISecretCodec, defaultWorkspaceId = "default") {
    this.#pool = pool;
    this.#codec = secretCodec;
    const unscoped = new PostgresScopedStores(pool, secretCodec, defaultWorkspaceId);
    this.connectionStore = unscoped.connectionStore;
    this.oauthClientConfigStore = unscoped.oauthClientConfigStore;
    this.oauthStateStore = unscoped.oauthStateStore;
    this.runtimeTokenStore = unscoped.runtimeTokenStore;
    this.runLogStore = unscoped.runLogStore;
    this.workspaceStore = new PostgresWorkspaceStore(pool);
    this.membershipStore = new PostgresMembershipStore(pool);
    this.workspaceControlStore = new PostgresWorkspaceControlStore(pool);
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  createScopedStores(workspaceId: string): WorkspaceScopedStores {
    return new PostgresScopedStores(this.#pool, this.#codec, workspaceId);
  }
}

class PostgresScopedStores implements WorkspaceScopedStores {
  readonly connectionStore: IConnectionStore;
  readonly oauthClientConfigStore: IOAuthClientConfigStore;
  readonly oauthStateStore: IOAuthStateStore;
  readonly runtimeTokenStore: IRuntimeTokenStore;
  readonly runLogStore: IRunLogStore;

  constructor(pool: Pool, codec: ISecretCodec, workspaceId: string) {
    this.connectionStore = new PostgresConnectionStore(pool, codec, workspaceId);
    this.oauthClientConfigStore = new PostgresOAuthConfigStore(pool, codec, workspaceId);
    this.oauthStateStore = new PostgresOAuthStateStore(pool, codec, workspaceId);
    this.runtimeTokenStore = new PostgresTokenStore(pool, workspaceId);
    this.runLogStore = new PostgresRunLogStore(pool, workspaceId);
  }
}

class PostgresConnectionStore implements IConnectionStore {
  readonly #pool: Pool;
  readonly #codec: ISecretCodec;
  readonly #workspaceId: string;

  constructor(pool: Pool, codec: ISecretCodec, workspaceId: string) {
    this.#pool = pool;
    this.#codec = codec;
    this.#workspaceId = workspaceId;
  }

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    return (await this.getStored(service, connectionName))?.credential;
  }

  async getStored(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const result = await this.#pool.query(
      `select service, connection_name, value, created_by
       from connections where workspace_id = $1 and service = $2 and connection_name = $3`,
      [this.#workspaceId, service, connectionName],
    );
    if (result.rows.length === 0) return undefined;
    const decoded = await this.#codec.decode(result.rows[0].value);
    return {
      service: result.rows[0].service,
      connectionName: result.rows[0].connection_name,
      credential: JSON.parse(decoded) as ResolvedCredential,
      createdBy: result.rows[0].created_by,
    };
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential, createdBy = ""): Promise<void> {
    const encoded = await this.#codec.encode(JSON.stringify(credential));
    await this.#pool.query(
      `insert into connections (workspace_id, service, connection_name, label, value, created_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id, service, connection_name) do update
       set label = $4, value = $5, created_by = case when connections.created_by = '' then excluded.created_by else connections.created_by end, updated_at = $7`,
      [this.#workspaceId, service, connectionName, connectionName, encoded, createdBy, now()],
    );
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.#pool.query(
      `delete from connections where workspace_id = $1 and service = $2 and connection_name = $3`,
      [this.#workspaceId, service, connectionName],
    );
  }

  async deleteByOwner(userId: string): Promise<void> {
    await this.#pool.query(`delete from connections where workspace_id = $1 and created_by = $2`, [
      this.#workspaceId,
      userId,
    ]);
  }

  async list(): Promise<StoredConnection[]> {
    const result = await this.#pool.query(
      `select service, connection_name, value, created_by from connections where workspace_id = $1`,
      [this.#workspaceId],
    );
    const items: StoredConnection[] = [];
    for (const row of result.rows) {
      const decoded = await this.#codec.decode(row.value);
      items.push({
        service: row.service,
        connectionName: row.connection_name,
        credential: JSON.parse(decoded) as ResolvedCredential,
        createdBy: row.created_by,
      });
    }
    return items;
  }
}

class PostgresOAuthConfigStore implements IOAuthClientConfigStore {
  readonly #pool: Pool;
  readonly #codec: ISecretCodec;
  readonly #workspaceId: string;

  constructor(pool: Pool, codec: ISecretCodec, workspaceId: string) {
    this.#pool = pool;
    this.#codec = codec;
    this.#workspaceId = workspaceId;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    const result = await this.#pool.query(
      `select value from oauth_client_configs where workspace_id = $1 and service = $2`,
      [this.#workspaceId, service],
    );
    if (result.rows.length === 0) return undefined;
    const decoded = await this.#codec.decode(result.rows[0].value);
    return JSON.parse(decoded) as OAuthClientConfig;
  }

  async set(config: OAuthClientConfig): Promise<void> {
    const encoded = await this.#codec.encode(JSON.stringify(config));
    await this.#pool.query(
      `insert into oauth_client_configs (workspace_id, service, value, created_by, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, service) do update set value = $3, updated_at = $5`,
      [this.#workspaceId, config.service, encoded, "", now()],
    );
  }

  async delete(service: string): Promise<void> {
    await this.#pool.query(`delete from oauth_client_configs where workspace_id = $1 and service = $2`, [
      this.#workspaceId,
      service,
    ]);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const result = await this.#pool.query(`select value from oauth_client_configs where workspace_id = $1`, [
      this.#workspaceId,
    ]);
    const items: OAuthClientConfig[] = [];
    for (const row of result.rows) {
      const decoded = await this.#codec.decode(row.value);
      items.push(JSON.parse(decoded) as OAuthClientConfig);
    }
    return items;
  }
}

class PostgresOAuthStateStore implements IOAuthStateStore {
  readonly #pool: Pool;
  readonly #codec: ISecretCodec;
  readonly #workspaceId: string;

  constructor(pool: Pool, codec: ISecretCodec, workspaceId: string) {
    this.#pool = pool;
    this.#codec = codec;
    this.#workspaceId = workspaceId;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    const encoded = await this.#codec.encode(JSON.stringify(state));
    await this.#pool.query(
      `insert into oauth_states (workspace_id, state, value, created_at)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, state) do update set value = $3`,
      [this.#workspaceId, state.state, encoded, now()],
    );
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const result = await this.#pool.query(`select value from oauth_states where workspace_id = $1 and state = $2`, [
      this.#workspaceId,
      state,
    ]);
    if (result.rows.length === 0) return undefined;
    await this.#pool.query(`delete from oauth_states where workspace_id = $1 and state = $2`, [
      this.#workspaceId,
      state,
    ]);
    const decoded = await this.#codec.decode(result.rows[0].value);
    return JSON.parse(decoded) as OAuthAuthorizationState;
  }
}

class PostgresTokenStore implements IRuntimeTokenStore {
  readonly #pool: Pool;
  readonly #workspaceId: string;

  constructor(pool: Pool, workspaceId: string) {
    this.#pool = pool;
    this.#workspaceId = workspaceId;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.#pool.query(
      `insert into runtime_tokens (id, workspace_id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, null)`,
      [
        record.id,
        this.#workspaceId,
        record.userId,
        record.name,
        record.tokenHash,
        record.createdAt,
        record.lastUsedAt ?? null,
      ],
    );
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const result = await this.#pool.query(
      `select id, workspace_id, user_id, name, token_hash, created_at, last_used_at
       from runtime_tokens where workspace_id = $1 and revoked_at is null`,
      [this.#workspaceId],
    );
    return result.rows.map(mapTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const result = await this.#pool.query(
      `select id, workspace_id, user_id, name, token_hash, created_at, last_used_at
       from runtime_tokens where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    );
    if (result.rows.length === 0) return undefined;
    return mapTokenRow(result.rows[0]);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.#pool.query(
      `update runtime_tokens set revoked_at = $1 where workspace_id = $2 and id = $3 and revoked_at is null`,
      [now(), this.#workspaceId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeByUser(workspaceId: string, userId: string): Promise<void> {
    await this.#pool.query(
      `update runtime_tokens set revoked_at = $1 where workspace_id = $2 and user_id = $3 and revoked_at is null`,
      [now(), workspaceId, userId],
    );
  }

  async markUsed(id: string, workspaceId: string, usedAt: string): Promise<void> {
    await this.#pool.query(`update runtime_tokens set last_used_at = $1 where workspace_id = $2 and id = $3`, [
      usedAt,
      workspaceId,
      id,
    ]);
  }
}

class PostgresRunLogStore implements IRunLogStore {
  readonly #pool: Pool;
  readonly #workspaceId: string;

  constructor(pool: Pool, workspaceId: string) {
    this.#pool = pool;
    this.#workspaceId = workspaceId;
  }

  async add(run: RunLog): Promise<void> {
    await this.#pool.query(
      `insert into runs (id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        run.id,
        this.#workspaceId,
        run.userId,
        run.service,
        run.actionId,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify({ inputSummary: run.inputSummary, errorCode: run.errorCode, errorMessage: run.errorMessage }),
      ],
    );
  }

  async list(input?: RunLogListInput): Promise<RunLogPage> {
    const limit = input?.limit ?? 50;
    const { decodeRunLogCursor: decode } = await import("./runtime-store.ts");
    const cursor = decode(input?.cursor);

    let query = `select id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value from runs where workspace_id = $1`;
    const params: unknown[] = [this.#workspaceId];
    let paramIndex = 2;

    if (input?.service) {
      query += ` and service = $${paramIndex++}`;
      params.push(input.service);
    }

    if (input?.userId) {
      query += ` and user_id = $${paramIndex++}`;
      params.push(input.userId);
    }

    if (cursor) {
      query += ` and (started_at, id) < ($${paramIndex}, $${paramIndex + 1})`;
      params.push(cursor.startedAt, cursor.id);
      paramIndex += 2;
    }

    query += ` order by started_at desc, id desc limit $${paramIndex}`;
    params.push(limit);

    const result = await this.#pool.query(query, params);
    const { encodeRunLogCursor: encode } = await import("./runtime-store.ts");

    const items: RunLog[] = result.rows.map((r) => {
      const extra = typeof r.value === "string" ? JSON.parse(r.value) : (r.value ?? {});
      const startedAt = r.started_at as string;
      const completedAt = r.completed_at as string;
      return {
        id: r.id,
        workspaceId: r.workspace_id,
        userId: r.user_id,
        service: r.service,
        actionId: r.action_id,
        caller: "http" as RunLogCaller,
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        ok: r.ok === 1,
        inputSummary: extra.inputSummary,
        errorCode: extra.errorCode,
        errorMessage: extra.errorMessage,
      };
    });

    const lastItem = items[items.length - 1];
    const nextCursor = items.length === limit && lastItem ? encode(lastItem) : undefined;

    return { items, nextCursor };
  }
}

class PostgresWorkspaceStore implements IWorkspaceStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined> {
    const result = await this.#pool.query(
      `select id, clerk_org_id, name, created_at, updated_at from workspaces where clerk_org_id = $1`,
      [clerkOrgId],
    );
    if (result.rows.length === 0) return undefined;
    return mapWorkspaceRow(result.rows[0]);
  }

  async getById(id: string): Promise<Workspace | undefined> {
    const result = await this.#pool.query(
      `select id, clerk_org_id, name, created_at, updated_at from workspaces where id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return mapWorkspaceRow(result.rows[0]);
  }

  async create(workspace: Workspace): Promise<void> {
    await this.#pool.query(
      `insert into workspaces (id, clerk_org_id, name, created_at, updated_at)
       values ($1, $2, $3, $4, $5)`,
      [workspace.id, workspace.clerkOrgId, workspace.name, workspace.createdAt, workspace.updatedAt],
    );
  }
}

class PostgresMembershipStore implements IWorkspaceMembershipStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
    const result = await this.#pool.query(
      `select role from workspace_memberships where workspace_id = $1 and user_id = $2`,
      [workspaceId, userId],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].role as WorkspaceRole;
  }

  async setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const n = now();
    await this.#pool.query(
      `insert into workspace_memberships (workspace_id, user_id, role, created_at, updated_at)
       values ($1, $2, $3, $4, $4)
       on conflict (workspace_id, user_id) do update set role = $3, updated_at = $4`,
      [workspaceId, userId, role, n],
    );
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const result = await this.#pool.query(
      `select workspace_id, user_id, role, created_at, updated_at from workspace_memberships where workspace_id = $1`,
      [workspaceId],
    );
    return result.rows.map(mapMemberRow);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.#pool.query(`delete from workspace_memberships where workspace_id = $1 and user_id = $2`, [
      workspaceId,
      userId,
    ]);
  }
}

class PostgresWorkspaceControlStore implements IWorkspaceControlStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async listProviders(workspaceId: string): Promise<WorkspaceProvider[]> {
    const result = await this.#pool.query(
      `select workspace_id, service, enabled_by, enabled_at from workspace_providers where workspace_id = $1 order by service`,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      service: row.service,
      enabledBy: row.enabled_by,
      enabledAt: row.enabled_at,
    }));
  }

  async enableProvider(provider: WorkspaceProvider): Promise<void> {
    await this.#pool.query(
      `insert into workspace_providers (workspace_id, service, enabled_by, enabled_at)
       values ($1, $2, $3, $4) on conflict (workspace_id, service) do nothing`,
      [provider.workspaceId, provider.service, provider.enabledBy, provider.enabledAt],
    );
  }

  async disableProvider(workspaceId: string, service: string): Promise<boolean> {
    const result = await this.#pool.query(`delete from workspace_providers where workspace_id = $1 and service = $2`, [
      workspaceId,
      service,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async getActionPolicy(workspaceId: string, actionId: string): Promise<WorkspaceActionPolicy | undefined> {
    const result = await this.#pool.query(
      `select workspace_id, action_id, require_approval, updated_by, updated_at
       from workspace_action_policies where workspace_id = $1 and action_id = $2`,
      [workspaceId, actionId],
    );
    const row = result.rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          actionId: row.action_id,
          requireApproval: row.require_approval,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async setActionPolicy(policy: WorkspaceActionPolicy): Promise<void> {
    await this.#pool.query(
      `insert into workspace_action_policies (workspace_id, action_id, require_approval, updated_by, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, action_id) do update
       set require_approval = excluded.require_approval, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [policy.workspaceId, policy.actionId, policy.requireApproval, policy.updatedBy, policy.updatedAt],
    );
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    await this.#pool.query(
      `insert into audit_events (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.workspaceId,
        event.userId,
        event.event,
        event.resourceType,
        event.resourceId ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.createdAt,
      ],
    );
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    const result = await this.#pool.query(
      `select id, workspace_id, user_id, event, resource_type, resource_id, details, created_at
       from audit_events where workspace_id = $1 order by created_at desc, id desc limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      event: row.event,
      resourceType: row.resource_type,
      resourceId: row.resource_id ?? undefined,
      details: typeof row.details === "string" ? (JSON.parse(row.details) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
    }));
  }
}

function mapTokenRow(r: QueryResultRow): RuntimeTokenRecord {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    userId: r.user_id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    createdAt: r.created_at as string,
    lastUsedAt: (r.last_used_at as string) ?? undefined,
  };
}

function mapWorkspaceRow(r: QueryResultRow): Workspace {
  return {
    id: r.id as string,
    clerkOrgId: r.clerk_org_id as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapMemberRow(r: QueryResultRow): WorkspaceMember {
  return {
    workspaceId: r.workspace_id as string,
    userId: r.user_id as string,
    role: r.role as WorkspaceRole,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

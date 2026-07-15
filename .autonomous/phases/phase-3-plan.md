# Phase 3: Workspace-Aware MCP — Implementation Plan

**Goal:** Prepare the codebase for multi-workspace operation by introducing workspace context into the MCP server, runtime token system, and API routes — without requiring a live auth provider (Clerk). The plan delivers injectable workspace abstractions that can be wired to real auth in Phase 4, while keeping the existing single-user path intact.

**Status:** Implemented — pending gate  
**Date:** 2026-07-15  
**Constitution version:** 1.0.0

**Evidence:** `.autonomous/evidence/phase-3-result.md`, `.autonomous/evidence/phase-3-handoff.json`

---

## 1. Scope & Non-Scope

### In scope (this phase)

1. **Workspace-scoped `IConnectionStore`** — a new interface plus a SQLite implementation that partitions connections, OAuth configs, tokens, and runs by `workspaceId`.
2. **Runtime tokens with workspace + role binding** — extend `RuntimeTokenRecord` and `RuntimeTokenService` so every token carries `workspaceId` and `role`; verification returns the bound context, not just `true/false`.
3. **`WorkspaceContext` type and injector** — a request-scoped value derived from the authenticated token (or a synthetic admin context for the existing single-user path). Flows through Hono middleware into the request `Context` var.
4. **Workspace-aware `ConnectionService`** — constructor accepts a `workspaceId`; every method scopes its queries. Existing API retains `new ConnectionService(...)` without workspace for backward compatibility.
5. **Workspace-aware MCP server** — `createMcpServer` accepts a `WorkspaceContext`; `list_apps` filters catalog providers to workspace-enabled providers; `execute_action` and `search_actions` use workspace-scoped connections.
6. **API route middleware** — `createLocalAuthMiddleware` becomes `createWorkspaceAuthMiddleware` that extracts `WorkspaceContext`; routes read it from context vars. All `/v1/*` and `/api/*` routes that use connections gain workspace scoping.

### Out of scope (future phases)

- Clerk SDK integration (Phase 4)
- Workspace CRUD, invitations, member management (Phase 4)
- Provider enablement per workspace (Phase 4 — catalog stays global for now)
- Audit logging (Phase 5)
- Insforge/PostgreSQL migration (Phase 6)
- Permission dialogs, approval UI

---

## 2. Design: How Workspace Context Flows

```
                    ┌──────────────────┐
                    │  Bearer token    │
                    │  (Authorization  │
                    │   header)        │
                    └────────┬─────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  createWorkspaceAuthMiddleware│
              │  (replaces createLocalAuth-  │
              │   Middleware)                 │
              │                              │
              │  • Reads Bearer token        │
              │  • If admin token → synthetic│
              │    WorkspaceContext with      │
              │    workspaceId="default",     │
              │    role="admin"               │
              │  • If runtime token → looks  │
              │    up hash in RuntimeToken-   │
              │    Service, extracts          │
              │    workspaceId + role         │
              │  • Sets context variable      │
              │    "workspaceContext" on      │
              │    Hono Context               │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Route handlers              │
              │  (connect-server.ts)         │
              │                              │
              │  • Reads workspaceContext    │
              │    from context.var          │
              │  • Creates scoped            │
              │    ConnectionService via     │
              │    connections.forWorkspace( │
              │      workspaceId)            │
              │  • Passes workspaceContext   │
              │    to createMcpServer()      │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
    ┌────────────┐  ┌──────────────┐  ┌─────────┐
    │ MCP tools  │  │ /v1/* routes │  │ /api/*  │
    │ (mcp.ts)   │  │              │  │ routes  │
    │            │  │ • list apps  │  │         │
    │ • list_apps│  │ • list conns │  │ • CRUD  │
    │ • search   │  │ • execute    │  │ • runs  │
    │ • execute  │  │ • proxy      │  │         │
    └─────┬──────┘  └──────┬───────┘  └────┬────┘
          │                │               │
          └────────────────┼───────────────┘
                           │
                           ▼
              ┌──────────────────────────────┐
              │  ConnectionService           │
              │  (workspace-scoped)          │
              │                              │
              │  • workspaceId baked into    │
              │    constructor               │
              │  • All store queries pass    │
              │    workspaceId               │
              │  • listConnections() scoped  │
              │    to workspace              │
              │  • getConnectionSummary()    │
              │    scoped to workspace       │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  IConnectionStore            │
              │  (workspace-aware)           │
              │                              │
              │  All methods now accept      │
              │  workspaceId parameter       │
              └──────────────────────────────┘
```

---

## 3. File-by-File Changes

### 3.1 `src/server/storage/runtime-database.ts` — New workspace-aware store interfaces

**Change:** Add `IWorkspaceConnectionStore`, `IWorkspaceTokenStore`, etc. alongside existing interfaces. The existing `RuntimeDatabase` keeps its shape for backward compatibility.

**New types:**

```typescript
// Workspace-aware store interfaces — every method takes workspaceId

export interface IWorkspaceConnectionStore {
  get(workspaceId: string, service: string, connectionName: string): Promise<ResolvedCredential | undefined>;
  set(workspaceId: string, service: string, connectionName: string, credential: ResolvedCredential): Promise<void>;
  delete(workspaceId: string, service: string, connectionName: string): Promise<void>;
  list(workspaceId: string): Promise<StoredConnection[]>;
}

export interface IWorkspaceOAuthConfigStore {
  get(workspaceId: string, service: string): Promise<OAuthClientConfig | undefined>;
  set(workspaceId: string, config: OAuthClientConfig): Promise<void>;
  delete(workspaceId: string, service: string): Promise<void>;
  list(workspaceId: string): Promise<OAuthClientConfig[]>;
}

export interface IWorkspaceTokenStore {
  add(workspaceId: string, record: WorkspaceTokenRecord): Promise<void>;
  list(workspaceId: string): Promise<WorkspaceTokenRecord[]>;
  revoke(workspaceId: string, id: string): Promise<boolean>;
  markUsed(workspaceId: string, id: string, usedAt: string): Promise<void>;
  findByHash(tokenHash: string): Promise<WorkspaceTokenRecord | undefined>; // cross-workspace lookup by hash
}

export interface IWorkspaceRunLogStore {
  add(workspaceId: string, run: RunLog): Promise<void>;
  list(workspaceId: string, input?: RunLogListInput): Promise<RunLogPage>;
}
```

### 3.2 `src/server/storage/runtime-token-service.ts` — Workspace-aware token records

**Change:** Extend `RuntimeTokenRecord` with `workspaceId` and `role`. Extend `RuntimeTokenService` with methods that return workspace context from token verification.

**New types:**

```typescript
export type WorkspaceRole = "member" | "manager" | "admin";

export interface WorkspaceTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  workspaceId: string;
  role: WorkspaceRole;
  createdBy: string; // clerk user id
  createdAt: string;
  lastUsedAt?: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string; // clerk user id, or "admin" for admin-token auth
  tokenId?: string; // present for runtime token auth, absent for admin token
}
```

**Changes to `RuntimeTokenService`:**

- `createToken` gains `workspaceId` and `role` parameters
- `verifyToken` returns `WorkspaceContext | undefined` instead of `boolean`
- New method: `findTokenByHash` for cross-workspace lookup (admin path)
- Keep existing `RuntimeTokenService` working for SQLite path with default workspaceId

### 3.3 `src/server/api/auth.ts` — Workspace-aware middleware

**Change:** Replace the single-purpose `createLocalAuthMiddleware` with `createWorkspaceAuthMiddleware` that extracts and injects `WorkspaceContext` into Hono context variables.

**Key changes:**

```typescript
// Hono context variable key
export const workspaceContextVar = "workspaceContext";

export interface WorkspaceAuthOptions {
  adminToken?: string;
  runtimeToken?: string; // legacy env-var token (maps to synthetic workspace)
  tokenService?: RuntimeTokenService; // for stored-token verification
  syntheticWorkspaceId?: string; // default: "default"
}

// Returns:
// - context.set("workspaceContext", { workspaceId, role, userId, tokenId })
// - Or 401 if no valid token
export function createWorkspaceAuthMiddleware(options: WorkspaceAuthOptions): MiddlewareHandler;
```

**Auth resolution logic:**

1. Read `Authorization: Bearer <token>` header
2. If `token === options.adminToken` → set `WorkspaceContext` with `role="admin"`, `workspaceId=options.syntheticWorkspaceId`, `userId="admin"`
3. If `token === options.runtimeToken` (legacy env var) → set `WorkspaceContext` with `role="admin"`, `workspaceId=options.syntheticWorkspaceId`, `userId="runtime"`
4. If `options.tokenService` is available, call `tokenService.verifyToken(token)` → if returns `WorkspaceContext`, set it
5. If no auth is configured (`!adminToken && !runtimeToken && !tokenService`), set a default `WorkspaceContext` with `role="admin"`, `workspaceId=options.syntheticWorkspaceId`
6. Otherwise → 401

**Helper for route handlers:**

```typescript
export function getWorkspaceContext(context: Context): WorkspaceContext | undefined {
  return context.get(workspaceContextVar) as WorkspaceContext | undefined;
}

export function requireWorkspaceContext(context: Context): WorkspaceContext {
  const ctx = getWorkspaceContext(context);
  if (!ctx) throw new Error("workspaceContext not set — middleware not applied");
  return ctx;
}
```

### 3.4 `src/connection-service.ts` — Workspace-scoped ConnectionService

**Change:** `ConnectionService` gains an optional `workspaceId` constructor parameter. When set, all storage operations pass `workspaceId`. Add a `forWorkspace(workspaceId)` factory that returns a scoped instance sharing the same catalog and provider loader. Backward-compatible: omit `workspaceId` and it uses the existing flat store (or a synthetic default).

**Key changes:**

```typescript
export interface ConnectionServiceOptions {
  catalog: CatalogStore;
  oauthCredentials?: IOAuthCredentialRefresher;
  providerLoader: IProviderLoader;
  store: IConnectionStore;
  workspaceId?: string; // NEW
  workspaceStore?: IWorkspaceConnectionStore; // NEW — preferred when workspaceId is set
  logger?: RuntimeLogger;
}
```

- If `workspaceId` is set AND `workspaceStore` is provided, use `workspaceStore` with workspaceId for all CRUD
- If `workspaceId` is set but no `workspaceStore`, prepend workspaceId to connection names in the flat store (transitional)
- If neither is set, use existing `store` directly (backward compatible)

**New method:**

```typescript
forWorkspace(workspaceId: string): ConnectionService;
// Returns a new ConnectionService scoped to the given workspaceId,
// sharing the same catalog, providerLoader, etc.
```

### 3.5 `src/mcp.ts` — Workspace-aware MCP server

**Change:** `IMcpServerOptions` gains an optional `workspaceContext: WorkspaceContext`. Tools use it for scoping.

**Key changes:**

- `list_apps` — already iterates catalog providers. No workspace filter needed yet (catalog is global until Phase 4). But connection lookup uses workspace-scoped connections.
- `search_actions` — no change (catalog is global)
- `get_action_guide` — `describeActionCapability` uses workspace-scoped `connections.getConnectionSummary`
- `execute_action` — passes `connectionName`; the `ActionRunner` already receives a scoped `ConnectionService` from the caller

```typescript
export interface IMcpServerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService; // NOW: pre-scoped to workspace
  actions: ActionRunner; // NOW: pre-scoped to workspace
  actionPolicy?: ActionPolicyService;
  actionSearch?: ActionSearchIndexProvider;
  workspaceContext?: WorkspaceContext; // NEW — for MCP instructions/auth
}
```

The MCP server itself does not change structurally — it already receives scoped `connections` and `actions` from the caller. The _caller_ (`handleMcp` in connect-server.ts) is responsible for creating the scoped instances.

**MCP instructions update:** Append workspace-awareness guidance:

```
"Your actions are scoped to your current workspace. You can only access connections configured in this workspace."
```

### 3.6 `src/server/connect-server.ts` — Route handler refactoring

**Change:** Every request handler that uses `this.options.connections` or `this.options.actions` reads `WorkspaceContext` from the Hono context and creates workspace-scoped service instances.

**Key pattern in handlers:**

```typescript
private async listRuntimeApps(context: Context): Promise<Response> {
  const wsCtx = requireWorkspaceContext(context);
  const scopedConnections = this.options.connections.forWorkspace(wsCtx.workspaceId);
  return writeRuntimeSuccess(
    context,
    (await scopedConnections.listConnections()).map(serializeRuntimeConnectedApp),
  );
}
```

**`handleMcp` change:**

```typescript
private async handleMcp(context: Context): Promise<Response> {
  const wsCtx = getWorkspaceContext(context);
  const scopedConnections = wsCtx
    ? this.options.connections.forWorkspace(wsCtx.workspaceId)
    : this.options.connections;
  const scopedActions = /* similar */;

  const server = createMcpServer({
    catalog: this.options.catalog,
    providerLoader: this.options.providerLoader,
    connections: scopedConnections,
    actions: scopedActions,   // needs ActionRunner.forWorkspace
    actionPolicy: this.options.actionPolicy,
    actionSearch: this.actionSearch,
    workspaceContext: wsCtx,
  });
  // ... rest unchanged
}
```

**Routes affected (every connection-aware route):**

- `GET /v1/apps` — scoped
- `GET /v1/apps/services/:service` — scoped
- `GET /v1/apps/authenticated` — scoped
- `POST /v1/actions/:actionId` — scoped
- `POST /v1/proxy/:service` — scoped
- `GET /api/connections` — scoped
- `PUT /api/connections/:service` — scoped
- `DELETE /api/connections/:service` — scoped
- `GET /api/runs` — scoped
- `GET /api/runtime-tokens` — scoped
- `POST /api/runtime-tokens` — scoped (creates tokens in current workspace)
- `DELETE /api/runtime-tokens/:id` — scoped
- `GET /api/oauth/configs` — scoped
- `PUT /api/oauth/configs/:service` — scoped
- `DELETE /api/oauth/configs/:service` — scoped
- `POST /mcp` — scoped
- `GET /api/actions/:actionId/agent.md` — scoped (connection lookup)

### 3.7 `src/server/actions/action-runner.ts` — Workspace-scoped runner

**Change:** Add `forWorkspace(workspaceId)` factory, similar to `ConnectionService.forWorkspace`. The existing constructor + `run` method delegate to a scoped `ConnectionService`.

```typescript
export class ActionRunner {
  // existing...
  forWorkspace(workspaceId: string): ActionRunner {
    return new ActionRunner({
      ...this.options,
      connections: this.options.connections.forWorkspace(workspaceId),
    });
  }
}
```

### 3.8 `src/server/connect-app.ts` — Wire the new middleware and services

**Change:** Replace `createLocalAuthMiddleware` with `createWorkspaceAuthMiddleware`. Pass workspace-aware stores through the `RuntimeDatabase` interface extension.

```typescript
export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  // ... existing service creation ...

  // NEW: workspace-aware auth middleware
  const auth = createWorkspaceAuthMiddleware({
    adminToken: options.adminToken,
    runtimeToken: options.runtimeToken,
    tokenService: runtimeTokens,
    syntheticWorkspaceId: "default", // single-user mode
  });

  return {
    app: new ConnectServer({
      // ... existing options ...
      auth, // pass the workspace-aware auth middleware + options
    }).createApp(),
    // ...
  };
}
```

**`ConnectAppOptions` changes:**

```typescript
export interface ConnectAppOptions {
  // ... existing ...
  syntheticWorkspaceId?: string; // default: "default"
}
```

### 3.9 `src/server/storage/sqlite-runtime-store.ts` — Workspace-column migration

**Change:** Add a migration that adds `workspace_id` columns to all tables. Provide workspace-aware store implementations.

**Migration `0003_workspace_columns.sql`:**

```sql
-- Connections
alter table connections add column workspace_id text not null default 'default';
create index if not exists connections_workspace_idx on connections (workspace_id, service);

-- OAuth client configs
alter table oauth_client_configs add column workspace_id text not null default 'default';

-- Runtime tokens
alter table runtime_tokens add column workspace_id text not null default 'default';
alter table runtime_tokens add column role text not null default 'admin';
alter table runtime_tokens add column created_by text not null default 'admin';
create index if not exists runtime_tokens_workspace_idx on runtime_tokens (workspace_id);

-- Runs
alter table runs add column workspace_id text not null default 'default';
create index if not exists runs_workspace_idx on runs (workspace_id, started_at desc);
```

**New store classes:**

- `WorkspaceSqliteConnectionStore implements IWorkspaceConnectionStore`
- `WorkspaceSqliteOAuthConfigStore implements IWorkspaceOAuthConfigStore`
- `WorkspaceSqliteTokenStore implements IWorkspaceTokenStore`
- `WorkspaceSqliteRunLogStore implements IWorkspaceRunLogStore`

Each method adds `WHERE workspace_id = ?` to queries. For backward compatibility, the existing flat stores (`SqliteConnectionStore`, etc.) remain functional alongside the new workspace-aware stores.

**`SqliteRuntimeDatabase` changes:**

```typescript
export class SqliteRuntimeDatabase implements RuntimeDatabase {
  // Existing stores (unchanged, backward compat)
  readonly connectionStore: SqliteConnectionStore;
  // ...

  // NEW: workspace-aware stores
  readonly workspaceConnectionStore: WorkspaceSqliteConnectionStore;
  readonly workspaceOAuthConfigStore: WorkspaceSqliteOAuthConfigStore;
  readonly workspaceTokenStore: WorkspaceSqliteTokenStore;
  readonly workspaceRunLogStore: WorkspaceSqliteRunLogStore;
}
```

### 3.10 `src/server/cloudflare/cloudflare-env.ts` — Cloudflare bindings (future)

**No changes in this phase.** The D1 store (`src/server/storage/d1-runtime-store.ts`) will be updated when Phase 6 (Insforge migration) arrives. But `CloudflareEnv` types should note that D1 tables will eventually carry `workspace_id`.

### 3.11 `src/server/api/runtime-api.ts` — Runtime serializer changes

**Minimal changes:** `serializeRuntimeConnectedApp` already only exposes safe metadata (connection labels, not secrets). No change needed. But add a `workspaceId` field to response envelopes where relevant (future use).

---

## 4. Data Flow Walkthrough

### Scenario: Agent calls `list_apps` via MCP with a runtime token

1. **MCP client** sends POST `/mcp` with header `Authorization: Bearer oct_<token>`

2. **`createWorkspaceAuthMiddleware`** intercepts the request:
   - Reads Bearer token
   - Calls `runtimeTokens.verifyToken("oct_<token>")`
   - `verifyToken` hashes the token, looks up in `runtime_tokens` table via `findByHash`
   - Finds record with `workspaceId="ws_abc123"`, `role="member"`, `createdBy="user_xyz"`
   - Returns `WorkspaceContext { workspaceId: "ws_abc123", role: "member", userId: "user_xyz", tokenId: "tok_..." }`
   - Sets `context.set("workspaceContext", workspaceContext)`

3. **`handleMcp`** in `connect-server.ts`:
   - Reads `WorkspaceContext` from context var
   - Creates `scopedConnections = this.options.connections.forWorkspace("ws_abc123")`
   - Creates `createMcpServer({ ..., connections: scopedConnections, actions: scopedActions })`

4. **`list_apps` tool** in `mcp.ts`:
   - Iterates `options.catalog.providers` (global catalog, no workspace filter yet)
   - For each provider, calls `options.connections.getConnectionSummary(provider.service)`
   - This calls `workspaceStore.get("ws_abc123", "github", "default")` — scoped lookup
   - Returns only connections belonging to `ws_abc123`
   - As a "member", only sees connections created by `user_xyz` (future Phase 4 — for now, role filtering is not implemented and all workspace members see all workspace connections)

5. **Agent sees** only apps from the global catalog that have connections in workspace `ws_abc123`

### Scenario: Legacy single-user mode (no workspace token)

1. No `Authorization` header, or legacy admin token
2. Middleware sets `WorkspaceContext { workspaceId: "default", role: "admin", userId: "admin" }`
3. `forWorkspace("default")` uses the existing flat storage with default workspace
4. All existing behavior preserved — zero regression

---

## 5. Implementation Order

### Step 1: Data layer (migration + workspace stores)

1. Create `migrations/0003_workspace_columns.sql`
2. Create `WorkspaceSqliteConnectionStore`, `WorkspaceSqliteOAuthConfigStore`, `WorkspaceSqliteTokenStore`, `WorkspaceSqliteRunLogStore` in `sqlite-runtime-store.ts` (or a new `workspace-sqlite-store.ts`)
3. Add workspace store properties to `SqliteRuntimeDatabase`
4. Run `npm run fix-check` to verify

### Step 2: Types and token service

1. Define `WorkspaceContext`, `WorkspaceRole`, `WorkspaceTokenRecord` in `runtime-token-service.ts`
2. Extend `RuntimeTokenService.createToken` with `workspaceId`, `role`, `createdBy`
3. Change `verifyToken` return type to `WorkspaceContext | undefined`
4. Add `findTokenByHash` for cross-workspace lookup
5. Run `npm run fix-check`

### Step 3: Auth middleware

1. Create `createWorkspaceAuthMiddleware` in `src/server/api/auth.ts`
2. Add helper functions: `getWorkspaceContext`, `requireWorkspaceContext`
3. Export `workspaceContextVar` constant
4. Run `npm run fix-check`

### Step 4: ConnectionService scoping

1. Add `workspaceId` and `workspaceStore` to `ConnectionServiceOptions`
2. Implement workspace-aware store dispatch in constructor
3. Add `forWorkspace(workspaceId)` method
4. Run `npm run fix-check`

### Step 5: ActionRunner scoping

1. Add `forWorkspace(workspaceId)` to `ActionRunner`
2. Run `npm run fix-check`

### Step 6: ConnectServer route refactoring

1. Wire `createWorkspaceAuthMiddleware` in `createConnectApp`
2. In each route handler that uses connections, read `WorkspaceContext` and call `forWorkspace`
3. Update `handleMcp` to create scoped services
4. Run `npm run fix-check`

### Step 7: Validation

1. Start server with `npm run dev` (or `node --import tsx src/server/index.ts`)
2. Test legacy admin token: `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/v1/apps`
3. Create a runtime token: `curl -X POST http://localhost:3000/api/runtime-tokens -H "Content-Type: application/json" -d '{"name":"test"}'`
4. Use runtime token: `curl -H "Authorization: Bearer $RUNTIME_TOKEN" http://localhost:3000/v1/apps`
5. Test MCP: POST to `/mcp` with both token types
6. Verify connections are scoped (create connections with admin token, verify they appear/disappear with runtime token if different workspace)

---

## 6. Risks & Mitigations

| Risk                                                             | Mitigation                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking existing single-user users                              | All changes are additive. When `workspaceId` is absent, the code falls back to existing flat-storage behavior. Legacy `IConnectionStore` interface unchanged.                     |
| Migration adds columns but old code doesn't use them             | The `default 'default'` ensures all existing rows get a valid workspace_id. No query breaks.                                                                                      |
| Token verification becoming slower (cross-workspace hash lookup) | The hash index (`token_hash` column has UNIQUE) is global. With millions of tokens this could slow, but for Phase 3 (<1000 tokens) it's fine. Phase 6 adds DB-level partitioning. |
| `ConnectionService.forWorkspace` creating too many instances     | For the single-process Hono server, `forWorkspace` creates lightweight wrappers sharing the same catalog and provider loader. Memory overhead is negligible.                      |

---

## 7. Constitutional Compliance

| Principle                         | How this plan complies                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Locked Decisions**           | Follows all LOCKED.md decisions: runtime tokens are opaque hashes, bound to workspace membership and role, evaluated on every use. Member removal revokes tokens (enforced by `workspaceStore.list` filtering). |
| **II. Workspace Isolation**       | Every store operation filters by `workspaceId`. No workspace's data leaks to another. The Hono API is the sole boundary.                                                                                        |
| **III. Secrets Stay Trusted**     | `ConnectionService` does not expose credentials. MCP exposes only connection labels and safe metadata. No raw OAuth details in MCP or API responses.                                                            |
| **IV. Provider Runtime Contract** | No changes to provider definitions, executors, or catalog generation. The runtime remains lazy.                                                                                                                 |
| **V. Minimal Changes**            | Each change targets one module with one clear responsibility. No barrel files. No new dependencies. Reuses existing `IConnectionStore` pattern with additive workspace-aware versions.                          |

---

## 8. Files Summary

### New files

- `migrations/0003_workspace_columns.sql` — Schema migration

### Modified files (in implementation order)

1. `src/server/storage/runtime-database.ts` — New interfaces: `IWorkspaceConnectionStore`, `IWorkspaceOAuthConfigStore`, `IWorkspaceTokenStore`, `IWorkspaceRunLogStore`
2. `src/server/storage/sqlite-runtime-store.ts` — Workspace-aware store implementations, `SqliteRuntimeDatabase` extended
3. `src/server/storage/runtime-token-service.ts` — `WorkspaceContext`, `WorkspaceRole`, `WorkspaceTokenRecord` types; extended `RuntimeTokenService`
4. `src/server/api/auth.ts` — `createWorkspaceAuthMiddleware`, `getWorkspaceContext`, `requireWorkspaceContext`
5. `src/connection-service.ts` — Optional `workspaceId`/`workspaceStore` params, `forWorkspace()` method
6. `src/server/actions/action-runner.ts` — `forWorkspace()` method
7. `src/server/connect-app.ts` — Wire workspace-aware middleware, pass synthetic workspace ID
8. `src/server/connect-server.ts` — All connection-aware routes scoped; `handleMcp` scoped
9. `src/mcp.ts` — Optional `workspaceContext` in options; updated instructions

### Files intentionally NOT changed

- `src/catalog-store.ts` — Catalog remains global until Phase 4 (provider enablement per workspace)
- `src/server/api/runtime-api.ts` — Serializers already safe; no workspace metadata to expose yet
- `src/server/cloudflare/*` — D1 store addressed in Phase 6
- `src/providers/*` — Provider runtime contract unchanged
- `src/core/types.ts` — No changes needed

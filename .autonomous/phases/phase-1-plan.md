# Phase 1: Clerk Auth + Workspace Data Model + Scoped Storage

## Summary

Replace the current admin/runtime bearer-token auth with Clerk identity, introduce the workspace data model via SQLite migrations, and scope all connection storage to workspaces. Phase 1 stays on SQLite (local dev path per LOCKED.md) while being forwards-compatible with Insforge PostgreSQL.

## Constitutional Compliance

- **I. Locked Decisions**: Follows LOCKED.md — Clerk is sole human auth, one Clerk Org = one workspace, SQLite for local dev, API is sole browser→data boundary.
- **II. Workspace Isolation**: All tables gain `workspace_id` column. Every query filters by workspace. No cross-workspace data leakage.
- **III. Secrets**: Encryption unchanged (`ISecretCodec`), secrets remain workspace-scoped.
- **IV. Provider Runtime**: `IConnectionStore` interface preserved; `ConnectionService` unchanged except for workspace-scoped store calls. Catalog is not workspace-scoped in Phase 1.
- **V. Minimal Changes**: No barrel files, no `tsx`, no Prettier. Use native Node TypeScript, `oxfmt`/`oxlint`, `interface` for contracts.

---

## 1. New Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@clerk/backend": "^1.x"
  }
}
```

`@clerk/backend` provides `verifyToken()` for JWT validation and `createClerkClient()` for Organization membership queries (used only at auth time — no global Clerk client for runtime token validation; runtime tokens are verified locally against hashes per LOCKED.md).

## 2. New Files

### 2.1 `src/server/api/clerk-auth.ts` — Clerk Authentication Middleware

Replaces `src/server/api/auth.ts` entirely. Exports:

```typescript
export interface ClerkAuthOptions {
  /** Clerk secret key (from env CLERK_SECRET_KEY) */
  secretKey: string;
  /** Clerk publishable key (from env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) */
  publishableKey?: string;
  /** When true, auth is optional (for local dev without Clerk). */
  optional?: boolean;
}

export interface ClerkAuthSession {
  userId: string;
  /** The workspace ID derived from the active Clerk Organization. */
  workspaceId: string;
  /** Workspace role: member | manager | admin. Resolved from Connections DB. */
  role: WorkspaceRole;
  /** The Clerk session claims (for session management). */
  sessionClaims: Record<string, unknown>;
}

export type WorkspaceRole = "member" | "manager" | "admin";

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}
```

Middleware: `createClerkAuthMiddleware(options: ClerkAuthOptions): MiddlewareHandler`

**How it works:**

1. **Public path bypass**: Same public paths as current `isPublicPath()` — `/health`, `/oauth/callback`, `/api/auth/session` (but now from Clerk), `/api/files/*`, console shell paths.
2. **Extract JWT**: Read `Authorization: Bearer <clerk-session-token>` or `__session` cookie.
3. **Verify JWT**: `verifyToken(token, { secretKey })` from `@clerk/backend`. On failure → 401.
4. **Extract claims**: `sub` → `userId`, `org_id` → Clerk org ID.
5. **Resolve workspace**: Look up workspace by `clerk_org_id` in `workspaces` table. Create workspace row if it doesn't exist (first access auto-provisions — the workspace admin is the first user to access it; this happens at the application level via a dedicated setup endpoint, not the middleware).
6. **Resolve role**: Look up membership in `workspace_memberships` table by `workspace_id` + `user_id`. Default to `member` if no explicit role (workspace creator gets `admin` via setup endpoint).
7. **Set context**: Store `WorkspaceContext` on `context.set("workspace", { workspaceId, userId, role })`.
8. **Route scoping**: `/api/*` and `/v1/*` and `/mcp/*` require auth. Console shell paths (`GET /` etc.) require auth.

**Hono variable declaration** (module augmentation in same file):

```typescript
declare module "hono" {
  interface ContextVariableMap {
    workspace: WorkspaceContext;
  }
}
```

### 2.2 `src/server/api/workspace-helpers.ts` — Context Accessor

```typescript
import type { Context } from "hono";
import type { WorkspaceContext } from "./clerk-auth.ts";

export function getWorkspaceContext(c: Context): WorkspaceContext {
  const ctx = c.get("workspace");
  if (!ctx) {
    throw new Error("Workspace context not set — is clerk-auth middleware applied?");
  }
  return ctx;
}

/** Require role >= manager. Throws 403 if member. */
export function requireManager(c: Context): WorkspaceContext {
  const ctx = getWorkspaceContext(c);
  if (ctx.role === "member") {
    throw new HttpRequestError(403, "forbidden", "Manager role required.");
  }
  return ctx;
}
```

### 2.3 `src/server/api/clerk-routes.ts` — Clerk Session Endpoints

Replaces the old `/api/auth/session` handler:

```typescript
// GET /api/auth/session  → returns { userId, workspaceId, role, sessionClaims }
// POST /api/auth/logout  → clears session cookie (no-op in JWT world, but clears cookie)
// POST /api/auth/workspace  → switch active workspace (set active org)
```

### 2.4 `src/server/workspace-database.ts` — Workspace-Aware RuntimeDatabase Wrapper

New composite that wraps the existing `RuntimeDatabase` stores and adapts them for workspace scoping:

```typescript
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { WorkspaceContext } from "./api/clerk-auth.ts";

export interface WorkspaceScopedStore {
  connectionStore: WorkspaceConnectionStore;
  oauthClientConfigStore: WorkspaceOAuthClientConfigStore;
  oauthStateStore: WorkspaceOAuthStateStore;
  runtimeTokenStore: WorkspaceRuntimeTokenStore;
  runLogStore: WorkspaceRunLogStore;
}

export function createWorkspaceScopedStore(db: RuntimeDatabase, workspace: WorkspaceContext): WorkspaceScopedStore;
```

Each `Workspace*Store` implements the same interface as the original (`IConnectionStore`, etc.) but prepends `workspace_id` to all queries. For example:

```typescript
class WorkspaceConnectionStore implements IConnectionStore {
  constructor(
    private readonly delegate: IConnectionStore, // the underlying SqliteConnectionStore
    private readonly workspaceId: string,
  ) {}

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    // Delegate handles workspace_id filtering internally.
    // For Phase 1: the underlying SQLite store adds WHERE workspace_id = ? to every query.
  }
}
```

**Alternative (cleaner)**: Instead of wrapping, modify the actual SQLite store classes to accept `workspaceId` in their constructors and filter internally. The `WorkspaceScopedStore` factory creates them with the workspace from context.

## 3. Migration SQL

### `migrations/0003_workspaces.sql`

```sql
-- Workspaces table: maps Clerk Org ID to internal workspace ID.
create table if not exists workspaces (
  id text primary key,
  clerk_org_id text not null unique,
  name text not null,
  created_at text not null,
  updated_at text not null
);

-- Workspace memberships: maps user to workspace with role.
-- Roles are enforced by the application; Clerk only validates membership.
create table if not exists workspace_memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check(role in ('member', 'manager', 'admin')),
  created_at text not null,
  updated_at text not null,
  primary key (workspace_id, user_id)
);

-- Add workspace_id to all existing data tables.
-- Phase 1: use a default workspace for migration of existing local dev data.

alter table connections add column workspace_id text not null default 'default';
alter table connections add column created_by text not null default '';
alter table connections add column label text not null default '';

alter table oauth_client_configs add column workspace_id text not null default 'default';
alter table oauth_client_configs add column created_by text not null default '';

alter table oauth_states add column workspace_id text not null default 'default';

alter table runtime_tokens add column workspace_id text not null default 'default';
alter table runtime_tokens add column user_id text not null default '';

alter table runs add column workspace_id text not null default 'default';
alter table runs add column user_id text not null default '';

-- Rebuild primary keys / unique constraints to include workspace_id.
-- SQLite doesn't allow ALTER TABLE to change PKs, so we recreate.

-- connections: new composite key (workspace_id, service, connection_name)
create table connections_new (
  workspace_id text not null,
  service text not null,
  connection_name text not null default 'default',
  label text not null default '',
  value text not null,
  created_by text not null,
  updated_at text not null,
  primary key (workspace_id, service, connection_name)
);
insert into connections_new select workspace_id, service, connection_name, label, value, created_by, updated_at from connections;
drop table connections;
alter table connections_new rename to connections;

-- oauth_client_configs: new composite key (workspace_id, service)
create table oauth_client_configs_new (
  workspace_id text not null,
  service text not null,
  value text not null,
  created_by text not null,
  updated_at text not null,
  primary key (workspace_id, service)
);
insert into oauth_client_configs_new select workspace_id, service, value, created_by, updated_at from oauth_client_configs;
drop table oauth_client_configs;
alter table oauth_client_configs_new rename to oauth_client_configs;

-- oauth_states: new composite key (workspace_id, state)
create table oauth_states_new (
  workspace_id text not null,
  state text not null,
  value text not null,
  created_at text not null,
  primary key (workspace_id, state)
);
insert into oauth_states_new select workspace_id, state, value, created_at from oauth_states;
drop table oauth_states;
alter table oauth_states_new rename to oauth_states;

-- runtime_tokens: add workspace_id + user_id to PK
create table runtime_tokens_new (
  id text not null,
  workspace_id text not null,
  user_id text not null,
  name text not null,
  token_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text,
  primary key (workspace_id, id)
);
insert into runtime_tokens_new select id, workspace_id, user_id, name, token_hash, created_at, last_used_at, revoked_at from runtime_tokens;
drop table runtime_tokens;
alter table runtime_tokens_new rename to runtime_tokens;

-- runs: add workspace_id + user_id
create table runs_new (
  id text not null,
  workspace_id text not null,
  user_id text not null,
  service text,
  action_id text not null,
  started_at text not null,
  completed_at text not null,
  ok integer not null,
  value text not null,
  primary key (workspace_id, id)
);
insert into runs_new select id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value from runs;
drop table runs;
alter table runs_new rename to runs;

-- Indexes for workspace-scoped queries
create index if not exists connections_workspace_service_idx on connections (workspace_id, service);
create index if not exists runtime_tokens_workspace_user_idx on runtime_tokens (workspace_id, user_id);
create index if not exists runs_workspace_started_at_idx on runs (workspace_id, started_at desc, id desc);
create index if not exists runs_workspace_service_idx on runs (workspace_id, service, started_at desc, id desc);

-- Audit events table (new, for workspace activity tracking)
create table if not exists audit_events (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  event text not null,
  resource_type text not null,
  resource_id text,
  details text,
  created_at text not null
);
create index if not exists audit_events_workspace_idx on audit_events (workspace_id, created_at desc);
```

### `migrations/0004_workspace_indexes.sql` (optional, if more indexes needed after testing)

Reserved for query performance tuning post-implementation.

## 4. Modified Files

### 4.1 `src/server/api/auth.ts` → Replaced by `src/server/api/clerk-auth.ts`

**What changes**: The entire `createLocalAuthMiddleware`, `readLocalAuthSession`, `clearLocalAuthCookie`, and all helper functions are removed. The new middleware:

- Uses `@clerk/backend` JWT verification instead of HMAC-signed cookie + bearer token comparison.
- Sets `context.set("workspace", ...)` instead of the old cookie-based session.
- No longer has `admin` vs `runtime` scope distinction — Clerk handles all human auth; runtime tokens remain separate (see below).

### 4.2 `src/server/connect-server.ts`

**What changes**:

- Import `createClerkAuthMiddleware` instead of `createLocalAuthMiddleware`.
- Import `getWorkspaceContext` from workspace helpers.
- `IConnectServerOptions.auth` changes from `LocalAuthOptions` to `ClerkAuthOptions`.
- Route handler methods that need workspace context call `getWorkspaceContext(context)` at the top.
- `/api/auth/session` handler: replaced by Clerk session endpoint from `clerk-routes.ts`.
- `/api/auth/logout` handler: simplified to clear session.
- All connection, OAuth, token, and run handlers thread `workspaceId` and `userId` to the store.

Detailed handler changes:

```typescript
// Before (admin-scoped, no user tracking):
private async listConnections(context: Context): Promise<Response> {
  return context.json(await this.options.connections.listConnections());
}

// After (workspace-scoped):
private async listConnections(context: Context): Promise<Response> {
  const ws = getWorkspaceContext(context);
  return context.json(await this.options.connections.listConnections(ws.workspaceId));
}
```

### 4.3 `src/server/connect-app.ts`

**What changes**:

- `ConnectAppOptions` replaces `adminToken`, `runtimeToken` with `clerkSecretKey`, `clerkPublishableKey`.
- `auth` config passed to `ConnectServer` changes shape.
- Runtime token auth for `/v1` and `/mcp` paths: these routes now use Clerk for human auth AND require a runtime token for agent access. The middleware chain becomes:

```typescript
// Clerk middleware (required) + runtime token middleware (optional, for agent paths)
app.use("/v1/*", clerkAuth);
app.use("/v1/*", runtimeTokenAuth); // additional layer for agent tokens
app.use("/mcp/*", clerkAuth);
app.use("/mcp/*", runtimeTokenAuth);
```

**Runtime token middleware** (`src/server/api/runtime-token-auth.ts` — new file):

This is a thin middleware that checks for `Authorization: Bearer oct_...` tokens on `/v1/*` and `/mcp/*` paths. It verifies the token hash against `runtime_tokens` table, resolves the token's `user_id` + `workspace_id`, and sets those on the context. If no runtime token is present AND the request has a valid Clerk session, the Clerk identity is used (human is making the API call). This allows both human (Clerk) and agent (runtime token) access to the API.

### 4.4 `src/server/index.ts`

**What changes**:

- Read `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from env instead of `OOMOL_CONNECT_ADMIN_TOKEN` / `OOMOL_CONNECT_RUNTIME_TOKEN`.
- Pass `clerkSecretKey` to `createConnectApp`.
- Remove admin/runtime token log messages.
- Add local dev fallback: if `CLERK_SECRET_KEY` is not set, use `ClerkAuthOptions.optional = true` to allow unauthenticated access (single-user local dev mode).

```typescript
// Before:
const adminToken = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
const runtimeToken = process.env.OOMOL_CONNECT_RUNTIME_TOKEN;

// After:
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const clerkOptional = !clerkSecretKey; // local dev without Clerk

const { app, runtimeAuthConfigured } = await createConnectApp({
  // ...
  clerkSecretKey,
  clerkPublishableKey,
  clerkOptional,
  // adminToken / runtimeToken removed
});
```

### 4.5 `src/server/storage/sqlite-runtime-store.ts`

**What changes**: All store classes (`SqliteConnectionStore`, `SqliteOAuthClientConfigStore`, `SqliteOAuthStateStore`, `SqliteRuntimeTokenStore`, `SqliteRunLogStore`) are modified to accept `workspaceId: string` in their constructors and add `WHERE workspace_id = ?` to every query.

Example — `SqliteConnectionStore`:

```typescript
export class SqliteConnectionStore implements IConnectionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly secretCodec: ISecretCodec,
    private readonly workspaceId: string, // NEW
  ) {}

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    return await getConnectionJson({
      database: this.database,
      secretCodec: this.secretCodec,
      workspaceId: this.workspaceId,
      service,
      connectionName,
    });
  }
  // ... all methods add workspace_id filter
}
```

The `RuntimeDatabase` interface gains workspace-awareness:

```typescript
export interface RuntimeDatabase {
  createScopedStores(workspaceId: string): {
    connectionStore: IConnectionStore;
    oauthClientConfigStore: IOAuthClientConfigStore;
    oauthStateStore: IOAuthStateStore;
    runtimeTokenStore: IRuntimeTokenStore;
    runLogStore: IRunLogStore;
  };
  // Unscoped access for setup/management operations
  workspaceStore: IWorkspaceStore;
  membershipStore: IWorkspaceMembershipStore;
}
```

New supporting interfaces:

```typescript
export interface IWorkspaceStore {
  getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined>;
  getById(id: string): Promise<Workspace | undefined>;
  create(workspace: Workspace): Promise<void>;
}

export interface IWorkspaceMembershipStore {
  getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined>;
  setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}
```

### 4.6 `src/server/storage/runtime-database.ts`

**What changes**: Add `IWorkspaceStore` and `IWorkspaceMembershipStore` to the `RuntimeDatabase` interface. Add `createScopedStores(workspaceId)` method.

### 4.7 `src/server/storage/d1-runtime-store.ts`

**What changes**: Mirror the SQLite changes — all store classes accept `workspaceId` and filter queries by it. Forward-compatible with Insforge D1/PostgreSQL.

### 4.8 `src/server/storage/runtime-token-service.ts`

**What changes**: `RuntimeTokenRecord` gains `workspaceId` and `userId`. `RuntimeTokenService` methods accept workspace context:

```typescript
export interface RuntimeTokenRecord {
  id: string;
  workspaceId: string;   // NEW
  userId: string;         // NEW
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

// createToken now takes workspaceId + userId
async createToken(workspaceId: string, userId: string, name: string): Promise<RuntimeTokenCreation>

// verifyToken returns the resolved context on success
async verifyToken(token: string): Promise<{ workspaceId: string; userId: string } | undefined>
```

### 4.9 `src/server/storage/runtime-store.ts`

**What changes**: `RunLog` gains `workspaceId` and `userId`:

```typescript
export type RunLog = {
  id: string;
  workspaceId: string;
  userId: string;
  service: string;
  actionId: string;
  // ... rest unchanged
};
```

### 4.10 `src/connection-service.ts`

**What changes**: `IConnectionStore` interface gains optional workspace-scoped variants. For Phase 1, the interface stays the same but the implementation filters by workspace. The `ConnectionService` methods that accept a connection name continue to work — the workspace filter is handled by the store.

No interface change needed for Phase 1 since workspace filtering is transparent at the store layer. `ConnectionService` already delegates to `IConnectionStore`.

### 4.11 `src/server/actions/action-runner.ts`

**What changes**: Pass `workspaceId` and `userId` to run log storage:

```typescript
// Before:
runLogStore.add({ id, service, actionId, ... });

// After:
const ws = getWorkspaceContext(context);
runLogStore.add({ id, workspaceId: ws.workspaceId, userId: ws.userId, service, actionId, ... });
```

## 5. Hono Middleware Chain (Final)

```
Request
  → cache-control middleware (unchanged)
  → health endpoint (unchanged, public)
  → Clerk auth middleware (NEW — replaces createLocalAuthMiddleware)
      - Public paths: /health, /oauth/callback, /api/files/:id (GET)
      - Verifies Clerk JWT from Authorization header or __session cookie
      - Resolves workspace + role from DB
      - Sets context.workspace
  → Runtime token middleware (NEW — for /v1/* and /mcp/*)
      - If Bearer token starts with "oct_": verify hash, resolve workspace+user
      - Otherwise: fall through to Clerk identity
      - Sets context.workspace (overrides if runtime token is present)
  → Route handlers
      - Call getWorkspaceContext(c) to access workspaceId, userId, role
      - All data operations use workspace-scoped stores
```

## 6. Local Dev Mode (No Clerk)

When `CLERK_SECRET_KEY` is not set:

- `ClerkAuthOptions.optional = true`
- Middleware sets a default `WorkspaceContext` with `workspaceId = "default"`, `userId = "local-dev"`, `role = "admin"`.
- This matches current single-user behavior and the migration default workspace.
- A clear warning is logged: "Clerk authentication is disabled; running in local dev mode."

## 7. Verification Steps

1. **Migration rollback**: Run migrations on a copy of existing `data/connect.sqlite`. Verify all existing data survives with `workspace_id = 'default'`.
2. **Clerk JWT flow**: Set `CLERK_SECRET_KEY` to a test Clerk instance. Hit `/api/connections` with a valid Clerk session token. Verify 200 with workspace-scoped results.
3. **Runtime tokens**: Create a runtime token via `/api/runtime-tokens`. Use it on `/v1/providers`. Verify workspace isolation.
4. **Cross-workspace isolation**: Create two workspaces, connect different accounts in each. Verify each workspace only sees its own connections.
5. **Local dev mode**: Run without `CLERK_SECRET_KEY`. Verify all `/api/*` and `/v1/*` endpoints work as before (single-user, no auth required).
6. **Run `npm run fix-check`** — lint, format, typecheck pass.
7. **Existing tests**: Run `npm test`. SQLite store tests need updating to pass `workspaceId`.

## 8. Risks and Mitigations

| Risk                                              | Mitigation                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Existing SQLite data migration fails              | Migration creates new tables with `insert into ... select`. Test on prod-shaped data first.                                     |
| Clerk JWT verification latency                    | `verifyToken` has a local JWKS cache. Acceptable latency for auth middleware.                                                   |
| Runtime token verification is O(n) in token count | Current `IRuntimeTokenStore.list()` scans all rows. Add `findByHash(hash)` method to the interface for O(1) lookups in Phase 1. |
| D1RuntimeStore needs same changes                 | Mirror all SQLite changes in the D1 store. They share the same interface contracts.                                             |
| `ConnectionService` assumes global store          | It already uses injected `IConnectionStore`. No change needed — workspace filtering is at the store layer.                      |

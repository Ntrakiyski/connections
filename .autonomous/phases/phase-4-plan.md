# Phase 4: Workspace UI Implementation Plan

## 1. Context & Prerequisites

### 1.1 Current Architecture

**Web console** (`web/src/`):

- React 19 + Vite + React Router v7 (`react-router` 7.x)
- shadcn/ui components under `web/src/components/ui/`
- I18n via `@embra/i18n/react`
- Styling: UnoCSS (utility-first) + CSS in `style.css`
- Entry: `main.tsx` wraps `App` in `BrowserRouter` + `I18nProvider`
- Key files:
  - `ui.tsx` — `App`, `AppShell`, `UnlockView`, auth state machine, `loadRuntimeData`
  - `api.ts` — `apiGet`, `apiPost`, `apiPut`, `apiDelete` (fetch wrappers with optional `bearerToken`)
  - `model.ts` — TypeScript types: `AppData`, `ConnectionRecord`, `ProviderDefinition`, `RunLog`, `AuthSession`, etc.
  - `overview-page.tsx` — dashboard with metrics, call trend chart, recent calls
  - `providers-page.tsx` — provider catalog browser + per-provider detail/connection/OAuth forms
  - `runs-page.tsx` — run log table with pagination + service filter
  - `access-page.tsx` — runtime token CRUD (create named token, revoke, copy)
  - `resources-page.tsx` — MCP endpoint + config snippet + doc links
  - `shared-ui.tsx` — `Badge`, `EmptyState`, `InlineError`, `ProviderIcon`, `StatusDot`, `FormStatus`

**Server API** (`src/server/`):

- `connect-server.ts` — Hono app with all routes. Already calls `services(context)` which resolves services per workspace via `getWorkspaceContext()`.
- `api/clerk-auth.ts` — Middleware that verifies Clerk session token, extracts `org_id → workspaceId`, resolves role from membership store. Sets `workspace` and `clerkSession` context variables.
- `api/clerk-routes.ts` — Registers:
  - `GET /api/auth/session` — returns `ClerkAuthSession` (extends `WorkspaceContext` with `sessionClaims`)
  - `POST /api/auth/logout` — clears `__session` cookie
  - `POST /api/auth/workspace` — returns current `WorkspaceContext`
- `api/workspace-helpers.ts` — `getWorkspaceContext()` and `requireManager()` helpers

### 1.2 How Workspace Scoping Already Works on the Server

The Clerk auth middleware runs on every request:

1. Reads the `__session` cookie (Clerk session JWT)
2. Verifies it with Clerk's backend SDK
3. Extracts `sub` (userId) and `org_id` (clerkOrgId)
4. Looks up or auto-creates the workspace from `clerkOrgId`
5. Resolves the user's role (`admin` | `manager` | `member`) from the membership store
6. Sets `context.var.workspace = { workspaceId, userId, role }`

All API handlers call `this.services(context)` which passes the workspace context to `createWorkspaceServices()`. This means **the server already isolates data by workspace** — providers, connections, runs, tokens, OAuth configs are all workspace-scoped at the storage layer.

The web console currently has **no workspace awareness** — it treats the session as a single-tenant experience. Phase 4 adds workspace selection and role-aware UI to the browser.

### 1.3 Key Product Decisions (from LOCKED.md & VISION.md)

- Clerk Organization = Workspace. A user can belong to multiple orgs and switch between them in the web app.
- Roles: **Member** (own connections/tokens/runs only), **Manager** (all connections/runs + configure providers), **Admin** (manager capabilities + member management).
- Workspace creator is first admin; must always retain ≥1 admin.
- Members see only their own connections; managers/admins see all workspace connections.
- Members see only runs through their own tokens/connections; managers/admins see all runs.
- Only admins invite/remove members and change roles.

---

## 2. Implementation Plan

### 2.1 Workspace Selector in Sidebar

#### 2.1.1 New Server Endpoints

**`GET /api/auth/workspaces`** — List available workspaces for the authenticated user.

```typescript
// Response type
interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  role: "admin" | "manager" | "member";
}
// Returns: WorkspaceSummary[]
```

This endpoint queries the membership store for all workspaces the current user belongs to. It's needed because a user may belong to multiple Clerk organizations, and the web console needs to show all of them.

**`POST /api/auth/workspace/switch`** — Switch the active workspace.

```typescript
// Request body: { workspaceId: string }
// Response: { workspaceId, name, role }
```

The server updates the session to associate with the new workspace. This may involve:

- Updating the Clerk session's active organization (via Clerk API)
- Or storing the active workspace preference server-side

**Implementation note**: Clerk's `__session` cookie carries the active `org_id`. Switching organizations in Clerk updates this cookie. The simplest approach is to use Clerk's frontend SDK (`@clerk/clerk-react`) for organization switching, which handles cookie updates automatically. The server middleware then picks up the new `org_id` on the next request.

**Alternative simpler approach**: If we use Clerk's `<OrganizationSwitcher>` component directly, we don't need custom switch endpoints. The Clerk component handles org switching, and the server middleware automatically resolves the new workspace on the next data load. The web console just needs to re-fetch data when the org changes.

#### 2.1.2 New React Components

**`web/src/workspace-selector.tsx`** — Sidebar workspace selector.

```typescript
// Component tree:
// WorkspaceSelector
//   └── WorkspaceSelectorTrigger (shows current workspace name + role badge)
//   └── WorkspaceSelectorDropdown (popover/menu)
//         ├── WorkspaceListItem[] (each workspace: name, role badge, "active" indicator)
//         └── "Create Workspace" / "Join Workspace" link (delegates to Clerk)
```

**Props**:

- `workspaces: WorkspaceSummary[]` — from `GET /api/auth/workspaces`
- `activeWorkspaceId: string`
- `onSwitch(workspaceId: string): Promise<void>`

**Behavior**:

- Renders in the sidebar above the nav items (between brand and nav)
- Shows current workspace name with a role badge (`Admin` / `Manager` / `Member`)
- Click opens a dropdown listing all workspaces
- Each item shows workspace name + user's role
- Active workspace is highlighted
- Clicking a different workspace triggers `onSwitch`
- During switch: disable selector, show spinner
- On error: show toast/alert, keep current workspace
- After successful switch: trigger full data reload in parent `App`

**Alternative: Clerk `<OrganizationSwitcher>`**  
If we use Clerk's React SDK, the workspace selector becomes a styled wrapper around `<OrganizationSwitcher>`. The Clerk component handles the org switching UX and cookie management. The web console listens for org change events and reloads data. This is the **recommended approach** as it avoids building custom org management that Clerk already provides.

**Decision**: Use Clerk's `<OrganizationSwitcher>` with custom styling to match the Connections sidebar design. Listen for the `clerk:organization-change` event to trigger data reload.

#### 2.1.3 Integration into AppShell

Modify `ui.tsx` → `AppShell`:

```typescript
// In the sidebar <aside>:
<div className="brand">...</div>
<WorkspaceSelector
  onWorkspaceChange={refresh}  // triggers full data reload
/>
<nav className="sidebar-nav">...</nav>
```

The `refresh` callback (already exists as `onRefresh` prop) triggers `setRefreshToken` which causes `loadRuntimeData` to re-run with the new Clerk session (which now has the new org_id).

#### 2.1.4 Auth Session Changes

Extend `AuthSession` in `ui.tsx`:

```typescript
export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  // New fields:
  workspaceId: string;
  workspaceName: string;
  role: "admin" | "manager" | "member";
}
```

Update `loadRuntimeData` to fetch workspace info from `POST /api/auth/workspace` and include it in the `AuthSession`.

---

### 2.2 Workspace-Scoped API Calls

#### 2.2.1 Current State

The API endpoints are **already workspace-scoped on the server**. The Clerk middleware sets `workspaceId` on every request, and `createWorkspaceServices()` scopes all storage operations to that workspace. No changes needed to the server API endpoints themselves.

The web console currently calls:

- `GET /api/auth/session`
- `GET /api/providers`
- `GET /api/connections`
- `GET /api/oauth/configs`
- `GET /api/runtime-tokens`
- `GET /api/runs`
- `POST /api/runtime-tokens`, `DELETE /api/runtime-tokens/:id`
- `PUT /api/connections/:service`, `DELETE /api/connections/:service`
- `PUT /api/oauth/configs/:service`, `DELETE /api/oauth/configs/:service`
- `POST /api/oauth/authorizations`
- `POST /api/auth/logout`

#### 2.2.2 What Changes

**No API path changes needed.** All existing endpoints are workspace-scoped by the server middleware.

**What the web console needs to do differently**:

1. When workspace changes (Clerk org switch), re-run `loadRuntimeData()` — already handled by the `refresh` mechanism
2. Show workspace name/role in the UI header
3. Conditionally show/hide UI elements based on role (see §2.5)

#### 2.2.3 New API Calls for Phase 4

| Method   | Path                                  | Purpose                             | Role Required |
| -------- | ------------------------------------- | ----------------------------------- | ------------- |
| `GET`    | `/api/auth/workspaces`                | List user's workspaces              | authenticated |
| `GET`    | `/api/workspace/settings`             | Get workspace settings (name, etc.) | authenticated |
| `PUT`    | `/api/workspace/settings`             | Update workspace settings           | admin         |
| `GET`    | `/api/workspace/members`              | List workspace members              | admin         |
| `POST`   | `/api/workspace/members/invite`       | Invite member (delegates to Clerk)  | admin         |
| `DELETE` | `/api/workspace/members/:userId`      | Remove member                       | admin         |
| `PUT`    | `/api/workspace/members/:userId/role` | Change member role                  | admin         |
| `DELETE` | `/api/workspace`                      | Delete workspace                    | admin         |

---

### 2.3 Workspace Settings Page

#### 2.3.1 New Route & Component

**`web/src/workspace-settings-page.tsx`** — Workspace configuration page.

```typescript
// Route: /workspace/settings
// Only visible to admins (nav item hidden for members/managers)

interface WorkspaceSettings {
  workspaceId: string;
  name: string;
  clerkOrgId: string;
  createdAt: string;
  memberCount: number;
}
```

**Sub-components**:

- `WorkspaceGeneralSettings` — name display, creation date, member count
- `WorkspaceDangerZone` — delete workspace button with destructive confirmation dialog (requires typing workspace name)

**Delete workflow**:

1. User clicks "Delete Workspace"
2. Modal/dialog appears: "This will immediately make the workspace unavailable. A backup is retained for 14 days. Type the workspace name to confirm."
3. Text input for workspace name confirmation
4. "Delete Workspace" button (red/destructive) only enabled when name matches
5. On confirm: `DELETE /api/workspace` → on success, redirect to workspace selector or logout

#### 2.3.2 API Endpoints (Server-Side)

**`GET /api/workspace/settings`** → `WorkspaceSettings`

**`PUT /api/workspace/settings`** → requires admin. Request body: `{ name?: string }`. Currently workspace name comes from Clerk org name; allow override in Connections DB.

**`DELETE /api/workspace`** → requires admin. Implements the deletion lifecycle from LOCKED.md: immediate unavailability, 14-day encrypted backup, permanent erasure after.

These endpoints need corresponding handlers in `connect-server.ts` (or a new `workspace-routes.ts`).

#### 2.3.3 Navigation Integration

Add to `navItems` in `ui.tsx`:

```typescript
{ path: "/workspace/settings", labelKey: "nav.settings", icon: Settings, roles: ["admin"] },
```

The `roles` filter controls visibility. The nav item only renders if `authSession.role` is in the roles array.

---

### 2.4 Member Management UI

#### 2.4.1 New Route & Component

**`web/src/workspace-members-page.tsx`** — Member list + management.

```typescript
// Route: /workspace/members
// Only visible to admins

interface WorkspaceMember {
  userId: string;
  name: string; // from Clerk user profile
  email: string; // from Clerk user profile
  role: "admin" | "manager" | "member";
  joinedAt: string;
}
```

**Sub-components**:

- `MemberList` — table of members with columns: name, email, role, joined date, actions
- `MemberRow` — single member row
  - Role shown as a badge (`Admin` / `Manager` / `Member`)
  - Role change dropdown (only for admins, can't demote last admin)
  - Remove button (with confirmation dialog)
  - "You" indicator for current user
- `InviteMemberButton` — opens Clerk's invitation flow (or a dialog that triggers Clerk's organization invitation API)

**Rules enforced in UI** (backed by server authorization):

- Can't change your own role (to prevent accidental lockout)
- Can't remove the last admin
- Can't remove yourself
- Only admins see this page
- Role change is immediate

#### 2.4.2 API Endpoints (Server-Side)

**`GET /api/workspace/members`** → `WorkspaceMember[]` — requires admin.

Lists all members with their roles. The server queries the membership store and enriches with Clerk user profile data (name, email) via Clerk's Backend API.

**`PUT /api/workspace/members/:userId/role`** → requires admin.
Request: `{ role: "admin" | "manager" | "member" }`.
Server enforces: can't change own role, can't remove last admin.

**`DELETE /api/workspace/members/:userId`** → requires admin.
Server enforces: can't remove self, can't remove last admin.
On removal: revokes all runtime tokens for that user in this workspace, disconnects their provider accounts.

**`POST /api/workspace/members/invite`** → requires admin.
Request: `{ email: string, role?: "admin" | "manager" | "member" }`.
Server calls Clerk Organization Invitations API. Clerk sends the invitation email.

#### 2.4.3 Server-Side Implementation

New file: `src/server/api/workspace-routes.ts`

```typescript
export function registerWorkspaceRoutes(app: Hono): void {
  app.get("/api/auth/workspaces", ...);
  app.get("/api/workspace/settings", ...);
  app.put("/api/workspace/settings", requireManager, ...);
  app.get("/api/workspace/members", requireManager, ...);
  app.put("/api/workspace/members/:userId/role", requireManager, ...);
  app.delete("/api/workspace/members/:userId", requireManager, ...);
  app.post("/api/workspace/members/invite", requireManager, ...);
  app.delete("/api/workspace", requireManager, ...);
}
```

All handlers use `getWorkspaceContext(context)` to get `{ workspaceId, userId, role }` and verify admin role where needed.

---

### 2.5 Role-Based Visibility

#### 2.5.1 Rules Summary

| Capability                          | Member | Manager | Admin |
| ----------------------------------- | ------ | ------- | ----- |
| See own connections                 | ✅     | ✅      | ✅    |
| See all workspace connections       | ❌     | ✅      | ✅    |
| Connect/disconnect own accounts     | ✅     | ✅      | ✅    |
| Disconnect any workspace connection | ❌     | ✅      | ✅    |
| Enable/configure providers          | ❌     | ✅      | ✅    |
| Configure OAuth apps                | ❌     | ✅      | ✅    |
| See own runs                        | ✅     | ✅      | ✅    |
| See all workspace runs              | ❌     | ✅      | ✅    |
| Create/revoke own runtime tokens    | ✅     | ✅      | ✅    |
| Workspace settings                  | ❌     | ❌      | ✅    |
| Member management                   | ❌     | ❌      | ✅    |
| Delete workspace                    | ❌     | ❌      | ✅    |

#### 2.5.2 Implementation Strategy

**Server-side enforcement (primary)**:
The server already has `requireManager()` helper. Add `requireAdmin()` helper:

```typescript
// In workspace-helpers.ts
export function requireAdmin(context: Context): WorkspaceContext {
  const workspace = getWorkspaceContext(context);
  if (workspace.role !== "admin") {
    throw new HttpRequestError("forbidden", "Admin role required.", 403);
  }
  return workspace;
}
```

Existing endpoints that need role enforcement:

- Provider config mutation (`PUT/DELETE /api/oauth/configs/:service`) → require `requireManager`
- Connection mutations (members can only modify own connections) → server-side filtering
- Run listing (members see only own) → server-side filtering

**Client-side visibility (UX)**:

- Nav items filtered by role (settings, members hidden for non-admins)
- Buttons/actions conditionally rendered based on `authSession.role`
- The data already comes back scoped from the server, so the UI just displays what it receives

#### 2.5.3 Passing Role Context

The `AuthSession` type already includes `role`. Pass it through to pages via `AppData` or a separate context.

**Option A: Extend AppData** (simplest, consistent with existing pattern):

```typescript
export interface AppData {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  oauthConfigs: OAuthConfig[];
  runtimeTokens: RuntimeTokenSummary[];
  runs: RunLog[];
  runsNextCursor?: string;
  // New:
  role: "admin" | "manager" | "member";
  workspaceId: string;
  workspaceName: string;
}
```

Pages receive `AppData` already and can check `data.role` to conditionally render UI.

**Option B: React Context** (cleaner separation):
Create a `WorkspaceContext` that holds `{ workspaceId, workspaceName, role }` and wrap the app in a provider. This avoids threading role through every page prop.

**Recommendation**: Option A for Phase 4 (minimal change to existing patterns). Pages that need role awareness already receive `AppData`.

#### 2.5.4 Specific Page Changes

**`providers-page.tsx`**:

- Provider config/OAuth setup buttons hidden for members
- Connection actions: members can only disconnect their own connections
- "Connect" buttons: visible to all, but server enforces member can only connect their own accounts

**`runs-page.tsx`**:

- No UI changes needed. Server already filters runs by role (members see own, managers/admins see all). The page just displays what it receives.

**`access-page.tsx`**:

- No changes needed. Members create/revoke their own tokens; the server scopes to the current user automatically.

**`ui.tsx`**:

- Nav items filtered by role:
  ```typescript
  { path: "/workspace/settings", labelKey: "nav.settings", icon: Settings, roles: ["admin"] },
  { path: "/workspace/members", labelKey: "nav.members", icon: Users, roles: ["admin"] },
  ```

---

## 3. State Management

### 3.1 Current Flow

```
App (useState: data, authSession, loading, refreshToken)
  └── useEffect → loadRuntimeData(refreshToken)
        ├── GET /api/auth/session → AuthSession
        ├── GET /api/providers → ProviderDefinition[]
        ├── GET /api/connections → ConnectionRecord[]
        ├── GET /api/oauth/configs → OAuthConfig[]
        ├── GET /api/runtime-tokens → RuntimeTokenSummary[]
        └── GET /api/runs → RunLogPage
  └── AppShell (receives data, authSession)
        └── Routes → each page receives relevant data slice
```

### 3.2 Phase 4 Changes

**Keep the same pattern — no new state library needed.**

Changes to `loadRuntimeData`:

```typescript
export async function loadRuntimeData(unlockToken: string): Promise<RuntimeLoadResult> {
  const authSession = await apiGet<AuthSession>("/api/auth/session", { bearerToken: unlockToken });
  if (!authSession.authenticated) {
    return { authSession, data: emptyData };
  }

  // NEW: Ensure we have workspace context
  const workspace = await apiGet<WorkspaceContext>("/api/auth/workspace");

  const [providers, connections, oauthConfigs, runtimeTokens, runPage] = await Promise.all([
    apiGet<ProviderDefinition[]>("/api/providers"),
    apiGet<ConnectionRecord[]>("/api/connections"),
    apiGet<OAuthConfig[]>("/api/oauth/configs"),
    apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens"),
    apiGet<RunLogPage>("/api/runs"),
  ]);

  return {
    authSession: {
      ...authSession,
      workspaceId: workspace.workspaceId,
      role: workspace.role,
    },
    data: {
      providers,
      connections,
      oauthConfigs,
      runtimeTokens,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
      role: workspace.role,
      workspaceId: workspace.workspaceId,
    },
  };
}
```

**Workspace switching** (triggered by Clerk org change):

1. Clerk `<OrganizationSwitcher>` changes active org → `__session` cookie updates
2. The web console listens for `clerk:organization-change` event
3. On event: call `refresh()` → `setRefreshToken` increments → `loadRuntimeData` re-runs
4. All data re-fetches with the new workspace cookie → server resolves new workspace

---

## 4. File-by-File Changes

### 4.1 New Files

| File                                  | Purpose                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `web/src/workspace-selector.tsx`      | Workspace selector sidebar component (wraps Clerk `<OrganizationSwitcher>`) |
| `web/src/workspace-settings-page.tsx` | Workspace settings + danger zone                                            |
| `web/src/workspace-members-page.tsx`  | Member list, invite, role change, removal                                   |
| `src/server/api/workspace-routes.ts`  | New API endpoints for workspace settings, members, switching                |

### 4.2 Modified Files

| File                                  | Changes                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/src/ui.tsx`                      | Extend `AuthSession` with workspace fields; add workspace selector to sidebar; add workspace settings + members routes; filter nav by role; listen for Clerk org change events |
| `web/src/model.ts`                    | Add `WorkspaceMember`, `WorkspaceSettings`, `WorkspaceSummary` types; extend `AppData` with `role` and `workspaceId`                                                           |
| `web/src/api.ts`                      | No changes (existing fetch wrappers suffice)                                                                                                                                   |
| `web/src/providers-page.tsx`          | Hide manager/admin-only controls for members                                                                                                                                   |
| `web/src/overview-page.tsx`           | Show workspace name in header                                                                                                                                                  |
| `src/server/connect-server.ts`        | Register workspace routes                                                                                                                                                      |
| `src/server/api/clerk-routes.ts`      | Add `GET /api/auth/workspaces` endpoint                                                                                                                                        |
| `src/server/api/workspace-helpers.ts` | Add `requireAdmin()` helper                                                                                                                                                    |

### 4.3 No Changes Needed

- `web/src/runs-page.tsx` — server already scopes runs by role
- `web/src/access-page.tsx` — server already scopes tokens by user
- `web/src/resources-page.tsx` — static content, no role dependency
- `web/src/shared-ui.tsx` — reusable components unchanged
- All `web/src/components/ui/*.tsx` — unchanged
- `web/src/main.tsx` — unchanged (if Clerk provider is added at a higher level or via script tag)

---

## 5. Implementation Order

1. **Server foundation**: Add workspace routes + `requireAdmin` helper + `/api/auth/workspaces`
2. **Auth session extension**: Extend `AuthSession` and `AppData` types with workspace/role fields
3. **Workspace selector**: Build `WorkspaceSelector` component, integrate into sidebar, wire up Clerk org change events
4. **Role-aware nav**: Filter nav items by role
5. **Workspace settings page**: Build settings page + danger zone delete flow
6. **Member management page**: Build member list, role change, invite, remove UI
7. **Provider page role gating**: Hide admin-only controls from members
8. **i18n**: Add all new translation keys for English + any other supported languages

---

## 6. Constitution Compliance Checklist

| Principle                     | Compliance                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Locked Decisions           | All rules from LOCKED.md honored: roles, visibility, member removal, workspace deletion 14-day backup                                               |
| II. Workspace Isolation       | Server already enforces via `createWorkspaceServices()` — no cross-workspace data leakage possible                                                  |
| III. Secrets Stay Trusted     | No OAuth secrets exposed to browser. MCP tokens stay opaque. No changes to secret handling                                                          |
| IV. Provider Runtime Contract | No provider runtime changes. Only web console UI + workspace admin routes                                                                           |
| V. Minimal Changes            | Uses existing patterns: React Router routes, shadcn/ui components, apiGet/apiPost. No new state library. No new dependencies except Clerk React SDK |

---

## 7. Risks & Open Questions

1. **Clerk React SDK integration**: The current web console does not use `@clerk/clerk-react`. Adding it requires wrapping the app in `<ClerkProvider>`. This is a dependency addition — confirm it's acceptable per Constitution V.

2. **Workspace switching without Clerk React SDK**: Alternative is to build a custom workspace list from `GET /api/auth/workspaces` and use Clerk's backend API to switch the active organization. This avoids adding the Clerk React SDK but requires more custom code.

3. **Server-side role enforcement for existing endpoints**: Some endpoints (connections, runs) need server-side changes to filter by role for members. This should be handled before the UI changes to avoid security gaps.

4. **Invite flow**: Inviting members requires Clerk Organization Invitations API. This may need the Clerk secret key configured on the server and appropriate Clerk dashboard settings.

5. **Last-admin guard**: Both UI and server must enforce that the last admin cannot be removed or demoted. Needs server-side enforcement as the authoritative check.

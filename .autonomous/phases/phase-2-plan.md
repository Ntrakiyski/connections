# Phase 2: Workspace-Scoped Connections & Tokens

## Status: Absorbed into Phase 3

Phase 2 was originally planned as a standalone phase for workspace-scoped
connection storage and runtime token binding. During Phase 3 implementation
(Workspace-Aware MCP), the following Phase 2 deliverables were implemented
as prerequisites:

## What was built (in Phase 3)

### Workspace-scoped connections

- `ConnectionService.forWorkspace(workspaceId)` — factory method returning
  a scoped instance sharing the same catalog and provider loader
- All `IConnectionStore` operations filter by `workspace_id` via the
  `RuntimeDatabase.createScopedStores(workspaceId)` factory from Phase 1
- `ConnectionService` constructor accepts optional `workspaceId` and
  `workspaceStore`; falls back to flat store when absent (backward compat)
- Workspace-aware connection tests: 16/16 passed in
  `src/connection-service.test.ts`

### Runtime token workspace binding

- `RuntimeTokenRecord` extended with `workspaceId`, `userId`, `role`
- `verifyToken()` returns `WorkspaceContext` instead of `boolean`
- Role resolved from current workspace membership on every request
  (per LOCKED.md — no stale role snapshots on tokens)
- Token store tests (SQLite + D1): 17/17 passed

### API route scoping

- All `/v1/*` and `/api/*` routes read `WorkspaceContext` from Hono
  context variables
- `getWorkspaceContext()` helper extracts workspace from middleware
- Admin/runtime token auth replaced with workspace-aware middleware

## Evidence

See Phase 3 evidence files for test results covering Phase 2 deliverables:

- `.autonomous/evidence/phase-3-result.md`
- `.autonomous/evidence/phase-3-handoff.json`

## Verification

- Focused workspace store tests: 17 passed
- Connection service scoping tests: 16 passed
- Runtime token verification: returns workspace context
- `npm run fix-check`: passed

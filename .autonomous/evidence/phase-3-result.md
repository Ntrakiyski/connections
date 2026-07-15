# Phase 3 Result

## Outcome

Workspace-aware MCP now uses the request workspace to resolve pre-scoped connections and action runners. MCP instructions state that connections are limited to the current workspace. Runtime-token verification returns the token ID together with workspace and user identity; the effective role is resolved from current workspace membership on each request, preserving immediate role-change enforcement.

`migrations/0003_workspaces.sql` already existed from Phase 1 and supplies the required workspace columns and indexes, so no duplicate migration was created.

## Verification

- Red/green MCP instruction check: `npm test -- src/mcp.test.ts` — 7/7 passed after implementation.
- Red/green local workspace middleware check: `npm test -- src/server/api/auth.test.ts` — passed.
- Red/green scoped service checks: `npm test -- src/connection-service.test.ts` — 16/16 passed; token-store checks passed 17/17 across SQLite and D1.
- Focused combined suite: `npm test -- src/server/api/auth.test.ts src/connection-service.test.ts src/mcp.test.ts src/server/storage/sqlite-runtime-store.test.ts src/server/storage/d1-runtime-store.test.ts src/server/connect-server.test.ts` — 84/84 passed.
- Required project check: `npm run fix-check` — passed; generated provider registries were already current and TypeScript checked `src`, `scripts-all`, and `examples`.
- Full suite: `npm test` — 403/405 passed. The two failures are `src/providers/jumpserver/runtime.test.ts`, both blocked before test execution by `listen EPERM: operation not permitted 127.0.0.1` in this sandbox.

## Boundaries

- `connections-docs/LOCKED.md` takes precedence over the draft plan's persisted token-role suggestion: token roles are not stored as stale snapshots. Current membership is checked for each runtime-token request.
- Existing `RuntimeDatabase.createScopedStores(workspaceId)` remains the one store-scoping mechanism. The four workspace-addressed interfaces document the matching public contracts without duplicating SQLite/D1 query implementations.

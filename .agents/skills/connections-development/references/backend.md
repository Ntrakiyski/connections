# Backend reference

## Contents

- Composition and route families
- Authentication and workspace context
- Roles, services, and storage
- Provider, OAuth, action, and MCP flow
- Error contracts and logs
- Tests and known hazards

## Composition and route families

`src/server/index.ts` is the Coolify/Node entry. It reads environment configuration, loads the generated catalog, chooses Postgres when `DATABASE_URL` exists or SQLite otherwise, creates transit-file storage, and serves Hono.

`src/server/connect-app.ts` is the composition root. For each `WorkspaceContext`, it creates workspace-scoped stores and services for connections, OAuth, actions, controls, runtime tokens, and lifecycle.

`src/server/connect-server.ts` owns the route table:

| Family                                  | Contract and purpose          |
| --------------------------------------- | ----------------------------- |
| `/api/*`                                | Browser/product JSON          |
| `/v1/*`                                 | Runtime compatibility API     |
| `/mcp`                                  | Stateless Streamable HTTP MCP |
| `/oauth/callback`                       | Public OAuth completion       |
| `/api/webhooks/clerk`                   | Signed Clerk membership sync  |
| `/health`                               | Container health              |
| `/docs`, `/openapi.json`, static routes | Docs and SPA shell            |

`static-routes.ts` and `console-paths.ts` prevent API/docs misses from becoming an HTML SPA response. Cloudflare has a separate composition under `src/server/cloudflare.ts`; do not repair Node production only in the Worker path or vice versa without checking the target runtime.

## Authentication and workspace context

Middleware order matters:

1. Register Clerk webhook before human auth.
2. Verify Clerk human requests and resolve the active Organization.
3. On `/v1` and `/mcp`, resolve `oct_` runtime tokens with the dedicated middleware.

`clerk-auth.ts` accepts both legacy Clerk Organization claims (`org_id`, `org_role`) and compact v2 claims (`o.id`, `o.rol`). One Organization maps to one workspace. Only an Organization admin may create the first workspace row. Effective authorization always comes from `workspace_memberships`, not directly from the JWT role.

`clerk-webhooks.ts` synchronizes membership roles. Removal revokes the user's runtime tokens, deletes their connections, removes membership, and audits the event. Production requires a valid `CLERK_WEBHOOK_SIGNING_SECRET`.

`runtime-token-auth.ts` verifies the stored token hash, re-reads membership role, and rejects archived workspaces on every request. Never accept a workspace selector from MCP input.

## Roles, services, and storage

| Role    | Scope                                                                      |
| ------- | -------------------------------------------------------------------------- |
| Member  | Own connections, tokens, files, and runs; enabled workspace providers only |
| Manager | All workspace connections/runs; provider and approval configuration        |
| Admin   | Manager capabilities plus archive/restore                                  |

Keep authorization at the shared owners:

- connection visibility: `src/connection-service.ts`;
- run visibility and execution: `src/server/actions/action-runner.ts`;
- provider/action configuration and audit: `src/server/workspace-control-service.ts`;
- archive/restore/purge: `src/server/workspace-lifecycle-service.ts`;
- file visibility: transit-file service access metadata.

Production uses InsForge as managed PostgreSQL through `pg`; the browser never uses the InsForge SDK. `RuntimeDatabase.createScopedStores(workspaceId)` binds connection, OAuth, token, run, and state stores to one workspace. Every SQL statement must still include the workspace predicate.

Credentials and OAuth state/config are encrypted with the server codec. Runtime tokens store only SHA-256 hashes. Keep `OOMOL_CONNECT_ENCRYPTION_KEY` stable in production.

## Provider, OAuth, action, and MCP flow

Workspace provider controls gate browser catalogs, `/v1`, MCP discovery, proxies, and execution. Manager/admin OAuth config writes enable the provider. Do not expose disabled providers to members or agents.

OAuth authorization uses random, expiring, workspace+user-bound state and optional PKCE. The public callback derives workspace/user only from the stored state, completes the scoped flow, consumes state, and serves the small completion page.

All HTTP and MCP action execution converges on `ActionRunner`. It loads the lazy executor, resolves the explicit connection label, applies global allow/block policy, writes a redacted run summary, and logs the operational outcome.

MCP creates one stateless server per request with four tools from `src/mcp.ts`: `list_apps`, `search_actions`, `get_action_guide`, and `execute_action`. Discovery is provider-enabled and actor-visibility filtered. `execute_action` always requires `connectionName`.

Workspace `requireApproval` is advisory metadata by locked design. The MCP host asks the user in the current conversation; the server does not store or verify an approval grant.

Provider egress must use the injected guarded fetch described in `AGENTS.md`. Never route provider URLs through global `fetch`.

## Error contracts and logs

Preserve each route family's serializer:

- `/api`: `{ error: { code, message } }` from `src/server/api/http-utils.ts`.
- `/v1`: `{ success: false, message, data, errorCode, meta }` from `src/server/api/runtime-api.ts`.
- MCP: `{ ok: false, error }` and MCP `isError` semantics from `src/mcp.ts`.

Unexpected errors are Pino-logged with method/path and returned as generic `internal_error`; never expose stacks or secret-bearing exception detail.

Operational logs go to stdout and are redacted by `src/server/logger.ts`. Durable execution summaries belong in `runs`; security/configuration changes belong in `audit_events`.

## Tests and known hazards

Use focused tests at the shared boundary:

- route/auth/error envelopes: `src/server/connect-server.test.ts`, `src/server/api/*test.ts`;
- connections and owner visibility: `src/connection-service.test.ts`;
- OAuth: `src/oauth/*test.ts`;
- roles/controls/lifecycle: workspace service tests;
- MCP behavior/isolation: `src/mcp.test.ts`, `src/server/mcp-workspace-isolation.test.ts`;
- SSRF: guarded-fetch and provider network-access tests.

Current hazards to re-check when touching adjacent code:

1. PostgreSQL has no integration suite; SQLite/D1 success does not prove production SQL or migrations.
2. Membership webhook removal is multi-step rather than transactional. The code does not yet enforce "retain one admin," and Organization deletion does not archive the workspace row.
3. A member-supplied connection label can collide with another member's label because uniqueness is workspace+service+label and the upsert path needs explicit collision authorization.
4. PostgreSQL OAuth state consumption selects then deletes outside one transaction; concurrent callbacks can race.
5. PostgreSQL run readback does not preserve the original caller, so production caller analytics are not authoritative yet.
6. `/mcp` runtime middleware passes non-`oct_` requests through, allowing a valid Clerk human session to reach MCP; make any tightening an explicit compatibility/security decision.

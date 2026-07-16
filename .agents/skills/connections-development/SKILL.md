---
name: connections-development
description: Develop, debug, review, test, or deploy the Connections SaaS in this repository. Use for changes involving the React console, UI state/loading/errors/responsive layout, Clerk Organizations and profiles, Hono browser APIs, workspace roles and isolation, provider/OAuth connections, action policies, MCP runtime tokens, InsForge PostgreSQL/storage/migrations/logs, Docker/Coolify deployment, or end-to-end production failures.
---

# Connections Development

Work from the current repository, not upstream OpenConnector assumptions. Connections is a multi-workspace SaaS whose provider execution foundation remains upstream-compatible.

## Load required context

Read these files before product work:

1. `AGENTS.md` for repository practice and provider-network safety.
2. `connections-docs/LOCKED.md` for binding product and architecture decisions.
3. `connections-docs/VISION.md` for the intended user experience.
4. `tasks/lessons.md` for known failure patterns relevant to the task.

Do not use `web/PRODUCT.md` as product truth; it still describes the upstream single-user runtime. Use it only for visual principles that do not conflict with the locked Connections model.

Then load only the task-specific reference:

- Read [references/frontend.md](references/frontend.md) for console, state, loading, OAuth popup, responsive, or browser behavior.
- Read [references/backend.md](references/backend.md) for API, auth, roles, workspace data, MCP, storage, provider execution, or error behavior.
- Read [references/operations.md](references/operations.md) for local runtime, InsForge, logs, Docker, Coolify, migrations, deployment, or production debugging.
- Use `$add-provider` as well when adding or changing provider definitions or executors.

## Trace the real flow first

Before editing, trace the request from the user-visible trigger to the authoritative owner and back:

```text
React event
  -> web/src/api.ts
  -> Hono route in src/server/connect-server.ts
  -> Clerk or runtime-token workspace context
  -> workspace-scoped service from src/server/connect-app.ts
  -> store / provider executor
  -> route-specific error envelope
  -> page loading, success, or error state
```

Search every caller before changing a shared function. Fix the shared owner when sibling paths have the same bug.

## Preserve these boundaries

- Map one Clerk Organization to one Connections workspace. Clerk owns sign-in, Organization/profile UI, invitations, membership UI, and personal account security.
- Treat the application database role as effective authorization. Members see only their own connections, tokens, files, and runs; managers/admins see workspace-wide data; only admins archive or restore.
- Scope every browser request to the selected Organization. Never trust a client workspace id or a stale shared cookie as the workspace selector.
- Scope every MCP request from the stored `oct_` token record. Re-read membership and archived state on every request.
- Require an explicit connection label for execution. Never silently select an account.
- Keep provider credentials and OAuth client secrets server-only, encrypted, and workspace-scoped.
- Keep approval conversational: return `requireApproval` metadata and tell the agent to ask the user. Do not invent an approval inbox or claim server enforcement exists.
- Send provider egress through the shared SSRF-guarded fetch; never use global `fetch` in provider executors.
- Preserve the three public error contracts: `/api`, `/v1`, and MCP are deliberately different.

If a requested change conflicts with `connections-docs/LOCKED.md`, stop for a product decision.

## Implement at the owning layer

- Put global console snapshot/loading/error state in `web/src/ui.tsx`; keep filters, dialogs, forms, and pagination in their page.
- Put browser fetch/error parsing in `web/src/api.ts`; pass the active Organization bearer through every request path.
- Put route registration and route-family response shaping in `src/server/connect-server.ts` and `src/server/api/*`.
- Put request-scoped service composition in `src/server/connect-app.ts`.
- Put workspace scoping in `RuntimeDatabase.createScopedStores`, not in client parameters.
- Put provider execution in the provider runtime and `ActionRunner`, not in route handlers.
- Put structured operational logs in the existing Pino logger and durable user-facing history in runs or audit events.

Reuse current components, helpers, stores, and response writers. Do not add a new state library, API client, abstraction, dependency, or management screen unless the current owners cannot express the requirement.

## Debug in this order

1. Reproduce the visible state and record route, role, workspace, and last successful transition.
2. Inspect the browser response status and safe error body; never print tokens or configuration files.
3. Inspect the corresponding Hono route, auth middleware, scoped service, and store query.
4. Check Coolify stdout for operational failures, `runs` for action outcomes, `audit_events` for configuration/security changes, and InsForge logs for database/platform failures.
5. Fix the root owner, add the smallest regression check, and repeat the same flow.

Treat a white screen, indefinite loader, wrong-workspace data, missing connection, `401/403`, OAuth callback failure, and unhealthy deployment as different failure classes. Use the reference routing tables instead of guessing.

## Verify proportionally

Always run:

```bash
npm run fix-check
git diff --check
```

Also run the checks matching the change:

- Frontend: focused Vitest file, `npm run build --workspace web`, full `npm test`, and rendered desktop/mobile state checks when a browser is available.
- Backend/auth/storage/MCP: focused boundary test plus full `npm test`.
- Provider metadata/actions: `npm run generate:catalog` before the normal gates.
- PostgreSQL schema/data: verify the linked InsForge project, migration state, and live schema with targeted CLI queries; unit tests do not cover production Postgres.
- Deployment: push the reviewed commit, deploy that exact revision, wait for terminal status, confirm `running:healthy`, inspect error-level log signals, and exercise the changed production flow.

Do not claim visual, OAuth, Clerk, MCP, database, or production verification from a build alone. State the exact unavailable check when tooling or access blocks it.

## Handoff

Report the user-visible outcome, owning files changed, tests and runtime evidence, deployed commit when applicable, and remaining known risks. Never include credentials, raw environment values, tenant data, or unredacted logs.

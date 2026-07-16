# Operations reference

## Contents

- Local development
- Production build and configuration
- Deployment verification
- Logs and debugging ownership
- InsForge migrations and data checks
- Safe diagnostics and common failures

## Local development

Use Node's native TypeScript execution:

```bash
npm ci
npm run dev
```

`scripts/dev-local.ts` starts the API on `http://localhost:3000` and Vite on `http://localhost:5173`. `web/vite.config.ts` proxies `/api`, `/v1`, `/mcp`, docs, and OpenAPI to port 3000.

Without Clerk keys, the server deliberately uses the local `default` admin workspace. Without `DATABASE_URL`, it uses SQLite under the data directory. These fallbacks are development compatibility, not proof of production behavior.

## Production build and configuration

Coolify builds this repository's `docker-compose.yml`, which points at `docker/Dockerfile`. The multi-stage build generates the catalog, typechecks the server, builds the Vite console, and copies `src`, `catalog`, `dist`, migrations, and production dependencies into the runtime image.

`VITE_CLERK_PUBLISHABLE_KEY` is a build argument; changing only the runtime value does not update the browser bundle. Other Clerk, database, origin, encryption, and policy values are runtime environment variables. Never place secret values in Compose, source, logs, task files, or command arguments.

`OOMOL_CONNECT_ORIGIN` is currently a literal production URL in `docker-compose.yml`, so a Coolify variable with the same name cannot override it. Change Compose deliberately before deploying this stack on another domain.

The container listens on port 3000 and healthchecks `/health` through `scripts/healthcheck.ts`. The persistent volume backs `/app/data`, including SQLite/local transit files.

## Deployment verification

When deployment is requested:

1. Run the required checks and inspect the diff.
2. Commit only intended files and push `main`.
3. Deploy application UUID `m14hs9i7dspgix9ul8gx7lgp` through the configured Coolify MCP or UI.
4. Wait for terminal deployment status; record deployment UUID and commit SHA.
5. Confirm the app reports `running:healthy` and the new container reached `/health`.
6. Inspect the new log tail for error-level signals.
7. Exercise the changed production flow. For frontend releases, compare served asset hashes with the local build when browser automation is unavailable.

Do not redeploy the whole project when only the `connections` application changed. Do not claim the deployment contains a fix until Coolify built the pushed revision.

## Logs and debugging ownership

Use the source that owns the symptom:

| Symptom                                               | Source                                |
| ----------------------------------------------------- | ------------------------------------- |
| Build failure                                         | Coolify deployment log                |
| Container start, route exception, provider exception  | Coolify application stdout            |
| Action result/duration/redacted input/error           | Connections Runs page or `runs` table |
| Provider, token, policy, membership, lifecycle change | `audit_events`                        |
| PostgreSQL, PostgREST, or InsForge platform failure   | InsForge Logs page                    |

Production Pino logs are JSON stdout captured by Coolify. Local logs are pretty-printed. Logger redaction covers authorization, cookies, tokens, passwords, secrets, client secrets, and credential values. Do not bypass it with raw `console.log` or broad object dumps.

Runs and audit events are durable product records, not a replacement for container logs. InsForge platform logs do not contain the Coolify-hosted application stdout.

Expected `HttpRequestError` responses are returned without an application error log; use the client status/code. Unexpected failures before `runs.add()` may exist only in Coolify stdout, so absence of a run row does not prove no attempt occurred.

## InsForge migrations and data checks

`connections-docs/insforge-schema.sql` documents the full production schema. `migrations/*` are incremental changes. Node startup does not run PostgreSQL migrations.

Before a migration:

1. Use the `insforge-cli` skill.
2. Verify the linked CLI project name/host matches the app's non-secret database host.
3. Inspect migration state and current schema with targeted commands.
4. Use a preview branch for risky schema/RLS/auth experiments; production is `Main`.
5. Apply the migration deliberately, then query exact tables/columns/invariants.
6. Return CLI context to Main and remove obsolete preview branches when authorized.

Never print `.insforge/project.json`, a full environment, connection strings, Clerk keys, Coolify tokens, runtime tokens, or encrypted credential values. PostgreSQL behavior requires live targeted verification because the repo has no Postgres integration test.

Useful read-only commands are:

```bash
npx @insforge/cli current
npx @insforge/cli db migrations list --json
npx @insforge/cli diagnose logs --limit 100
npx @insforge/cli logs postgrest.logs --limit 100
npx @insforge/cli logs postgres.logs --limit 100
npx @insforge/cli logs insforge.logs --limit 100
npx @insforge/cli diagnose db --check connections,locks,slow-queries
```

Use `docker compose config --quiet`; do not print resolved Compose configuration because it may contain secrets.

## Safe diagnostics and common failures

- White screen: inspect browser console/network, Vite asset response, Clerk publishable build arg, and SPA/static fallback.
- Endless first loader: inspect `/api/auth/session`, selected Organization token, and the parallel snapshot endpoints.
- Wrong workspace or `workspace_forbidden`: compare Clerk membership with `workspace_memberships`; probe the signed webhook endpoint without exposing its secret.
- `401`: distinguish missing/invalid Clerk human token from invalid/revoked `oct_` runtime token.
- `403 workspace_required`: active Clerk token lacks Organization claim.
- OAuth configured but connection absent: inspect popup/callback, state consumption, callback origin, BroadcastChannel, polling, and server OAuth logs.
- MCP sees wrong or no accounts: inspect token workspace/user, current membership role, provider enablement, owner visibility, and explicit connection labels.
- Runtime API authentication warning: current startup detection checks the legacy default-workspace token list and can be a false positive when valid tokens exist only in real workspaces. Prove auth with an authenticated `/v1/health` or MCP request.
- Credential encryption warning: treat missing encryption as production-fatal even though local fallback permits plaintext.
- Database SSL warning: normalize the connection string in `postgres-config.ts`; do not weaken verification casually.
- Deployment says healthy but UI is old: compare Coolify commit, browser asset hash, Vite build arg, and cache behavior.

Public `/openapi.json` is protected in production. Validate it through an authenticated Clerk session rather than interpreting a bare `401` as a missing route.

Prefer read-only inspection. Ask before destructive database changes, token rotation, environment mutation, member removal, archive/purge, or deployment unless the user explicitly requested that operation.

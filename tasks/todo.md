# Task Plan

## Goal

Diagnose and repair the deployed Connections console after Clerk organization selection: resolve the active-organization API failure, validate Clerk and InsForge connectivity, suppress the actionable database TLS warning, and polish the workspace switcher layout.

## Constraints

- Preserve the locked rule that one Clerk Organization maps to one Connections workspace and do not weaken server-side active-organization enforcement.
- Do not log, change, or commit secrets or Clerk tenant data.
- Keep Clerk authentication and organization management in Clerk; Connections owns only its effective workspace roles and data.
- Inspect Clerk and InsForge with their CLIs read-only before changing application behavior.

## Steps

- [x] Review the product decisions, current deployment behavior, and existing Clerk integration.
- [x] Deploy the Clerk organization selection and post-authentication return fix.
- [x] Inspect the Clerk tenant/session configuration and confirm the claim path without exposing credentials.
- [x] Inspect InsForge project/database health and schema compatibility with the deployed service.
- [x] Trace and fix the remaining selected-organization API failure without weakening workspace isolation.
- [x] Make the sidebar organization control layout intentional.
- [x] Make the database TLS behavior explicit for the connection string supplied by Coolify.
- [x] Verify the repaired local production flow, test suite, lint/typecheck, and deployment-ready diff.
- [x] Accept Clerk's current compact organization claims in the server verifier while retaining legacy-claim compatibility.
- [x] Add a regression check for both Clerk claim formats and redeploy the correction.
- [x] Diagnose and repair the Connections Workspace settings page's `Not found` response.

## Verification

- [x] Clerk session/org details inspected with the official CLI, using safe output only.
- [x] InsForge connection/schema diagnostics inspected with the official CLI.
- [x] Selected organization is explicitly embedded in every browser-to-API Clerk token.
- [x] Sidebar grid gives the organization control its own row at desktop and preserves the compact mobile layout.
- [x] `npm test`, `npm run build:web`, and `npm run fix-check` pass.
- [x] PostgreSQL TLS alias handling is explicit and verified during local startup.
- [x] Active organization claim formats are verified at the server workspace claim resolver.
- [x] The console no longer exposes workspace pages backed by nonexistent API routes.

## Review

The original token-scoping fix deployed successfully, but the deployed screenshot showed that the API still rejected the active organization. Clerk v2 session tokens use compact `o.id` and `o.rol` fields; the server had only read v1 `org_id` and `org_role`. The single workspace-claim resolver now supports both formats, preserving the admin-only workspace-creation check and strict workspace isolation. Regression tests cover both claim versions; `npm run fix-check` and the full suite pass (51 files / 407 tests). The database and sidebar findings above remain valid.

The later Workspace Settings and Members screens were not backed by any registered API routes; all requests to `/api/workspace/*` returned the static-route 404 shown in the screenshot. The unused pages, navigation entries, and models were removed so the console no longer advertises nonfunctional workspace administration. Clerk's Organization profile remains the supported workspace-management surface. Add Connections-specific workspace administration only alongside its server routes, lifecycle implementation, and tests.

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

## Verification

- [x] Clerk session/org details inspected with the official CLI, using safe output only.
- [x] InsForge connection/schema diagnostics inspected with the official CLI.
- [x] Selected organization is explicitly embedded in every browser-to-API Clerk token.
- [x] Sidebar grid gives the organization control its own row at desktop and preserves the compact mobile layout.
- [x] `npm test`, `npm run build:web`, and `npm run fix-check` pass.
- [x] PostgreSQL TLS alias handling is explicit and verified during local startup.

## Review

The deployed session did not have an active organization according to Clerk's backend API, even though the browser switcher showed the user's membership. Clerk documents that multi-organization browser requests must request a token for the selected tab's organization; the console now calls `getToken({ organizationId: orgId, skipCache: true })`, so the Hono middleware receives the required `org_id` and retains its strict workspace boundary. The sidebar now assigns the switcher a dedicated grid row, avoiding the large blank area caused by an implicit grid row. The PostgreSQL URL normalizer changes pg's currently equivalent `prefer`, `require`, and `verify-ca` aliases to explicit `verify-full`, removing Coolify's security warning without weakening TLS. Clerk CLI health passed; it showed one organization and an authenticated user but the session's server-side active organization was null, confirming the diagnosis. InsForge DB diagnostics showed healthy connections, no slow queries or waiting locks, and all required Connections tables. Local production startup on port 3002 succeeded with no PostgreSQL TLS warning. Full tests passed: 50 files / 405 tests, as did the web build and `npm run fix-check`. The remaining deployment requirement is to use a Clerk production instance before treating the public site as production; the CLI confirms it currently uses a development instance.

# Task Plan

## Goal

Complete the missing multi-workspace security and lifecycle capabilities, verify live InsForge persistence, and push the tested implementation to `main`.

## Constraints

- Preserve the locked rule that one Clerk Organization maps to one Connections workspace; Clerk remains the membership/profile UI.
- Do not log, change, or commit secrets or Clerk tenant data.
- Use server-side authorization, workspace-scoped storage, and encrypted server-managed credentials.
- Inspect production InsForge read-only before applying migrations; validate schema/data after the migration.
- Do not reintroduce custom Clerk Organization member/settings screens.

## Steps

- [x] Review product decisions, current implementation, and prior deployment fixes.
- [x] Inspect live InsForge project/schema/data read-only and reconcile it with the application migration.
- [x] Add Clerk membership synchronization and immediate access revocation.
- [x] Enforce role and ownership rules for connections, runtime tokens, runs, OAuth configuration, and transit files.
- [x] Add workspace provider enablement and action approval policy persistence/enforcement.
- [x] Add audit recording.
- [ ] Add the workspace deletion/restore/purge lifecycle (blocked: Clerk's native organization deletion is irreversible, so restoring a 14-day backup requires an accepted destination-workspace/identity rule).
- [x] Add focused regression coverage and run full verification.
- [x] Commit and push `main`.

## Verification

- [x] Live InsForge project, tables, indexes, and row counts inspected without exposing secrets.
- [x] Membership create/update/remove and runtime-token revocation verified.
- [x] Member/manager/admin access boundaries verified through the Hono API.
- [x] Cross-workspace and cross-member connection/file access rejected.
- [x] Provider/action policy and audit behavior covered by tests.
- [ ] Deletion, restore, and purge semantics tested at the service boundary (blocked by the product decision above).
- [x] `npm run fix-check`, tests, and web build pass.
- [x] Production migration applied and re-inspected through InsForge CLI.
- [ ] Commit is pushed to `origin/main`.

## Review

The original token-scoping fix deployed successfully, but the deployed screenshot showed that the API still rejected the active organization. Clerk v2 session tokens use compact `o.id` and `o.rol` fields; the server had only read v1 `org_id` and `org_role`. The single workspace-claim resolver now supports both formats, preserving the admin-only workspace-creation check and strict workspace isolation. Regression tests cover both claim versions; `npm run fix-check` and the full suite pass (51 files / 407 tests). The database and sidebar findings above remain valid.

The later Workspace Settings and Members screens were not backed by any registered API routes; all requests to `/api/workspace/*` returned the static-route 404 shown in the screenshot. The unused pages, navigation entries, and models were removed so the console no longer advertises nonfunctional workspace administration. Clerk's Organization profile remains the supported workspace-management surface. Add Connections-specific workspace administration only alongside its server routes, lifecycle implementation, and tests.

Clerk Organization membership is the workspace-membership source and Clerk's UI is the sole organization-management surface. Connections must synchronize Clerk membership changes into its `workspace_memberships` authorization table before collaborator invites are ready for production; runtime tokens require that application membership row and removals must revoke access immediately.

This implementation adds the signed Clerk webhook route, revokes a removed member's runtime tokens and owned connections, scopes member-visible connections/tokens/runs/transit files, persists workspace provider/action controls, and writes audit events. The InsForge migration `20260715183732_workspace-security-controls` was applied through a schema-only branch and merged into production; the live database reports 1/1 owned connection, 1/1 owned OAuth config, zero orphaned connections, and the new policy tables present. Verification passed: `npm run fix-check`, web build, and 53 test files / 413 tests.

The implementation was committed and pushed to `origin/main` as `f57210b`.

The remaining lifecycle requirement is intentionally not guessed: a Clerk Organization delete is permanent, but the locked product direction requires a restorable 14-day backup. A restore must therefore identify whether it restores into a newly created Clerk Organization, how memberships are remapped, and who may initiate that operation.

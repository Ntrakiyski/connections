# Task Plan

## Goal

Prove that MCP runtime tokens cannot expose or execute data across Clerk Organization / Connections workspace boundaries, and fix any violation found.

## Constraints

- Preserve the locked rule that one Clerk Organization maps to one Connections workspace; Clerk remains the membership/profile UI.
- Do not log, change, or commit secrets or Clerk tenant data.
- Use server-side authorization, workspace-scoped storage, and encrypted server-managed credentials.
- Inspect production InsForge read-only before applying migrations; validate schema/data after the migration.
- Do not reintroduce custom Clerk Organization member/settings screens.
- Treat the token's stored workspace as authoritative; never trust client-supplied workspace selection.
- Verify discovery, action execution, runs, files, tokens, and provider configuration—not only one MCP endpoint.

## Steps

- [x] Trace runtime-token authentication through the MCP transport and scoped-service creation.
- [x] Inspect every workspace-addressed storage adapter for cross-workspace reads/writes.
- [x] Run or add an end-to-end two-workspace token isolation regression test.
- [x] Verify the exact API-key behaviour and document the evidence.
- [x] Refresh the repository README with the current Connections product model, architecture, roles, MCP token boundary, and deployment configuration.

## Verification

- [x] MCP discovery returns only the token workspace's permitted connections.
- [x] MCP execution cannot resolve a connection, token, run, file, or provider configuration from another workspace.
- [x] Revoked, removed-member, and archived-workspace tokens are rejected.
- [x] Relevant regression tests pass; any code change is pushed to `main`.
- [x] README accurately describes the deployed product and technical integration points.

## Review

The original token-scoping fix deployed successfully, but the deployed screenshot showed that the API still rejected the active organization. Clerk v2 session tokens use compact `o.id` and `o.rol` fields; the server had only read v1 `org_id` and `org_role`. The single workspace-claim resolver now supports both formats, preserving the admin-only workspace-creation check and strict workspace isolation. Regression tests cover both claim versions; `npm run fix-check` and the full suite pass (51 files / 407 tests). The database and sidebar findings above remain valid.

The later Workspace Settings and Members screens were not backed by any registered API routes; all requests to `/api/workspace/*` returned the static-route 404 shown in the screenshot. The unused pages, navigation entries, and models were removed so the console no longer advertises nonfunctional workspace administration. Clerk's Organization profile remains the supported workspace-management surface. Add Connections-specific workspace administration only alongside its server routes, lifecycle implementation, and tests.

Clerk Organization membership is the workspace-membership source and Clerk's UI is the sole organization-management surface. Connections must synchronize Clerk membership changes into its `workspace_memberships` authorization table before collaborator invites are ready for production; runtime tokens require that application membership row and removals must revoke access immediately.

This implementation adds the signed Clerk webhook route, revokes a removed member's runtime tokens and owned connections, scopes member-visible connections/tokens/runs/transit files, persists workspace provider/action controls, and writes audit events. The live database reports 1/1 owned connection, 1/1 owned OAuth config, zero orphaned connections, the new policy tables present, and the existing Gmail provider enabled for its workspace. Verification passed: `npm run fix-check`, web build, and 53 test files / 413 tests.

The implementation was committed and pushed to `origin/main` as `f57210b`. During this final audit, InsForge reported that `20260715184731_seed-workspace-providers` is still pending even though the earlier review had recorded it as applied. It must be applied before the new lifecycle migration; the migration is an idempotent `insert … on conflict do nothing` seed from existing connection and OAuth rows.

The final audit identified two unimplemented locked requirements: first-class named connection labels (including deliberate MCP selection), and the restorable workspace lifecycle. Both are now implemented. The console can label, select, and rename multiple provider accounts; `/v1` and MCP runs require the label explicitly so an agent never silently picks an account. The workspace lifecycle archives Connections-owned encrypted data for 14 days, revokes runtime tokens immediately, permits admin restore, and purges scoped records after expiry while leaving Clerk's Organization profile and membership UI authoritative. Clerk organization names now synchronize back into the workspace record so the exact deletion confirmation remains accurate.

InsForge verification was performed against the actual parent Connections project: migration `20260715221000_workspace-lifecycle` is applied; `workspaces` contains `deleted_at` and `purge_at` with the purge index; the aggregate state is 3 active / 0 archived workspaces, 1 owned connection, 1 owned OAuth config, 1 seeded provider control, zero missing owners, zero orphaned provider controls, and zero invalid archive states. A stale empty branch was initially linked locally; its safe additive migrations were not merged and no application data was changed there. The CLI context was returned to the parent before the production migration and inspection.

Release evidence: implementation commit `fe97863` was pushed to `origin/main`. Final verification passed `npm run fix-check`, the full Vitest suite (54 files / 419 tests), `npm run build`, the web production build, `git diff --check`, and the targeted InsForge CLI schema/data checks above.

MCP isolation audit: runtime-token authentication resolves only the token hash to its stored workspace and user, checks the current membership role and archived state, then constructs workspace-scoped connection, OAuth, token, run, and control stores before MCP is created. The MCP protocol accepts no workspace selector. A new end-to-end `/mcp` regression test creates two workspaces with different opaque runtime keys and connection labels: each key discovers only its own label, and using the other workspace's label returns structured `connection_not_found`. Existing storage, membership-removal, lifecycle, and transit-file tests cover the related revocation and scoped-data paths. The MCP boundary now normalizes this denied connection lookup into the structured tool error rather than returning raw transport text. The README was rewritten for the current Connections product, deployment, architecture, and security model. Verification passed `npm run fix-check`, all 55 test files / 420 tests, the web build, and `git diff --check`.

Release evidence: the isolation test, structured MCP error response, and README update were pushed to `origin/main` in `577aaeb`.

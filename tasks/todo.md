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

---

# Task Plan

## Goal

Explain the upstream-fork relationship, the three InsForge database branches, and the app's current debugging-log retention without changing production state.

## Constraints

- Read-only inspection except the two preview-branch deletions explicitly authorized by the user.
- Do not expose credentials or user data.

## Steps

- [x] Inspect the documented product/database branch history and application logging code.
- [x] Confirm where product run/audit logs persist and where container logs live.
- [x] Confirm the status and purpose of the two InsForge preview branches.
- [x] Delete both unneeded preview branches at the user's request.

## Verification

- [x] Source of application logging reviewed.
- [x] Source of persisted product runs/audit events reviewed.
- [x] InsForge branch status confirmed without mutation.
- [x] InsForge accepted deletion of both preview branches.

## Review

`Main` is the production InsForge database used by the deployed app. `workspace-security-controls` was a merged, dormant schema-only preview branch; `seed-workspace-providers` was an unmerged, isolated schema-only preview with no production effect. At the user's request, InsForge deleted both (`branch delete … -y` followed by `branch not found` confirmation); Main was not modified. The console stores product execution records in the production `runs` table and security/configuration history in `audit_events`; the separate Pino service logs go to stdout/Coolify and are not currently centralized or retained by this repository. Exact InsForge platform-log retention is not exposed by the CLI.

---

# Task Plan

## Goal

Close the Connections development handoff in durable product documentation rather than workflow metadata.

## Constraints

- Keep operational facts accurate to the deployed architecture.
- Do not put credentials, source paths, or temporary workflow state in the handoff.

## Steps

- [x] Create an operator-facing deployment and debugging guide under `connections-docs`.
- [x] Link the guide from the repository README.
- [x] Cold-read the guide for a new operator and review the final diff.

## Verification

- [x] Deployment, workspace, logging, and database-branch instructions are actionable.
- [x] Documentation is discoverable from the README.

## Review

Created a concise Operations guide for deployers: it distinguishes Clerk, Connections, InsForge, and Coolify boundaries; gives a deployment and MCP-isolation check; maps symptoms to the right log source; and records safe InsForge preview-branch hygiene. It is linked from the README. The vision and locked decisions now agree with the deployed model: Clerk owns Organization membership management, while a Connections admin archives/restores Connections data. Cold-read and `git diff --check` passed.

---

# Task Plan

## Goal

Add a clear top-of-README value proposition for teams evaluating Connections.

## Constraints

- Describe only implemented workspace, role, credential, and MCP behavior.
- Keep the new section short and lead into the existing capability details.

## Steps

- [x] Define the reader-facing value proposition and placement.
- [x] Add the README section.
- [x] Cold-read and verify the final documentation diff.

## Verification

- [x] A first-time reader can understand why a team would use Connections.
- [x] No claim expands the current product boundary.

## Review

Added a short **Why Connections?** section directly below the product introduction. It explains the value in terms of shared, governed account access; bounded MCP tokens; and strict Organization isolation, then leads into the concrete feature list. Cold-read and `git diff --check` passed.

---

# Task Plan

## Goal

Diagnose and fix why a Clerk Organization member receives “You are not a member of the active workspace.”

## Constraints

- Treat Clerk membership and the Connections authorization row as separate facts and trace their synchronization end to end.
- Do not change Clerk membership, production data, or secrets unless a targeted repair is proven necessary.
- Preserve immediate access revocation when a user is removed.

## Steps

- [x] Inspect the deployed membership-sync route and its authentication requirements.
- [x] Verify the Clerk instance, organization membership, webhook delivery/configuration, and corresponding application membership row.
- [x] Configure the missing production webhook secret and backfill the existing membership.

## Verification

- [x] The invited Clerk member has a matching Connections membership row.
- [x] The invited Clerk member reloads the console and can load the active workspace.
- [x] Removed members still lose access immediately in the existing signed-webhook design.
- [x] The code path and live production configuration were checked.

## Review

Clerk confirms that `ntrakiyski@gmail.com` is an `org:member` in the active Organization, but the production `workspace_memberships` table initially contained only the original `org:admin` user. The live `POST /api/webhooks/clerk` probe returned `404`, proving `CLERK_WEBHOOK_SIGNING_SECRET` was absent. After the user configured the secret and redeployed, the same probe returns `400 invalid signature`, proving the signed handler is live. The verified Clerk member was backfilled into the matching workspace as `member`, with a `membership.synced` audit event; the database now has both the member and admin rows. The refreshed console confirms access. The targeted webhook test passes (2 tests), and a live MCP `list_apps` call confirms the organization token discovers both labelled Gmail accounts.

---

# Task Plan

## Goal

Design a workspace action-policy control in the action detail UI and make the required-confirmation instruction clear to MCP agents.

## Constraints

- The user explicitly wants approval in the agent conversation, not a separate Connections approval page or link.
- An in-chat confirmation is enforced by a cooperative MCP client/agent, not cryptographically verifiable by Connections when the host grants unrestricted tool access.
- Provider credentials remain server-only.
- Reuse the existing action-policy API and action-detail UI. Do not add a separate policy-management surface.

## Steps

- [x] Trace the existing action-policy API and MCP metadata flow.
- [x] Identify the gap: host-side metadata cannot guarantee a pause for a permissive agent.
- [x] Add the manager/admin `Require approval` control beside the action-detail controls.
- [x] Make protected-action discovery and execution responses explicitly instruct the agent to ask the user for confirmation before execution.
- [x] Verify a representative MCP client receives the policy and explicit in-chat confirmation instruction.

## Verification

- [x] Existing policy defaults and MCP metadata behavior reviewed.
- [x] Action-detail UI is restricted to manager/admin configuration.
- [x] Protected action metadata gives the agent an unambiguous in-chat confirmation instruction.
- [x] The implementation documents that a host configured to ignore tool policy cannot be made safe without a separate server-verifiable approval mechanism.
- [x] Relevant tests, `npm run fix-check`, and the web build pass.

## Review

Managers and admins can now toggle `Require approval` from an action's existing detail panel; the existing workspace policy API persists and audits the change. MCP initialization, action search, and action guides return the explicit instruction to ask the user in the current conversation before executing protected actions. Focused UI/MCP tests, `npm run fix-check`, the web production build, and the full Vitest suite pass (56 files / 422 tests). This is intentionally conversational guidance: a host configured to ignore MCP policy cannot be prevented from calling the tool without adding the separate server-verifiable approval mode the user declined.

---

# Task Plan

## Goal

Expose `Require approval` beside each action in a provider's action list and use the requested high-impact default policy for actions without a saved workspace rule.

## Constraints

- Keep each action name as its existing link to the action-detail page; the toggle must not become nested interactive content inside that link.
- Existing workspace action-policy rows are explicit decisions and must not be overwritten.
- Only action IDs or names containing `delete`, `create`, `update`, or `move` default to approval on; all other unsaved policies default off.
- Update the locked product decision because this deliberately changes the previous all-actions-on default.

## Steps

- [x] Trace the provider action-row UI and default-policy resolver.
- [x] Add the reusable manager/admin toggle beside each provider action row.
- [x] Change the unsaved policy resolver to the requested action-name heuristic.
- [x] Update the product decision and regression tests.

## Verification

- [x] Existing saved policy is retained over the heuristic.
- [x] High-impact names default on and other names default off.
- [x] Manager/admin sees the provider-row control; member does not.
- [x] `npm run fix-check`, web build, focused tests, and full suite pass.

## Review

The provider action list now keeps its action link and Executable badge while placing the manager/admin approval toggle on the same row. The default resolver checks unsaved action IDs and names for `delete`, `create`, `update`, and `move`; those actions require approval, while all other unsaved actions do not. Explicit workspace rules still win and continue to be audited. The locked product decision and vision now record the rule. Verification passed `npm run fix-check`, the web production build, all 56 Vitest files / 423 tests, and `git diff --check`.

# Task Plan

## Goal

Remove the separate Gmail scheduling action: publishing from the client form must persist the entered values and create the first schedule, while tests still ignore date and time.

## Constraints

- Keep MCP `publish_automation` as a publish-only tool; it has no client form input.
- Publish from the browser must clearly create a schedule and never send email immediately.
- Preserve the existing real Gmail-draft test behavior and current authorization checks.

## Steps

- [x] Trace the publish, save, and schedule paths and add one browser publish-and-schedule operation.
- [x] Replace the UI scheduling control with the revised publish action.
- [x] Add regression coverage for a published schedule and run focused checks.
- [x] Deploy and verify the live UI bundle and health.

## Verification

- [x] Test ignores date/time and invokes only Gmail draft creation.
- [x] Browser publish persists the values and creates an active schedule at the selected time.
- [x] MCP publish remains publish-only.
- [x] Tests, typecheck, web build, migration state, and production health pass.

## Review

Released `0e1d149`. The client form now treats its date/time as publish input: **Publish & schedule**
saves the form, publishes the draft, and creates one active schedule. The separate Schedule Gmail
draft button was removed. Tests still create one Gmail draft immediately and ignore date/time.
`publish_automation` over MCP remains publish-only, verified by its service-path regression test.
Verified with 64 test files / 479 tests, `fix-check`, web build, Coolify deployment
`h25hhukvy45unce70lb20opm`, production health, and the deployed UI bundle.

---

# Task Plan

## Goal

Extend the existing YouTube provider with the read-only controlled-feed path, including subscription import and least-privilege OAuth scope selection.

## Constraints

- Keep all OAuth and YouTube API access in `src/providers/youtube` and existing shared runtime services.
- The default YouTube connection must request only `youtube.readonly`; existing mutations must continue to require `youtube.force-ssl`.
- Preserve existing connections and provider contracts; no UI or recommendation logic.

## Steps

- [x] Trace the YouTube action/runtime and OAuth connection flow.
- [x] Add subscription support and verify the feed-read action contracts.
- [x] Make the default OAuth scope read-only and preserve explicit scope selection compatibility.
- [x] Generate the catalog, run focused tests and repository checks, and review the diff.

## Verification

- [x] Subscription requests, pagination, normalization, validation, and upstream errors are covered.
- [x] Feed-only authorization URL contains only `youtube.readonly`.
- [x] Existing write actions still require `youtube.force-ssl`; existing connections remain executable according to their recorded grants.
- [x] Generated catalog and `npm run fix-check` pass.

## Review

Added `youtube.list_subscriptions` using `subscriptions.list` with `mine`/`channelId`, bounded pagination, normalized subscription/channel data, and `youtube.readonly`. The feed read path now defaults video requests to include `liveStreamingDetails`; existing search, channels, playlist-items, categories, language, and region actions already cover the remaining documented feed endpoints.

YouTube's default OAuth request now contains only `youtube.readonly`. Completed connections record requested scopes when a token response omits them; existing write-capable connections remain intact, but a newly reconnected default connection is read-only. Write actions continue to require `youtube.force-ssl` and will correctly fail scope preflight until a dedicated write-capable flow is added.

Verified with focused YouTube/OAuth tests (21 tests), `npm run generate:catalog`, `npm run fix-check`, and `git diff --check`. The catalog marks `youtube.list_subscriptions` read-only through its single `youtube.readonly` requirement. The API does not reliably identify Shorts: consumers should use duration/metadata and an explicit heuristic. YouTube Data API quota remains account/project-limited.

---

# Task Plan

## Goal

Add a persistent, encrypted automation configuration so the client form has an explicit Save configuration action.

## Constraints

- Saving must not create a Gmail draft, publish the automation, or create an active schedule.
- Preserve workspace scoping and encrypt recipient/body values at rest.
- Reuse the saved configuration as the initial value for test and schedule inputs.

## Steps

- [x] Add the smallest configuration storage contract and migration.
- [x] Expose authenticated save/load operations through the browser API and MCP detail response.
- [x] Add Save configuration to the client form and reload saved defaults.
- [x] Verify persistence, authorization, UI behavior, and deployment.

## Verification

- [x] Saved input is encrypted and workspace-scoped.
- [x] Save never invokes Gmail or creates a schedule.
- [x] Reloaded form values match saved values.
- [x] Tests, typecheck, web build, and production health pass.

## Review

Released `957917d`. The client form now saves its recipient, subject, body, date/time, time zone,
and recurrence defaults through the authenticated workspace API. The values are encrypted at rest,
returned by `get_automation`, and loaded only on the initial detail view so a refresh after testing
or scheduling cannot overwrite unsaved edits. Saving records an audit event only; it never invokes
Gmail, publishes, or creates a schedule. Verified with 64 test files / 479 tests, `fix-check`, web
build, the applied `20260721090000_automation-configurations` migration, Coolify deployment
`t6xdz4iyfhqarqkrn8yn9pco`, production health, and the deployed UI bundle text.

---

# Task Plan

## Goal

Make Gmail automation tests create one real Gmail draft using the current form input while bypassing only the schedule.

## Constraints

- Preserve the existing workspace, connection, action-policy, and ActionRunner boundaries.
- Require explicit confirmation before the test creates a Gmail draft; it must never send email.
- Reuse the existing encrypted schedule/run storage so successful and failed tests appear in automation history.

## Steps

- [x] Trace the current dry-run test flow and its action-runner/schedule boundaries.
- [x] Execute the draft definition with form input after explicit test confirmation, without waiting for a due schedule.
- [x] Update the browser and MCP test contracts and user-facing result state.
- [x] Add focused regression coverage and run the relevant checks.

## Verification

- [x] Test invokes only `gmail.create_email_draft` with the exact bound connection and form input.
- [x] The test never creates an active schedule or sends email.
- [x] Successful and failed tests are recorded in automation run history.
- [x] Type, unit, UI bundle, and deployed MCP flow checks pass; browser visual QA was blocked by the unsigned in-app session.

## Review

Released `4ef4f5f`. Tests now require explicit confirmation and execute the draft version through the same bound Gmail action as the scheduler, while recording a completed run and no active schedule. Production verification created Gmail draft `r5592286513199890623`, reported a successful automation run, and confirmed no active schedules. `fix-check`, 64 test files / 479 tests, web build, Coolify health, and the deployed UI bundle passed.

---

# Task Plan

## Goal

Apply the approved InsForge table-access hardening through a durable repository migration and verify the live result.

## Constraints

- Operate only on the already-linked parent Connections project.
- Preserve the Hono-only database boundary; do not add browser/PostgREST policies.
- Keep the server database role working while removing `anon` and `authenticated` access.
- Do not alter tenant rows, credentials, or unrelated database objects.

## Steps

- [x] Confirm the linked project and remote migration head.
- [x] Create and review one focused access-control migration.
- [x] Apply the migration with the InsForge CLI.
- [x] Verify grants, RLS, advisor output, and application health.

## Verification

- [ ] All 13 affected tables have RLS enabled and not forced; 11 are fixed, while two legacy `postgres`-owned tables require owner-level repair unavailable to the CLI migration role.
- [ ] `anon` and `authenticated` have no table privileges on all affected tables; verified for the same 11, with the two owner-blocked tables remaining exposed.
- [x] No policies were added and no tenant rows were touched.
- [x] The migration is recorded remotely, database diagnostics are healthy, and production `/health` returns `{"ok":true}`.

## Review

Applied `20260719133905_lock-down-server-tables` to the parent Connections project. It enables non-forced RLS and removes all `anon`/`authenticated` table privileges from 11 application tables, then removes those roles from `project_admin`'s future table and sequence defaults. Live metadata verifies every protected privilege is false, RLS is enabled, no policies were added, the database has no slow queries or locks, and the production health endpoint returns OK.

The first apply was transactionally rolled back because `workspace_action_policies` and `workspace_providers` are legacy tables owned by `postgres`, with their public grants also issued by `postgres`. InsForge migrations run as `project_admin`, which cannot alter either table or revoke another owner's grants. Those two tables remain publicly readable and writable and require InsForge owner-level action: transfer ownership to `project_admin` or have `postgres` enable RLS and revoke the public grants. No risky table rebuild was attempted.

---

# Task Plan

## Goal

Inspect the 14 InsForge "Table publicly accessible" security findings and propose a verified remediation plan without changing production.

## Constraints

- Read-only investigation; do not alter grants, RLS, migrations, production data, secrets, or deployment state.
- Verify the linked InsForge project before querying and avoid broad outputs that may expose credentials or tenant data.
- Preserve the locked architecture: Clerk and the Connections Hono API own human authorization; the browser never queries InsForge directly.
- Distinguish `public` schema placement from actual access granted to anonymous/authenticated PostgREST roles.
- Protect encrypted credentials, OAuth state, token hashes, membership, runs, and audit data with defense in depth.

## Steps

- [x] Capture the complete advisor findings and affected-table set.
- [x] Inspect current table grants, RLS flags, policies, and application database role usage.
- [x] Compare live schema state with repository migrations and deployment architecture.
- [x] Classify exposure and propose the smallest safe migration and rollout sequence.

## Verification

- [x] Advisor output checked; the CLI currently returns no persisted scan payload, so the screenshot was reconciled with live PostgreSQL metadata instead.
- [x] Live grants/RLS/policies verified without reading tenant row contents.
- [x] Application database access requirements traced from production code.
- [x] Proposed SQL is compatible with the Hono-only data boundary and includes a runtime-role preflight before RLS rollout.
- [x] Remaining unknowns and required post-fix checks documented.

## Review

The screenshot reflects a real database exposure, although it is one finding stale: the live project currently has 13 unsafe application tables, while `meetily_meetings` is already protected. Every unsafe table has RLS disabled, no policies, and direct `SELECT`, `INSERT`, `UPDATE`, and `DELETE` grants to both `anon` and `authenticated`; those roles also have `USAGE` on `public`. No tenant rows or secrets were read during verification.

The root cause is the InsForge database's default ACL for tables created by both `postgres` and `project_admin`. Older schema and migrations created tables without overriding those defaults. The Meetily migration demonstrates the correct server-only pattern: enable RLS and revoke all table access from `anon` and `authenticated`. Because Connections uses Clerk plus its Hono API as the sole authorization boundary and connects with a server-side PostgreSQL URL, it should not define browser/PostgREST policies for these tables.

Recommended rollout: first confirm `current_user` through the production application's own database connection (expected `project_admin`, which has `BYPASSRLS`); then apply one explicit migration that revokes all privileges from the two public roles and enables non-forced RLS on the 13 affected tables. Smoke-test workspace load, connection management, OAuth, runtime-token authentication, a provider run, and audit writes; then re-scan and verify zero public table privileges. Change `project_admin` default privileges where permitted and require every future `create table` migration to include the explicit RLS/revoke pair. Do not use `FORCE ROW LEVEL SECURITY`, and do not add permissive `USING (true)` policies.

---

# Task Plan

## Goal

Create a runnable Board provider from the supplied OpenAPI document and use the supplied image as its Connections catalog cover.

## Constraints

- Use the repository-local `add-provider` OpenAPI workflow and existing runtime helpers.
- Treat Board as a user-configured self-hosted service; preserve the deployment-gated private-network policy for Tailscale/private instances.
- Route all provider requests through the shared SSRF-guarded fetcher.
- Use only the supplied image; do not import third-party assets.
- Keep the first provider slice useful and minimal, with at most five actions.
- Preserve unrelated working-tree changes and do not deploy or alter production configuration.

## Steps

- [x] Inspect the complete Board OpenAPI contract and relevant provider/runtime/catalog patterns.
- [x] Implement the Board definition, actions, runtime, executors, and cover asset.
- [x] Add the smallest regression checks for URL handling and request mapping.
- [x] Generate catalog data and run repository verification.
- [x] Review the user-facing catalog result and final diff.

## Verification

- [x] Provider appears in generated catalog with the supplied image.
- [x] Selected actions map to the documented methods, paths, and bodies.
- [x] Self-hosted base URL validation and private-network opt-in are preserved.
- [x] Focused tests, `npm run generate:catalog`, `npm run fix-check`, full tests, and `git diff --check` pass.
- [x] Risks or unverified live-service behavior are documented.

## Review

Added the runnable `board` provider with five curated OpenAPI operations: list boards, read a board, rename a board, create/update raw tldraw records, and delete records. The connection uses a required self-hosted root URL plus an optional bearer token; public targets work normally, while Tailscale/RFC 1918 targets remain behind `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` and reserved targets stay blocked. The supplied 200×200 PNG is exposed as `/board-icon.png` and the production web build contains the identical SHA-256 (`a051481e2a07807facc938a1cdee0c7a0f9fc993ec21eff354a4e6365a6c46b8`).

The generated catalog contains Board, the five actions, custom credential fields, and the icon URL. Verification passed the focused Board runtime test (2 tests), `npm run generate:catalog`, `npm run fix-check`, all 59 Vitest files / 439 tests, the production web build, and `git diff --check`. A live Board connection was not exercised because no durable service URL/token was supplied. The current Board server optionally accepts a bearer token, but its repository does not document a durable machine-token lifecycle; authenticated deployments may need a long-lived Board API-key feature rather than an expiring Clerk session token.

---

# Task Plan

## Goal

Explain how Connections can create a provider from an `openapi.json` file and identify the current supported workflow and limitations.

## Constraints

- Inspect only; do not generate or modify a provider without a named target API and specification.
- Follow the repository's curated-provider and SSRF-safe runtime requirements.
- Prefer the existing provider structure and dependencies.

## Steps

- [x] Trace the root provider-generation command.
- [x] Inspect the existing OpenAPI-backed generator and normal provider examples.
- [x] Review the repository's OpenAPI provider instructions and validation gates.

## Verification

- [x] Confirmed whether the root command accepts arbitrary OpenAPI documents.
- [x] Confirmed the required provider files, auth mapping, runtime boundary, and checks.
- [x] Reviewed the current generator's source-path and checksum behavior.

## Review

Connections does not currently have a generic `openapi.json`-to-provider command. `npm run generate:provider -- <provider>` only dispatches to an existing provider-local `generate.ts`; the sole current example is Dokploy, whose generator is intentionally pinned to Dokploy's specification and SHA-256. The normal path is to inspect the OpenAPI document, select at most five useful runnable operations, and author a native `definition.ts`, `actions.ts`, `executors.ts`, plus an optional shared `runtime.ts`. A broad generator is justified only for stable, redistributable specs and remains provider-specific. Provider egress must use the injected guarded fetch. Validation is `npm run generate:catalog`, `npm run fix-check`, targeted tests for non-trivial runtime behavior, and `npm test` before contribution.

---

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

---

# Task Plan

## Goal

Expand the default approval heuristic to cover the catalog's other mutation-style verbs while retaining safe read-only defaults and every explicit workspace override.

## Constraints

- Inspect only normalized catalog verbs; do not expose provider action names.
- The recognition rule must match words in either the action ID or action name, including camel-case names, without treating unrelated substrings as verbs.
- Existing stored workspace policies override the default.
- Update the locked decision and vision with the broadened policy.

## Steps

- [x] Inspect the complete generated catalog and identify mutation-style verb candidates.
- [x] Centralize the approved mutation-verb set in the default-policy resolver.
- [x] Cover the requested mutation verbs, camel-case names, and a read-only control in regression tests.
- [x] Update product documentation and verify the full application.

## Verification

- [x] Requested mutation verbs default to approval on.
- [x] Read-only actions still default off.
- [x] Stored workspace policy still overrides the default.
- [x] `npm run fix-check`, web build, focused tests, and full suite pass.

## Review

The default policy now recognizes the expanded mutation-verb set in action IDs and names, including camel-case names. It covers creation, deletion, updates, sends, adds/removals, submission, upload, archive, revoke, transfer, access/lifecycle changes, publishing, sharing, scheduling, and similar mutations; read-only actions remain off by default. Explicit workspace policies still override this fallback. The locked decision and vision were updated. Verification passed focused policy/UI/MCP tests, `npm run fix-check`, the web build, all 56 Vitest files / 423 tests, and `git diff --check`.

---

# Task Plan

## Goal

Make the Actions browser start with actions from connected providers only, while allowing a user to add or remove multiple provider filters during that browser session.

## Constraints

- Derive the default only from the current app data; do not persist the user selection.
- A browser refresh resets to the currently connected-provider default.
- Preserve action deep links and the selected-action behavior.

## Steps

- [x] Trace the single-provider Actions filter and available connection data.
- [x] Replace the single-select filter with a multi-provider control initialized from connected providers.
- [x] Preserve search, clear, pagination, and deep-link behavior.
- [x] Add focused UI/model regression coverage and verify the application.

## Verification

- [x] Initially connected providers are the only included action sources.
- [x] Users can select and deselect multiple providers.
- [x] A new page load returns to the connected-provider default.
- [x] `npm run fix-check`, web build, focused tests, and full suite pass.

## Review

The Actions browser now begins with only providers that have an active, non-virtual credential connection. Its provider dropdown is a multi-select: people can add or remove providers for the current browser session, while the Clear control and a browser refresh return to the connected-provider default. Search, pagination, and action deep links remain intact. The approval default now also recognizes the catalog's full mutation-verb set, including camel-case action names; stored workspace policies still override the default. Focused tests, the web production build, `npm run fix-check`, the full Vitest suite (56 files / 426 tests), and `git diff --check` passed.

---

# Task Plan

## Goal

Expose Clerk's hosted user-profile modal from the Connections header.

## Constraints

- Reuse Clerk's prebuilt profile component; do not duplicate profile fields, account security, or identity storage in Connections.
- Match the existing Clerk Organization modal interaction instead of creating a duplicate application page.

## Steps

- [x] Confirm the installed Clerk modal API.
- [x] Replace the Profile navigation route with a header profile button that opens Clerk's modal.
- [x] Update the product documentation and accessible button translations.
- [x] Build and regression-test the revised console.

## Verification

- [x] The header button opens Clerk's prebuilt user-profile modal.
- [x] No Profile route or sidebar item remains.
- [x] Web build, project checks, tests, and diff validation pass.

## Review

The header now uses a compact person icon that calls Clerk's prebuilt user-profile modal. It replaces the workspace label; the Profile route and sidebar entry were removed. The web production build, focused UI/i18n tests, `npm run fix-check`, the full Vitest suite (56 files / 426 tests), and `git diff --check` passed.

---

# Task Plan

## Goal

Connect Codex to the user's Coolify instance through the Coolify MCP server.

## Constraints

- Keep the supplied API token out of the repository and command output.
- Preserve the existing Coolify MCP configuration until the new connection is verified.
- Verify with a read-only initialization request only.

## Steps

- [x] Inspect the upstream MCP setup and existing local Codex configuration.
- [x] Add a separate local Coolify MCP entry with the supplied token.
- [x] Verify the MCP handshake without modifying Coolify resources.

## Verification

- [x] The local Codex configuration contains a Coolify MCP server for the verified host.
- [x] The server initializes successfully with the new token.
- [x] No repository or Coolify resource is changed.

## Review

Added a separate local `coolify_fractals` Codex MCP entry for the verified Coolify host without altering the pre-existing Coolify configuration. A direct standard-MCP stdio verification completed `initialize`, `tools/list`, and the read-only `get_version` call successfully. No repository application code or Coolify resource was changed. The supplied token was kept out of repository files and command output; because it was pasted into chat, it should be rotated in Coolify after this connection has been replaced with a newly issued token.

---

# Task Plan

## Goal

Prevent the header profile control from shifting through the center while runtime data refreshes, then release the fix to the production Coolify application.

## Constraints

- Preserve Clerk's prebuilt profile modal and existing header layout.
- Show exactly one right-side header state: the loader while loading, then the profile button.
- Do not change runtime loading or authentication behavior.
- Deploy only the pushed `main` revision to Coolify application `m14hs9i7dspgix9ul8gx7lgp`.

## Steps

- [x] Trace the loading state and identify the flex-layout root cause.
- [x] Render the loader and profile button as mutually exclusive states.
- [x] Run focused checks and project verification; attempt rendered UI validation.
- [x] Commit and push the fix to `main`.
- [x] Redeploy the exact Coolify application and verify its health/logs.

## Verification

- [x] Loading state renders the loader without a profile icon.
- [x] Loaded state renders the profile icon in the right-side header slot.
- [x] Clerk profile modal callback remains attached to the loaded-state button.
- [x] `npm run fix-check`, web build, relevant/full tests, and `git diff --check` pass.
- [x] Coolify reports the new deployment healthy.

## Review

The header now renders one mutually exclusive right-side state: runtime loading feedback first, then the Clerk profile button. This removes the third flex child that temporarily centered the profile icon. Commit `c5d5402` was pushed to `origin/main` and deployed through Coolify as deployment `eap026r9w7g1zmhbbastzlnz`; Coolify reports `running:healthy`, the new production asset hashes match the local build, and the container log tail has no error signals. Verification passed `npm run fix-check`, the web production build, the focused UI test (4 tests), the full Vitest suite (56 files / 426 tests), and `git diff --check`. Rendered browser automation was attempted, but the browser runtime reported that no browser backend was available, so the loading transition and Clerk modal interaction could not be visually exercised in this session.

---

# Task Plan

## Goal

Create a repository-local skill that gives future agents accurate, app-specific guidance for developing and debugging Connections across its UI, state/loading behavior, responsive layout, browser-to-backend data flow, APIs, storage, logs, deployment, and error handling.

## Constraints

- Derive the skill from current source, tests, product decisions, and verified deployment behavior.
- Keep the skill concise and progressively disclose detailed architecture through references.
- Do not duplicate generic React, Hono, Clerk, InsForge, or Coolify documentation.
- Preserve the current dirty task/lesson notes and avoid unrelated source changes.
- Include no credentials, tenant data, or environment-specific secrets.

## Steps

- [x] Audit frontend UI composition, state ownership, loading/error transitions, responsive CSS, and UI tests.
- [x] Audit backend/API routes, authentication, workspace authorization, data/storage flow, MCP, and error shaping.
- [x] Audit logs, Coolify deployment, InsForge diagnostics, migrations, and verification commands.
- [x] Initialize `.agents/skills/connections-development` with focused references and agent metadata.
- [x] Validate the skill structure and forward-test it against realistic maintenance tasks.
- [x] Review, commit, and push the completed skill.

## Verification

- [x] Every requested area has an authoritative source path and actionable workflow.
- [x] The skill preserves locked product/security boundaries.
- [x] The skill validator passes.
- [x] Independent forward-tests can locate the correct code and verification path without hidden context.
- [x] `git diff --check` passes and only intended skill files are included in the release commit.

## Review

Created the repository-local `connections-development` skill with a concise development/debugging workflow and progressive references for frontend behavior, backend/data/auth/MCP boundaries, and operations/logging/deployment. The research traced current source, tests, product decisions, and verified production behavior, and records known hazards rather than presenting them as solved. The official skill validator passes in an isolated PyYAML environment; all skill Markdown is repository-formatted and its links resolve. Three fresh-agent forward tests independently found the correct workspace-switch remount boundary, connection-label ownership boundary, and OAuth/Coolify/InsForge diagnostic path without hidden conversation context. Commit `1776268` contains only the five intended skill files and is pushed to `origin/main`.

---

# Task Plan

## Goal

Remove obsolete Autonomous/Specify framework artifacts and their repository-local skills, determine whether `sqlite-migrations` is still required, identify other demonstrably unused repository artifacts, and explain the practical commercial implications of `LICENSE.txt`.

## Constraints

- Trace every candidate through source, scripts, tests, documentation, CI, Docker, and package metadata before deletion.
- Preserve SQLite local/single-user compatibility required by `connections-docs/LOCKED.md`.
- Do not remove upstream attribution, copyright notices, or generated/runtime inputs still consumed by the app.
- Treat license guidance as general information, not individualized legal advice; verify material claims against authoritative sources.
- Preserve unrelated working-tree changes in `tasks/todo.md` and `tasks/lessons.md`.

## Steps

- [x] Inventory `.autonomous`, `.specify`, their linked skills/scripts/docs, `sqlite-migrations`, and the repository root.
- [x] Trace all references and classify each artifact as required, generated, historical, or removable.
- [x] Review `LICENSE.txt`, repository notices, dependency licenses, and authoritative commercial-use obligations.
- [x] Delete only the confirmed obsolete framework artifacts and update stale references.
- [x] Verify the cleaned repository with focused searches, project checks, and the full relevant test suite.

## Verification

- [x] No live code, scripts, CI, docs, or skills reference removed paths.
- [x] SQLite startup and migrations remain functional if retained.
- [x] Application build, tests, formatter/linter, and `git diff --check` pass.
- [x] License explanation distinguishes permissions, obligations, upstream notices, trademarks, and client-contract considerations.
- [x] Review documents the exact deletion set and any candidates intentionally retained.

## Review

Removed 71 tracked Autonomous/Specify framework and dedicated-skill files, their four Autonomous lock records, and the obsolete Spec Kit block in `AGENTS.md`. Also removed the redundant `docker-compose.build.yml` and stale `web/PRODUCT.md`; six retained upstream deployment documents now use the equivalent `docker compose up --build` command. No live code, CI, package script, or documentation references a removed path.

Retained `sqlite-migrations` because the local SQLite runtime, Docker image, D1/SQLite tests, and locked compatibility decision require it. Retained `migrations`, `connections-docs`, alternate Fly/Cloudflare configuration, examples, public governance/license files, and the unlinked upstream documentation/assets because those are supported or require a separate public-documentation decision rather than mechanical deletion.

The repository is Apache-2.0: commercial SaaS, consulting, support, and client deployments are permitted. Distribution still requires license/notice preservation and modified-file/third-party attribution; Apache does not grant OOMOL trademarks or logos. Before client sales, rebrand the remaining OOMOL-facing UI/assets, create a reviewed third-party notices bundle for distributed builds, and review provider/OAuth privacy obligations. This is an engineering license audit, not legal advice.

Verification passed `npm run fix-check`, all 56 Vitest files / 426 tests, Compose configuration validation, focused formatting for every edited retained file, JSON parsing, removed-reference scans, and `git diff --check`.

---

# Task Plan

## Goal

Release the complete reviewed repository cleanup to `main` and deploy that exact commit to the production Connections application in Coolify.

## Constraints

- Include every current intended repository change and no ignored local state, credentials, generated output, or unrelated artifacts.
- Revalidate the user's additional deletions against live source/build/test/deployment references before committing.
- Push only after all local checks pass.
- Deploy only Coolify application `m14hs9i7dspgix9ul8gx7lgp`, wait for terminal status, and verify health plus error-level logs.

## Steps

- [x] Audit the final working tree and confirm every deletion is safe.
- [x] Run the repository, Docker Compose, and reference-integrity checks.
- [ ] Commit all intended changes and push `main`.
- [ ] Deploy the pushed commit to the Connections Coolify application.
- [ ] Verify the deployment revision, health, and application logs.

## Verification

- [ ] The release commit contains exactly the reviewed cleanup.
- [ ] `origin/main` matches the local release commit.
- [ ] Coolify reaches a terminal successful deployment state for that commit.
- [ ] The application is healthy and its recent logs contain no error-level signals.
- [ ] Review records the commit and deployment evidence.

## Review

Pending.

---

# Task Plan

## Goal

Verify the linked InsForge CLI/backend state and determine the smallest correct way to use the existing Connections database for Meetily transcript ingestion and provider reads.

## Constraints

- Keep this inspection read-only; do not create tables, functions, secrets, branches, or data yet.
- Confirm the linked project before querying it.
- Do not print credentials, project keys, database URLs, or meeting/user data.
- Preserve the locked Hono API boundary for Connections product data unless a deliberate architecture decision changes it.

## Steps

- [x] Confirm the installed InsForge CLI version and authenticated identity.
- [x] Resolve and link the existing Connections project using the CLI's required explicit project ID.
- [x] Review relevant project memory, migration history, public schema, functions, and secret names.
- [x] Compare the available InsForge primitives with the Meetily provider design.

## Verification

- [x] CLI targets the expected Connections project.
- [x] Existing backend capabilities are confirmed from read-only CLI output.
- [x] Recommended implementation identifies the ingest boundary, storage objects, and provider read path.
- [x] No backend state or secret value was changed or exposed.

## Review

InsForge CLI 0.2.0 is authenticated and the checkout is explicitly linked to the existing `Connections` project in `eu-central`. The production public schema contains the current Connections workspace/runtime tables, three applied migrations, no Meetily objects, and no deployed edge functions. Secret names were inspected without reading values; no backend state changed.

The smallest sound v1 is a migration for workspace-scoped Meetily meeting storage plus one token-protected `meetily-ingest` edge function that validates JSON, caps the body, resolves the token to a server-owned workspace, and upserts by `(workspace_id, external_id)`. The Connections Meetily provider should read the same Postgres database server-side through the existing application boundary and expose curated read actions. Do not give the Mac or a provider connection the InsForge admin API key, and do not trust a payload-supplied workspace ID.

---

# Task Plan

## Goal

Publish completed Meetily meetings into the existing Connections InsForge project and expose those transcripts through a first-class Connections Meetily provider.

## Constraints

- Keep InsForge admin credentials server-only; Meetily receives only a scoped ingest token.
- Derive workspace ownership from the ingest token, never from payload input.
- Preserve existing uncommitted work in both repositories.
- Use additive migrations and the smallest provider/publisher changes that cover completed meetings.
- Do not deploy production schema/function changes until the isolated backend path and local checks pass.

## Steps

- [x] Trace Meetily's meeting-completion persistence flow and Connections provider/runtime patterns.
- [x] Define the meeting schema and protected ingest contract.
- [x] Implement and verify the additive InsForge migration/function directly on production as requested.
- [x] Implement the Connections Meetily provider and its read actions.
- [x] Implement Meetily's post-completion publisher with Keychain configuration.
- [x] Run focused/full relevant checks and an end-to-end synthetic meeting round trip.
- [x] Release the Connections provider code and document the one-key v1 limitation.

## Verification

- [x] Duplicate delivery upserts rather than duplicates.
- [x] Invalid/missing tokens and malformed/oversized payloads are rejected.
- [ ] One workspace cannot read or overwrite another workspace's meetings; v1 intentionally uses one project-wide key.
- [x] Provider list/get/latest/search actions return curated meeting and transcript data.
- [x] Meetily completion remains successful when publishing is unconfigured or temporarily unavailable.
- [x] No secret values appear in tracked files or command output.
- [x] Both repositories' relevant checks pass and production backend state matches the reviewed artifacts.

## Review

Created and applied the additive `meetily_meetings` migration in the production Connections InsForge project, deployed the authenticated `meetily` edge function, and installed its generated key in InsForge plus the local macOS Keychain. Unauthorized requests return `401`; two identical authorized deliveries both return `200` and produce one row. Authenticated latest/search reads returned the synthetic transcript, and all synthetic rows were removed afterward.

Connections now ships a first-class Meetily API-key provider with list, get, latest, and transcript-search actions. Commit `9fdd7ee` passed typecheck plus all 58 test files / 437 tests, was pushed to `main`, and Coolify deployed that exact commit healthy. The provider is enabled only in the existing two-member workspace. The browser automation session reached Clerk sign-in, so storing the encrypted provider connection still requires the owner to sign in and paste the API key already placed on the clipboard.

Meetily publishes from the successful local SQLite save path in a detached task, so an unavailable network cannot fail the recording save. `cargo check` and the focused publisher test pass. Existing unrelated Meetily edits remain untouched. V1 deliberately uses one project-wide key; add workspace-scoped keys before sharing this transcript source with another Connections workspace.

---

# Task Plan

## Goal

Restore the production workspace safety-config endpoint after the Connections deployment returned HTTP 500.

## Constraints

- Diagnose from the deployed logs and production schema before mutating state.
- Apply only the existing additive migration required by the deployed code.
- Do not expose credentials or alter workspace data.

## Steps

- [x] Trace the endpoint's storage query and inspect bounded production logs.
- [x] Compare the production migration registry and schema with the deployed code.
- [x] Apply the missing workspace safety-settings migration.
- [x] Verify the migration registry, required tables, and public route behavior.

## Verification

- [x] Production logs identify the exact missing relation and SQLSTATE.
- [x] Migration `20260718095600_workspace-safety-settings` is registered in production.
- [x] All three safety/idempotency tables exist in the public schema.
- [x] The unauthenticated live route reaches Clerk authentication and returns `401`, not `500`.

## Review

The deployed code queried `workspace_safety_settings`, but production had not received its additive migration. Coolify logs confirmed PostgreSQL `42P01` on `GET /api/workspace/safety-config`. Applying migration `20260718095600_workspace-safety-settings` created the workspace safety, provider safety, and idempotency tables. The InsForge migration registry and `information_schema` now report all required objects, and the live route returns the expected Clerk `401` when called without a session instead of failing at the server boundary. No application redeploy was required.

---

# Task Plan

## Goal

Use the supplied Meetily application icon in Connections and provide the existing dedicated API key safely.

## Constraints

- Reuse the existing provider `iconUrl` mechanism.
- Do not print or commit the API key.
- Deploy only after the generated catalog and web build pass.

## Steps

- [x] Convert the supplied ICNS icon to a web PNG.
- [x] Point the Meetily provider at the local icon asset.
- [x] Regenerate the provider catalog and verify the web build.
- [x] Push and deploy the reviewed change.
- [x] Copy the dedicated Meetily key from Keychain to the clipboard.

## Verification

- [x] The generated Meetily catalog contains the local icon URL.
- [x] The built web bundle contains the icon.
- [x] The production web bundle serves the icon.
- [x] Coolify deploys the exact pushed revision healthy.

## Review

The supplied ICNS asset was converted to a 256 px PNG and exposed through the existing provider `iconUrl` field. Catalog generation, `npm run fix-check`, the web build, and `git diff --check` passed. Commit `34b8e7d` was pushed and Coolify deployed that exact revision healthy. The production icon returns `200 image/png` and its SHA-256 matches the tracked asset. The dedicated API key remained in Keychain and was copied directly to the clipboard without being printed.

---

# Task Plan

## Goal

Preserve the original Meetily transcript beside the LLM-corrected default transcript and expose both through the Connections provider.

## Constraints

- Keep one row per meeting and preserve summaries during transcript-only retries.
- Keep the existing dedicated ingest key and protected table access unchanged.
- Test schema/function changes on an InsForge branch before production.
- Do not leave synthetic meetings in either backend.

## Steps

- [x] Add raw transcript text and segment columns through an additive migration.
- [x] Extend the ingest function without clearing omitted raw or summary data.
- [x] Expose corrected/default and raw transcript fields through provider actions.
- [x] Verify the branch, merge to production, deploy the function, and reload PostgREST schema.
- [x] Push and deploy the exact Connections revision.

## Verification

- [x] Corrected and raw segment JSON coexist under one external meeting ID.
- [x] A later transcript-only upsert preserves the original transcript.
- [x] The production authenticated round trip passes and synthetic rows are deleted.
- [x] Typecheck and all 437 provider/runtime tests pass.
- [x] Coolify deploys the pushed revision and reports `running:healthy`.

## Review

Migration `20260719130001_add-meetily-raw-transcript.sql` and the updated `meetily` edge function were proven on schema-only branch `meetily-raw-transcript`, whose dry-run merge reported zero conflicts. Production now stores `raw_transcript` and `raw_transcript_segments` beside the corrected/default fields. An authenticated two-version production upsert proved the row stays singular and later corrected snapshots do not erase the raw copy; the synthetic row was removed.

Provider normalization now returns `rawTranscript` and `rawTranscriptSegments` in detailed meeting actions while retaining `transcript` and `transcriptSegments` as the corrected/default version. Typecheck and all 58 test files / 437 tests passed. Commit `7e76131` was pushed and Coolify deployment `yuv80otfx6mtmh6yjpgkuxqc` finished at that exact revision; the application is `running:healthy` and startup logs contain no application errors.

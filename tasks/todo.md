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
- [ ] Release the Connections provider code and document the one-key v1 limitation.

## Verification

- [x] Duplicate delivery upserts rather than duplicates.
- [x] Invalid/missing tokens and malformed/oversized payloads are rejected.
- [ ] One workspace cannot read or overwrite another workspace's meetings; v1 intentionally uses one project-wide key.
- [x] Provider list/get/latest/search actions return curated meeting and transcript data.
- [x] Meetily completion remains successful when publishing is unconfigured or temporarily unavailable.
- [x] No secret values appear in tracked files or command output.
- [x] Both repositories' relevant checks pass and production backend state matches the reviewed artifacts.

## Review

Pending.

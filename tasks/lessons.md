# Lessons

## 2026-07-19 - Match constraints to the schema helper contract

Mistake: Passed `maxLength` to `s.nonEmptyString`, whose options intentionally expose only the shared JSON Schema options.
Why it happened: Assumed the convenience helper forwarded every string constraint without checking its exact signature.
Rule for next time: Use `s.string(description, { minLength, maxLength })` when a string needs bounds beyond non-emptiness.
Example check: Read the selected helper signature in `src/core/json-schema.ts` before combining convenience helpers with extra constraints.

## 2026-07-19 - Lead with the repository provider skill

Mistake: Explained that Connections lacks a generic OpenAPI importer before clearly answering that the repository already has an `add-provider` skill for creating providers from OpenAPI specifications.
Why it happened: Focused on the implementation mechanism and command limitations instead of the user's agent workflow.
Rule for next time: When asked how the agent creates a provider from OpenAPI, lead with `.agents/skills/add-provider/SKILL.md` and its `references/openapi-provider.md`; mention the absence of a generic importer only as a secondary implementation detail.
Example check: State “Yes, use the add-provider skill” before describing provider files or generator commands.

## 2026-07-19 - Reload PostgREST after merging branch migrations

Mistake: Expected a successful InsForge branch merge to refresh the parent PostgREST schema cache automatically.
Why it happened: The new columns and migration history existed in PostgreSQL, but the parent PostgREST process had not received a reload notification and rejected the first new-column write with `PGRST204`.
Rule for next time: After merging schema changes, verify an API request using every new column and explicitly reload the `pgrst` schema cache if it is stale.
Example check: Function logs contain no `PGRST204`, and the exact new-column payload succeeds before the release is marked complete.

## 2026-07-19 - Apply every migration required by the deployed revision

Mistake: Deployed Connections code that queried the workspace safety tables while deliberately leaving its existing migration unapplied in production.
Why it happened: The Meetily release verification focused on the new Meetily migration and treated an older pending migration as unrelated, even though the deployed revision already depended on it.
Rule for next time: Before every application deploy, diff the revision's migrations against the production migration registry and apply every schema dependency in order, not only the migration added by the current feature.
Example check: `db migrations list` and targeted `to_regclass` checks must show every table referenced by the release before Coolify deploys the revision.

## 2026-07-19 - Avoid broad Coolify application reads

Mistake: Used the full Coolify application-details call for post-deploy verification, and its response included deploy webhook credentials alongside the needed health metadata.
Why it happened: Chose a broad resource read after the targeted diagnosis and log calls already contained the required evidence.
Rule for next time: Verify deployments with targeted diagnose, deployment, and log calls; do not request full application configuration unless a specific field is required.
Example check: The planned output fields should be limited to status, commit, health, and bounded logs before invoking a Coolify read.

## 2026-07-19 - Do not seed a shared-key provider into every workspace

Mistake: Enabled the v1 Meetily provider for every active workspace before checking how many workspaces existed.
Why it happened: Treated a personal InsForge project as equivalent to one Connections workspace even though the product is multi-workspace.
Rule for next time: Count and identify target workspaces before inserting provider enablement; a project-wide external key must be connected to exactly one intended workspace.
Example check: Query active workspace count first, then verify `workspace_providers` has one `meetily` row before distributing the key.

## 2026-07-19 - Install locked dependencies before project checks

Mistake: Ran `npm run fix-check` in a fresh clone before installing dependencies, so verification stopped at the missing local `oxlint` binary.
Why it happened: Provider generation uses Node directly and succeeded, masking that package binaries were unavailable.
Rule for next time: In a fresh checkout, confirm `node_modules/.bin` contains the repository check tools or run `npm ci` before generation and verification.
Example check: `test -x node_modules/.bin/oxlint` must pass before `npm run fix-check`.

## 2026-07-19 - Name the non-primary upsert conflict target

Mistake: Sent a PostgREST merge-duplicates request without `on_conflict`, so the first Meetily insert worked but a repeated `external_id` delivery failed against the unique constraint.
Why it happened: The upsert header was treated as sufficient even though the idempotency key is not the table's primary key.
Rule for next time: For every PostgREST upsert keyed by a non-primary unique constraint, include `?on_conflict=<unique_column>` and verify the same payload twice.
Example check: Two identical ingest requests both return success and a count query still returns exactly one row.

## 2026-07-19 - InsForge link without a project only refreshes guidance

Mistake: Ran `npx @insforge/cli link -y` expecting the single visible project to be selected automatically, but CLI 0.2.0 only refreshed agent skills and rewrote the InsForge block in `AGENTS.md`.
Why it happened: Relied on older skill wording instead of checking the installed CLI command help first.
Rule for next time: On an unlinked checkout, run `npx @insforge/cli link --help` first and pass the exact existing `--project-id` and `--org-id`; preserve and inspect repository guidance before any bootstrap-style command.
Example check: `npx @insforge/cli current` must name the expected project, and `git diff -- AGENTS.md` must remain empty after linking.

## 2026-07-16 - Separate binary cleanup from text patches

Mistake: Included PNG assets in a generated `apply_patch` deletion set, which failed because the patch tool reads deleted files as UTF-8.
Why it happened: The cleanup set was generated from tracked paths without classifying binary files first.
Rule for next time: Before bulk deletion through `apply_patch`, classify paths with `git diff --numstat` or `file` and keep binary deletion in a separately reviewed operation.
Example check: Confirm the generated patch contains only text files before calling `apply_patch`.

## 2026-07-16 - Run the repository formatter on generated skill references

Mistake: Validated skill structure before checking the generated Markdown references with the repository formatter.
Why it happened: Skill validation checks metadata and naming, not project-specific Markdown formatting.
Rule for next time: After writing a repository-local skill, run `oxfmt` on the skill folder before the final validator and diff check.
Example check: `npx oxfmt .agents/skills/<skill> && npx oxfmt --check .agents/skills/<skill>`.

## 2026-07-16 - Run the skill validator with an isolated YAML dependency

Mistake: Invoked `quick_validate.py` with the system Python even though PyYAML was not installed there.
Why it happened: The validator's dependency was assumed to be bundled with the script.
Rule for next time: Check the validator dependency first and run it through `uv run --with pyyaml` when the system interpreter lacks YAML support.
Example check: `uv run --with pyyaml python scripts/quick_validate.py <skill-folder>`.

## 2026-07-16 - Invoke non-executable skill scripts through their interpreter

Mistake: Tried to execute the skill initializer directly even though its executable bit was not set.
Why it happened: The skill documentation showed the script as an executable command, but the installed file permissions differed.
Rule for next time: Check a provided script's interpreter and permissions before invocation; use the declared interpreter when it is not executable.
Example check: `test -x scripts/init_skill.py || python3 scripts/init_skill.py --help`.

## 2026-07-16 - Treat header status controls as one layout slot

Mistake: Rendered the profile button and runtime loader as separate siblings in a `space-between` header, which moved the profile button into the center during refresh.
Why it happened: The profile control was added without checking the existing transient loading state in the same flex container.
Rule for next time: When adding a right-aligned header control, inspect every loading and error state and render mutually exclusive controls through one stable layout slot.
Example check: Capture the header once during loading and once after loading; the right-side content must not create an extra flex child.

## 2026-07-16 - Use Clerk's modal surface for account settings

Mistake: Embedded Clerk UserProfile as a full Connections route when the requested experience matched the existing Clerk Organization modal.
Why it happened: I optimized for direct route access instead of matching the console's established profile-management interaction.
Rule for next time: When reusing Clerk management UI, first match the existing organization switcher/modal interaction before adding application navigation.
Example check: Compare the proposed Clerk component with the OrganizationSwitcher behavior shown in the live console.

## 2026-07-15 - Keep approval in the agent conversation

Mistake: Proposed a browser approval link when the requested product experience was an in-chat confirmation.
Why it happened: I optimized for a server-verifiable authorization boundary before confirming whether the user wanted a security control or a conversational interaction pattern.
Rule for next time: Distinguish an agent-mediated confirmation prompt from a server-enforced approval grant before designing the flow.
Example check: Ask whether the desired outcome is "the agent asks me" or "the server must prove I approved."

## 2026-07-15 - Verify the deployed revision contains the deployment fix

Mistake: Reported the local Compose correction before verifying it had reached the Git revision Coolify deploys.
Why it happened: Local validation was mistaken for deployment-state validation.
Rule for next time: After any deployment configuration edit, compare `origin/<branch>` to the local diff before asking for or interpreting a redeploy.
Example check: `git show origin/main:docker-compose.yml` must include the new build argument before Coolify can consume it.

## 2026-07-15 - Scope Clerk bearer tokens to the selected workspace

Mistake: Treated `useAuth().orgId` and an unscoped `getToken()` call as if they always represented the same active organization.
Why it happened: The first repair verified that the selector rendered, but did not account for Clerk's per-tab organization token behavior.
Rule for next time: For every browser-to-API request that is workspace-scoped, request the Clerk token with the selected `organizationId` and verify the server claim path.
Example check: Assert that the API bearer-token call uses `getToken({ organizationId: orgId, skipCache: true })`.

## 2026-07-15 - Do not equate Clerk membership with application authorization without synchronization

Mistake: Treated the Clerk Organization invite UI as a complete workspace-membership implementation.
Why it happened: The intended one-organization/one-workspace model was reviewed without tracing the application membership row required for runtime-token authorization.
Rule for next time: Before exposing team invites, verify creation, removal, and role changes all synchronize with the application authorization store.
Example check: An invited user can create and use a runtime token; after removal, that token receives `401` immediately.

## 2026-07-15 - Keep InsForge project credentials out of diagnostic output

Mistake: Used a broad InsForge project/config diagnostic that included the project API key in command output.
Why it happened: The diagnostic was treated as harmless metadata instead of as a credential-bearing configuration read.
Rule for next time: Use targeted CLI queries and table checks; never print `.insforge/project.json` or broad project JSON output.
Example check: Before running an InsForge command, confirm its output cannot include an app key, database URL, or other secret.

## 2026-07-15 - Verify the linked InsForge project before migrations

Mistake: Applied safe pending migrations while the CLI was linked to an empty stale branch rather than the Connections project.
Why it happened: The linked context was assumed to match `.env.local` without checking the project name and deployment host first.
Rule for next time: Before any InsForge mutation, compare the CLI project name and host with the non-secret database host configured for the app.
Example check: `npx @insforge/cli current` must identify the expected project before `db migrations up` runs.

## 2026-07-15 - Verify the production webhook, not only its source code

Mistake: Treated the signed Clerk webhook implementation as complete without probing its deployed endpoint after setting the required environment variable.
Why it happened: Source tests proved signature and synchronization behavior, but the Coolify secret and Clerk endpoint configuration remained external deployment state.
Rule for next time: After adding any webhook, send a harmless unsigned request to the production endpoint; `400 invalid signature` proves the secret is live, while `404` means the integration is disabled.
Example check: `POST /api/webhooks/clerk` must return `400` before inviting the first collaborator.

## 2026-07-16 - Avoid shell-reserved variable names in zsh commands

Mistake: Used `status` in a webhook check and later `path` in a cleanup loop; both are special zsh parameters, and assigning `path` broke command lookup for the rest of that shell.
Why it happened: The commands were written with generic variable names without checking zsh's special parameter set.
Rule for next time: Use descriptive, non-special names such as `http_status` and `candidate_dir` in cross-shell diagnostic commands.
Example check: Run the composed command once in the active shell before combining it with state inspection, and never use `path`, `status`, or `commands` as loop variables in zsh.

## 2026-07-15 - Count SQL insert values before combining a repair with its audit event

Mistake: The one-statement membership recovery omitted the nullable `resource_id` value for its audit insert.
Why it happened: The statement was composed manually instead of matching its value list against the explicit target columns.
Rule for next time: For an audited correction, list each target column and its matching value before executing the transaction.
Example check: Verify the target-column and value counts match before running the `db query` command.

## 2026-07-15 - Treat pasted runtime tokens as exposed

Mistake: A runtime token was supplied in chat for a live MCP verification.
Why it happened: The direct test required bearer authentication, but chat is not a secret store.
Rule for next time: Use a pasted token only for the requested read-only verification, never repeat it in output, and ask the owner to revoke and replace it immediately afterward.
Example check: Confirm the replacement token is stored only in the MCP client's local configuration.

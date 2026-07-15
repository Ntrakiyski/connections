# Lessons

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

## 2026-07-15 - Avoid shell-reserved variable names in verification commands

Mistake: Used `status` as a zsh variable while checking the webhook response.
Why it happened: The command was written for generic POSIX shells without accounting for zsh's readonly special parameter.
Rule for next time: Use descriptive, non-special names such as `http_status` in cross-shell diagnostic commands.
Example check: Run the composed command once in the active shell before combining it with state inspection.

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

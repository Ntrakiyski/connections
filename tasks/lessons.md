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

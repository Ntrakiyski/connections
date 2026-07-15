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

# Task Plan

## Goal

Repair the authenticated Connections console so a signed-in user can select or create an active Clerk Organization, returns to the app after authentication, and can load workspace-scoped API data.

## Constraints

- Preserve the locked rule that one Clerk Organization maps to one Connections workspace.
- Do not log, change, or commit secrets or Clerk tenant data.
- Keep Clerk authentication and organization management in Clerk; Connections owns only its effective workspace roles and data.

## Steps

- [x] Review the product decisions, current deployment behavior, and existing Clerk integration.
- [x] Reproduce the authenticated client/server flow locally and capture the API error.
- [x] Trace active-organization state from Clerk token claims through the server.
- [x] Add the smallest UI/auth configuration needed to return to Connections and select/create an organization.
- [x] Verify the corrected local build, signed-out browser flow, and API client behavior.
- [ ] Push the reviewed fix to `main` for Coolify redeployment.

## Verification

- [x] Sign-in and sign-up are configured to return to the Connections console.
- [x] The console exposes Clerk organization selection/creation and hides the unsupported personal context.
- [ ] An active Clerk Organization lets the workspace API load successfully.
- [x] No application browser errors remain in the tested signed-out flow.
- [x] `npm run fix-check` passes.

## Review

The API failure was a valid `workspace_required` response: the Clerk JWT had no active `org_id`, but the old console did not let the user select one. It also contained a dead, app-owned workspace selector that called nonexistent workspace API routes. The fix uses Clerk's `OrganizationSwitcher` for selecting/creating the active workspace, reloads data when the active org changes, removes the dead selector and its requests, and forces sign-in/sign-up back to `/`. Targeted and full tests passed (400 tests), as did `npm run fix-check` and a local production browser check with no application errors. The disposable local browser cannot complete the user's Google sign-in, so the active-organization request still needs one manual authenticated check before the change is pushed.

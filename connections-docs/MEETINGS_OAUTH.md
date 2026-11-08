# Meetings OAuth contract: meetings-v1

This is the server contract for the coordinated [Connections #10](https://github.com/Ntrakiyski/connections/issues/10) and [Meetings #11](https://github.com/Ntrakiyski/connections/issues/11) release. The server uses the pinned Better Auth OAuth provider (`1.7.18`). A desktop grant belongs to the original verified user, company and workspace chosen in Connections consent. Browser company selection is not a grant.

## Native configuration

For a deployment with exact HTTPS origin `ORIGIN`:

| Setting                        | Value                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Issuer                         | `ORIGIN/api/identity`                                                           |
| Authorization-server discovery | `ORIGIN/.well-known/oauth-authorization-server/api/identity`                    |
| Protected-resource discovery   | `ORIGIN/.well-known/oauth-protected-resource/api/meetings`                      |
| Client ID                      | `meetings-desktop-v1`                                                           |
| Client authentication          | Public client; no secret                                                        |
| Redirect URI                   | Exactly `meetingly://oauth/callback`                                            |
| Resource                       | `ORIGIN/api/meetings`                                                           |
| Requested scopes               | `meetings:read meetings:write offline_access`                                   |
| Authorization                  | Authorization code, S256 PKCE, cryptographically random state, explicit consent |
| Access token                   | Opaque `cma_` token; maximum 300 seconds                                        |
| Refresh token                  | Opaque `cmr_` token; 30-day maximum, rotated on refresh                         |
| Code lifetime                  | 120 seconds, one redemption                                                     |
| Lost-response retry            | Same rotated refresh token may return the same response for 30 seconds          |

Discover endpoints and verify that metadata's issuer equals the configured issuer exactly. Require HTTPS and endpoints belonging to the configured server. Pin the expected resource, client ID and redirect. Validate the callback's exact scheme/host/path, state and `iss` before exchanging its code. No ID token is issued or accepted as API authentication. Never parse opaque tokens to infer identity.

Send `resource` on both authorization and token requests, including refresh. Token and revocation requests use `application/x-www-form-urlencoded` and contain `client_id`; no browser cookie or Authorization header. The authorization request includes `response_type=code`, `code_challenge_method=S256`, a 43-character challenge, `state`, `redirect_uri`, `scope`, `resource` and `prompt=consent`.

A successful token response includes `connections_contract: "meetings-v1"`. Read the actual `expires_in`. Keep tokens in secure operating-system storage under a new Connections namespace, bound to the exact issuer. Changing issuer requires fresh sign-in. A stored Clerk token cannot be relabeled or exchanged into this grant.

Rotation uses the provider's atomic compare-and-set. Reusing a rotated token after the retry window permanently revokes its original consent binding, including successor tokens. Independent consent in another workspace remains usable. Concurrent code redemption permits at most one exchange; detected replay revokes the binding, including a raced successful response. Obtain fresh consent after an uncertain code exchange rather than reusing the code.

## Verified identity and API use

Call `GET ORIGIN/api/meetings-identity` with only `Authorization: Bearer ACCESS_TOKEN`. It requires `meetings:read` and returns:

```json
{
  "contract": "meetings-v1",
  "userId": "stable-user-id",
  "organizationId": "company-id",
  "workspaceId": "workspace-id",
  "expiresAt": 1794090000
}
```

`expiresAt` is the access-token expiry in Unix seconds. The desktop must bind saved recordings and sync operations to this independently verified identity and the configured issuer, before capture begins. Retain that identity through finalization, restart and retry.

`GET /api/meetings` and `GET /api/meetings/:id` require `meetings:read`; reads include authorized meetings throughout the bound workspace. `PUT /api/meetings/:externalId` requires `meetings:write`; the server sets the workspace and creator from the grant. Only that creator may update the existing meeting. Revisions, final-state handling and idempotency retain the existing Meetings wire contract. Body fields cannot override ownership. A conflicting workspace header or query is rejected.

Every issuance, refresh and API call rechecks verified user, original live browser session, company membership, workspace grant and archive status. The grant ends when its original session expires or is revoked, even if the nominal refresh lifetime is longer. Role changes use current permissions. Removing a workspace grant or archiving its workspace permanently revokes associated consent; restoring/regranting does not revive it. Company offboarding preserves independent access in other companies.

Uploads recheck access and token expiry inside the persistence transaction after reading the body. Denial writes neither meeting data nor meeting audit events. Dedicated Meetings tokens cannot call console, provider or MCP endpoints. Browser cookies, runtime `oct_` keys, refresh tokens and ID tokens cannot authenticate Meetings API requests.

The server's confidential introspection client is internal only. Its secret is encrypted in the server database; introspection and OAuth client/resource administration are not public routes.

## Staging settings and compatibility gate

Use an isolated HTTPS staging origin, PostgreSQL database, encryption key and auth secret. Set `BETTER_AUTH_URL` and `OOMOL_CONNECT_ORIGIN` to that same origin, with exact `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `OOMOL_CONNECT_ENCRYPTION_KEY`, `SMTP_URL` and `SMTP_FROM`. Run checked PostgreSQL migrations once before starting the release. Keep mail and provider sentinel traffic in synthetic staging accounts. Do not add Clerk human-auth settings or a native client secret.

The coordinated client must support `meetings-v1`; existing Clerk desktop builds are incompatible. The oldest compatible Meetings commit/release is **pending the companion implementation and paired pilot**, and must be recorded before cutover. Local issuer tests do not establish this compatibility gate.

Before retiring legacy desktop access or promoting production, record a real desktop sign-in, refresh, capture and offline retry through staging's production-shaped proxy. Queue in A1, restart and authorize A2/B1: the A1 recording must stay local. Reauthorize its original user in A1 and verify the receiving workspace and creator. Repeat with removed/revoked A1 access and preserve B1. Preserve ambiguous legacy recordings locally with a visible recovery state; map old ownership only from independently verified original mappings.

[Verification record](BETTER_AUTH_VERIFICATION.md) and [import runbook](CLERK_IMPORT.md) track evidence. [Issue #12](https://github.com/Ntrakiyski/connections/issues/12) owns actual Coolify deployment, backup restore and rollback/forward rehearsal. Keep the coordinated PRs unpromoted until that evidence and the desktop release reference exist; production promotion belongs to the operator.

## Independently verified legacy recovery

`GET /api/meetings-identity/legacy` requires the same dedicated `meetings:read` grant. It returns `contract`, `issuer`, `userId`, `organizationId`, `workspaceId` and `mapping`. `mapping` is null unless one completed `identity_import_runs` ledger with `verification='verified'` contains the original Clerk user, company and workspace mappings matching all three current grant IDs. A proven mapping contains `sourceInstance`, `legacyOrganizationId` and `legacyUserId`. Pending import, sibling workspace, another company or another user cannot recover those records.

The desktop verifies the response's issuer and all stable identity IDs before applying a local transaction. Only matching original Clerk organization/user snapshots may be backfilled; originals remain stored. Pre-ownership recordings without those snapshots stay local. Recovery preserves queue conflicts rather than overwriting newer work, and verified ownership cannot be changed afterward. This endpoint does not infer ownership from an email, workspace name, active browser company or newly selected workspace.

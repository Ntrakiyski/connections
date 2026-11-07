# Authentication contract

Connections serves Better Auth under `/api/identity`. The account handler runs before workspace middleware. Public organization-plugin mutations are fenced off: application services own company invitations and workspace grants.

| Surface                                                      | Accepted principal                                             | Workspace intent                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Console shell, health, API documentation, provider callback  | Public                                                         | Callback authorization comes from single-use stored consent       |
| `/api/identity/*`, `/api/account`, `/api/auth/logout`        | Verified human session where required by the account operation | Personal account operations have no workspace selector            |
| Workspace console APIs                                       | Verified human session cookie                                  | Required `X-Workspace-Id`; conflicting URL selector rejected      |
| `/v1/*`, `/mcp`, `/mcp/*`                                    | Opaque `oct_` runtime key                                      | Stored workspace; a supplied selector cannot change it            |
| `/api/meetings`, `/api/meetings/*`, `/api/meetings-identity` | Dedicated Meetings OAuth grant                                 | Immutable consent workspace; see [meetings-v1](MEETINGS_OAUTH.md) |

Workspace access requires both live parent-company membership and an independent workspace grant. Company directory roles do not grant provider-resource access. An archive blocks resource access; a current workspace admin can request restoration. Human and runtime credentials cannot be combined in one protected request. Cookie-authenticated mutations require an exact trusted `Origin`, including account sign-out. Protected API responses use `private, no-store` and edge `no-store`.

## Server configuration

Both entry points require `BETTER_AUTH_SECRET` (at least 32 characters), `BETTER_AUTH_URL`, `SMTP_URL`, and `SMTP_FROM`. Hosted origins must be exact HTTPS origins. `OOMOL_CONNECT_ORIGIN`, when supplied, must match the auth origin. Additional `BETTER_AUTH_TRUSTED_ORIGINS` values are comma-separated exact origins, never patterns. Set SMTP credentials and authentication secrets only in server secrets.

Hosted Node requires a PostgreSQL `DATABASE_URL` and `OOMOL_CONNECT_ENCRYPTION_KEY`. Worker requires native D1, the encryption key, and `nodejs_compat`; SMTP uses Nodemailer's Node-compatible sockets. Apply the checked-in migrations before starting a hosted service. Better Auth does not perform startup schema migrations.

The explicit development bypass requires `NODE_ENV=development`, a loopback `HOST`, and `CONNECTIONS_DEV_AUTH_BYPASS=true`. A Worker bypass also requires a loopback request URL. An unset authentication secret never enables bypass. For authenticated local development, use an HTTP loopback auth origin and a local SMTP test receiver; configure the Vite origin explicitly if it differs from the server origin.

## Verification

`principal-auth.test.ts` exercises real Better Auth cookies through Hono on SQLite, D1 and PostgreSQL. Set `CONNECTIONS_TEST_POSTGRES_URL` to include the PostgreSQL cases. `auth-startup.test.ts` starts the actual Node entry point with each required setting absent and verifies failure before data initialization. `cloudflare-auth.test.ts` exercises the Worker entry point, D1 sessions, secure cookies and startup rejection.

The recorded [native Workerd smoke checks](verification/workerd-auth.json) used local D1 with the shipped migrations and a real local SMTP receiver. They cover verification, recovery, rejected foreign-origin logout, password-reset session revocation and server-side logout. These local checks do not establish the staging cutover, desktop pilot or production promotion gates in #11–#12.

## Company governance

Company directory and invitation operations use verified sessions without a workspace selector. `/api/companies` lists the account's companies and creates a company with its initial owner/admin. `/api/companies/:organizationId` supplies the company administrator's directory, workspace-grant and audit view. Company/workspace IDs in route parameters define scope; a body field never changes it.

Company owners/admins provision workspaces and govern people. Existing workspace admins can govern their workspace grants. Both paths check live parent-company membership and verified identity. A company role grants no provider-resource access; a resource request still needs its independent workspace grant.

Invitation recipes retain their original workspace IDs after archival or purge. Acceptance requires the verified recipient email, unexpired pending invitation, current company-admin inviter and active matching workspaces. Memberships and grants commit in one PostgreSQL transaction or SQLite/D1 batch. A receipt makes concurrent acceptance and lost-response retries idempotent; replay never recreates subsequently removed access. Failed email delivery leaves the invitation available for an authorized resend.

Offboarding revokes runtime hashes, removes the subject's credentials and pending provider consent in the selected scope, and preserves company/workspace audit. Final-owner and final-workspace-admin guards share the mutation's atomic write unit. [Native Workerd governance evidence](verification/workerd-governance.json) records the paired-account A/B isolation and retry checks; staging and desktop release gates remain pending.

## Meetings delegation

The pinned OAuth provider issues a public native client’s S256 PKCE grants with exact issuer/resource/client checks. The [versioned contract](MEETINGS_OAUTH.md) defines discovery, consent, minimal identity, rotation/retry, original-session revocation and desktop compatibility gates. `meetings-oauth.test.ts` exercises the real issuer and meeting persistence across SQLite, D1 contract and PostgreSQL. These API and local browser checks do not replace the paired native desktop/Coolify pilot.

# Better Auth migration verification

This is a working evidence ledger for tracker [#2](https://github.com/Ntrakiyski/connections/issues/2). An unchecked gate remains incomplete; implementation or passing isolated tests alone does not close a release gate.

## Reviewed and merged

- [x] #3: Company/workspace schema, reviewed in merged PR #13.
- [x] #4: Two-company fixture and credential permission fixes, reviewed in merged PR #13.
- Merge commit: `0dc45245def2e35b9434942130945632faf95b93`.
- Merged validation: lint/format/type checks, 518 tests including PostgreSQL, and web build.

## Current branch evidence

- Node session wiring, personal account endpoint allowlist, live company/workspace resolution, runtime principal separation, explicit request origins, and startup settings are implemented on the migration branch.
- SQLite Hono/Better Auth integration covers verification, recovery, logout, A1/B1 selection, company removal, machine scope conflicts, and rejected mutations.
- #5 authentication checks now cover SQLite, D1 and PostgreSQL. Production startup checks exercise the actual Node and Worker entry points. Wrangler dry-run bundling passed. Native local Workerd/D1 plus real local SMTP passed 12 checks: verification, recovery, secure session behavior, wrong-origin rejection, password-reset revocation and server logout. The issue remains open until the coordinated change is merged and reviewed.
- Runtime token stores now enforce scope consistently and retain individual token revocation records. The PostgreSQL global store preserves the workspace supplied at creation.
- Authentication foundation validation: `npm run fix-check` and all **539 tests** passed, including PostgreSQL. Native Workerd evidence is recorded in `verification/workerd-auth.json`.
- #6 company/workspace provisioning, direct grants, role changes, final-owner/admin checks, invitation delivery/acceptance/retries, scoped offboarding and cookie-authenticated HTTP routes are implemented. All 584 tests pass, including PostgreSQL; lint/format/type checks pass. Native Workerd/D1 plus real SMTP passed 21 checks and six governance invariants, recorded in `verification/workerd-governance.json`. The ticket remains open for coordinated PR review.
- #7 checkpoint: mapped-workspace credential writes recheck live company membership, workspace grants, archive status, account ownership and provider enablement in the commit transaction. Delayed API-key, custom-credential and OAuth validation tests cover downgrade, grant removal, company offboarding, archive and provider disablement across all three adapters.
- Better Auth provider callbacks redeem opaque state atomically from stored user/workspace facts. HTTP integration covers concurrent callbacks, replay, alternate browser selectors, expired/future consent, provider disablement, archive, company removal and a grant disappearing during token exchange. Completion messages carry the original state, user and workspace for the console migration. Legacy scoped redemption is atomic too.
- Checkpoint validation: `npm run fix-check` passed and **653 tests** passed in 74 files, with PostgreSQL enabled. #7 remains open: the complete MCP/REST downstream account and persistence matrix, archive/restore revocation checks, and coordinated browser evidence are still pending. This checkpoint does not establish the staging cutover or desktop release gates.
- #7 runtime evidence now exercises the real MCP client and REST routes with alternate workspace headers, query parameters, request bodies and tool arguments. Same-label downstream sentinel accounts and persisted run identity remain bound to the stored key. HTTP tests cover live downgrade, A offboarding with B preservation, archive/restore with retained revocation, and alternating cookie reads/writes with private browser/edge cache headers across SQLite, D1 and PostgreSQL.
- PostgreSQL now preserves safe account identity and the actual caller in persisted run metadata. PostgreSQL fixtures include the shipped workspace-safety migration so provider execution exercises the production table contract. Validation: `npm run fix-check` and all **668 tests** in 74 files passed, with PostgreSQL enabled. The rendered two-tab browser check is shared with #8 and remains pending.
- Other tickets below remain pending implementation and/or their full acceptance evidence.

## Console browser verification

Console checkpoint validation: `npm run fix-check`, `npm run build:web`, and all **671 tests in 75 files**, including PostgreSQL, passed.

The #8 console uses the pinned Better Auth client without Clerk UI or a public Clerk key. URL company/workspace selection creates a mounted user/company/workspace scope with captured request headers, cancellation and one-time consent matching. Account/company management, explicit grants, invitations, provider enablement and archive/restore use Hono services and current server roles.

Local browser verification used actual Hono, Better Auth and encrypted SQLite with a synthetic Sentinel provider at `http://localhost:8890`, Chrome/Playwright, desktop 1440×1000 and mobile 390×844. Browser plugin was unavailable. Page title, meaningful content, screenshots, layout width and application page errors were checked. This is local evidence; it does not satisfy the Coolify staging or Meetings release gates.

- A1 and B1 opened in separate tabs with the same session. Both saved an identically labeled connection to independent accounts. Delaying an A1 mutation response while selecting B1 preserved A1 persistence and B1 rendering. Delayed A1 reads after switching to B1 did not replace B1 data; bookmarked URLs survived reload. Unrequested/cross-user/workspace OAuth messages did not refresh the tab.
- Runtime calls with freshly issued opaque tokens observed the selected synthetic account and original workspace in both A1 and B1. The tokens were then revoked.
- Invitations were sent through company administration and accepted by newly registered, verified users. Directory-only membership revealed no workspace resources. A workspace member saw only their own connection, received 403 for provider administration, and lost bookmarked resource access after company removal. Server sign-out invalidated another tab on focus refresh.
- UI provisioning created sibling A2 with its initial admin and selected it through the directory. Profile update, other-session revocation, password recovery/reset, exact-name archive confirmation and restoration completed. No application page errors were observed.
- Following the emailed reset URL exposed a missing GET callback in the account endpoint allowlist. The callback is now supported, with integration checks across adapters for the delivered redirect, password-reset revocation and rejected untrusted callback origins. Origin/CSRF checks are explicitly enabled so Better Auth's test defaults cannot bypass this negative test.

## [#5: Serve Better Auth sessions from Hono and authenticate each principal explicitly](https://github.com/Ntrakiyski/connections/issues/5)

- [x] Real cookie integration tests cover sign-in, verified email/recovery, session resolution, server-side logout and a rejected wrong-origin mutation.
- [x] The same account can operate in A1 and B1 in different browser tabs. A supplied workspace ID never grants membership, and unrecognized or conflicting credentials fail per the route matrix.
- [x] A direct organization mutation through an unapproved auth endpoint cannot bypass the application service. Production startup tests cover absent required settings in supported entry points.

## [#6: Implement organization invitations, workspace grants and scoped offboarding](https://github.com/Ntrakiyski/connections/issues/6)

- [x] An existing member of company A can join B with the same verified account and later receive A2 access without another company invitation.
- [x] Wrong-recipient, expired, replayed and stale-workspace invitations cannot create extra grants. A retry after interrupted acceptance completes once. Concurrent demotions cannot remove the final owner/admin.
- [x] Removing someone from A1 leaves A2 and B intact. Removing their organization-A membership removes access to all A workspaces and preserves B. Demotion is reflected in the next authorized operation.

## [#7: Enforce live workspace access across MCP, REST and provider OAuth](https://github.com/Ntrakiyski/connections/issues/7)

- [x] An authorized existing oct\_ token still works for its original workspace. An alternate workspace supplied by header, URL, body or tool argument cannot change that workspace.
- [x] The next request observes a role downgrade or removal. Removing a user from A preserves independent B access. Archive blocks access and restore does not resurrect revoked keys.
- [x] Replayed callbacks, expired consent and callbacks completed after access removal or archival cannot create a credential. A denied or competing operation cannot alter an unauthorized account.
- [x] Switching between two authorized workspaces in one browser does not return the other workspace's cached response. Tests verify the downstream account and persisted side effects.

## [#8: Replace Clerk UI with Better Auth sign-in and tab-scoped workspace administration](https://github.com/Ntrakiyski/connections/issues/8)

- [x] A browser test opens A1 and B1 as the same user, changes data in both, switches contexts during delayed requests and verifies the recipient workspace and rendered results.
- [x] A company directory member with no workspace grant sees no workspace data. An invited workspace member can use their permitted accounts while admin-only operations are denied by the backend.
- [x] End-to-end tests cover invite acceptance, switching, session invalidation and reload on a bookmarked workspace URL. The production console builds without Clerk's UI package or public Clerk key.

## [#9: Build an idempotent Clerk identity and workspace importer](https://github.com/Ntrakiyski/connections/issues/9)

- [x] Two runs over the same sanitized staging snapshot produce identical mappings and role counts without duplicate grants. Dry run makes zero writes.
- [x] Duplicate identities, ambiguous ownership, unmapped active records and zero-admin workspaces block cutover with actionable, sanitized diagnostics.
- [x] A verified active token still resolves to the correct user and workspace. A revoked token stays denied. Synthetic encrypted credentials decrypt and route to the correct provider account.
- [x] Logs and reports contain counts and exception identifiers suitable for operators, with no raw credentials, tokens, password hashes or exported authentication factors.

Importer checkpoint validation: `npm run fix-check`, `npm run build:web`, and all **700 tests in 77 files**, including PostgreSQL, passed. The importer/exporter contribute 29 checks across SQLite, D1 contract and disposable PostgreSQL schemas. Source export uses real Clerk SDK pagination against a synthetic Backend API transport; it never exports passwords, MFA factors or invitation links.

The synthetic staging snapshot includes independent A1/B1 grants, same-label encrypted sentinel accounts, active and revoked original runtime tokens, meetings, and a real local transit file. Read-only previews preserve every observed row and file; repeated apply retains identical mappings/roles without duplicates. Recovery runs through actual Hono/Better Auth emailed password-reset and sign-in while retaining original user and runtime workspace IDs. Collision, stale-plan, inventory-race, interrupted-commit and final-verification tests fail closed. The ledger keeps identity commit separate from verified preservation; retries resume the check without replaying grants. The [import runbook](CLERK_IMPORT.md) defines operator inputs, recovery, invitation reissue and stop conditions.

This is local synthetic evidence. #9 remains open for coordinated PR review and merge. Actual Coolify staging export/import counts, delta reconciliation, paired desktop compatibility and restored-backup rehearsal remain #12 gates.

## [#10: Issue workspace-bound OAuth grants for the Meetings desktop client](https://github.com/Ntrakiyski/connections/issues/10)

- [x] A signed native flow can sign in, refresh and upload a meeting using its authorized workspace. A consent in A1 cannot select A2 or B1 through a request parameter or a changed browser session.
- [x] Expired and revoked tokens, ID tokens, machine credentials, wrong issuer/client/resource, missing scopes, and removed memberships are rejected without reads or writes. Exercise the real issuer in integration tests.
- [ ] Publish the versioned contract, staging configuration and release gate for the desktop client. Validate one recording and a queued retry end to end before retiring legacy desktop access.

OAuth server checkpoint validation: `npm ci`, `npm run fix-check`, `npm run build:web`, and all **733 tests in 78 files**, with disposable PostgreSQL enabled, passed. No tests were skipped in this full run.

Server checkpoint: the real pinned issuer passes **33 integration checks** across SQLite, D1 contract and disposable PostgreSQL. Coverage includes exact issuer/resource discovery, signed consent, immutable selection, PKCE failure, atomic concurrent code redemption, replay denial, rotated-response retry, stale refresh replay isolated to its original binding, original-session expiry, live roles, workspace/company removal, archive/restore, public-client/resource restrictions, mixed credentials, malformed consent, expired codes/consent and decline. Workspace-wide reads and creator-bound writes use actual issued tokens. A stream paused after authentication and released after grant removal receives 403 without a meeting or meeting audit write on all adapters.

PostgreSQL serializes saves and binding revocation using the same company/workspace lock order as governance. SQLite checks access without awaiting inside the write transaction; D1 checks it in the atomic batch. Concurrent restarts seed clients/resources idempotently. The internal resource-server introspection credential is encrypted and not exposed through public OAuth administration routes.

[Versioned native configuration and staging/release gate](MEETINGS_OAUTH.md) are published. [Fresh browser desktop/mobile evidence](verification/meetings-oauth-browser.json) confirms actual console sign-in, workspace selection, consent/decline, code exchange and original A1 identity with no application page errors. The native custom-scheme handler is not installed on this browser host; repeating in a reused browser after unhandled custom-scheme navigation stalled. Fresh browser runs passed, but this does not establish the actual native handler or desktop recording/offline queue gate. The oldest compatible desktop release and actual paired staging pilot remain pending under #11–#12; #10 stays open. A clean-install audit reports 28 existing dependency findings (including dev tooling); neither pinned Better Auth package has a reported advisory. Release hardening and retirement of legacy dependencies remain part of the #12 review.

## [#11: Coordinate the Meetings desktop release for workspace-bound Connections OAuth](https://github.com/Ntrakiyski/connections/issues/11)

- [ ] A recording queued in A1 stays queued while the user is in sibling A2 or client B1. It uploads under A1 after the original user reauthorizes. Simulate a restart and retry and verify the receiving workspace.
- [ ] Removed membership or a revoked grant prevents refresh/upload for that workspace. Old keychain tokens cannot become grants for the new issuer. Checked migrations are idempotent and preserve ownership of verified old rows.
- [ ] Link the desktop change and its test results back to this issue. Complete a paired staging test with one offline recording before the server cutover gate is marked complete.

## [#12: Rehearse the Better Auth cutover and rollback on Coolify](https://github.com/Ntrakiyski/connections/issues/12)

- [ ] npm ci, npm run fix-check, npm test and npm run build:web pass. The production-shaped staging app runs without Clerk human-auth credentials. Unsupported entry points fail closed.
- [ ] A1/A2/B1 isolation, concurrent browser tabs, live role changes, archive/restore, stale invites and consent, and a desktop recording queued offline all pass. Include negative tests and provider-side sentinel checks.
- [ ] Restore the backup in staging and rehearse rollback or forward recovery. Historical removals and revoked tokens stay denied. Record the operator stop conditions.
- [ ] The release record includes migration counts and exceptions, supported deployment modes, remaining intentional Clerk references, the paired desktop compatibility result, and a link to the current runbook.

## Promotion boundary

Issue #12 requires a staging cutover and rollback rehearsal with evidence before operator-owned production promotion. Do not infer staging or desktop pilot success from unit tests, and do not deploy this incomplete branch to production.

### Desktop legacy recovery review (2026-11-07)

The companion Meetings implementation adds issuer/company/workspace/user ownership, pre-migration preservation and independently verified local legacy recovery. The server legacy proof endpoint returns only mappings from a verified import ledger matching the live grant's original user, company and workspace. Pending imports and sibling/client workspaces return no proof. Offboarding is rejected before provider introspection and again before accepting the verified identity.

Validation at this update: `npm run fix-check` passed; 736 tests in 78 files passed with PostgreSQL enabled and no skips. The three new real-issuer tests cover legacy proof across SQLite, D1 and PostgreSQL. The companion's 18 portable production Rust tests and five frontend recovery tests pass. Full native macOS CI and paired staging/OS-keychain/capture evidence remain pending; #10/#11/#12 are not complete.

### Isolated staging preparation (2026-11-07)

`docker-compose.staging.yml` uses separate connector/database volumes, a fresh PostgreSQL 16 schema, a private captured-mail service and independent runtime-only staging secrets. It contains no Clerk human-auth settings. The PostgreSQL initialization uses the existing baseline and unchanged checked migrations before the server can become healthy; this bootstrap is for fresh staging databases only.

Validation: Compose configuration validates with synthetic settings. The exact baseline and ordered checked scripts ran successfully on a fresh isolated PostgreSQL 16 cluster; the readiness marker was true. This is preparation evidence, not a Coolify deployment or rollback rehearsal. The actual reverse-proxy, provider/mail pilot, paired desktop and restore gates remain open.

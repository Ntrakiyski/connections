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
- [ ] Switching between two authorized workspaces in one browser does not return the other workspace's cached response. Tests verify the downstream account and persisted side effects.

## [#8: Replace Clerk UI with Better Auth sign-in and tab-scoped workspace administration](https://github.com/Ntrakiyski/connections/issues/8)

- [ ] A browser test opens A1 and B1 as the same user, changes data in both, switches contexts during delayed requests and verifies the recipient workspace and rendered results.
- [ ] A company directory member with no workspace grant sees no workspace data. An invited workspace member can use their permitted accounts while admin-only operations are denied by the backend.
- [ ] End-to-end tests cover invite acceptance, switching, session invalidation and reload on a bookmarked workspace URL. The production console builds without Clerk's UI package or public Clerk key.

## [#9: Build an idempotent Clerk identity and workspace importer](https://github.com/Ntrakiyski/connections/issues/9)

- [ ] Two runs over the same sanitized staging snapshot produce identical mappings and role counts without duplicate grants. Dry run makes zero writes.
- [ ] Duplicate identities, ambiguous ownership, unmapped active records and zero-admin workspaces block cutover with actionable, sanitized diagnostics.
- [ ] A verified active token still resolves to the correct user and workspace. A revoked token stays denied. Synthetic encrypted credentials decrypt and route to the correct provider account.
- [ ] Logs and reports contain counts and exception identifiers suitable for operators, with no raw credentials, tokens, password hashes or exported authentication factors.

## [#10: Issue workspace-bound OAuth grants for the Meetings desktop client](https://github.com/Ntrakiyski/connections/issues/10)

- [ ] A signed native flow can sign in, refresh and upload a meeting using its authorized workspace. A consent in A1 cannot select A2 or B1 through a request parameter or a changed browser session.
- [ ] Expired and revoked tokens, ID tokens, machine credentials, wrong issuer/client/resource, missing scopes, and removed memberships are rejected without reads or writes. Exercise the real issuer in integration tests.
- [ ] Publish the versioned contract, staging configuration and release gate for the desktop client. Validate one recording and a queued retry end to end before retiring legacy desktop access.

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

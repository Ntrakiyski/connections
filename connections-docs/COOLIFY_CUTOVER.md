# Connections migration rehearsal and cutover

Tracks [#12](https://github.com/Ntrakiyski/connections/issues/12), with [server PR #14](https://github.com/Ntrakiyski/connections/pull/14) and [desktop PR #1](https://github.com/Ntrakiyski/meetings/pull/1). This runbook describes the required rehearsal. The staging deployment, paired desktop pilot and rollback evidence are still pending. Production promotion remains with the operator.

## Staging resources and deployment guard

The isolated application is [connections-migration-staging](https://worfklow.org/project/qrbs3dll2ujkbo2ugwwfswxb/environment/ut8fxh22aiutsl6axgnetyjv/application/qftlcbelti2xhxoceyjjfcex), UUID `qftlcbelti2xhxoceyjjfcex`, in the `connections-migration` project and `staging` environment. Production is a different application, UUID `m14hs9i7dspgix9ul8gx7lgp`, following `main` with auto-deploy enabled.

Before any staging deployment, inspect its authoritative application details and require:

- Compose file `/docker-compose.staging.yml`.
- Connector service domain `https://connections-migration.159.69.35.245.sslip.io`.
- Auto-deploy disabled, and the reviewed feature-branch commit recorded.
- Four staging-only environment variables: `CONNECTIONS_STAGING_ORIGIN`, `CONNECTIONS_STAGING_AUTH_SECRET`, `CONNECTIONS_STAGING_ENCRYPTION_KEY`, `CONNECTIONS_STAGING_DATABASE_PASSWORD`. Secrets remain runtime-only and outside git.
- Separate connector and PostgreSQL volumes. No production database URL, encryption key, transit-file directory, provider account or Clerk human-auth credentials.

The current connector ignores the Compose-path, service-domain and auto-deploy fields on application create/update. Those fields require a dashboard edit followed by read-back verification. A created application or successful API response alone does not prove that configuration was saved. Do not deploy the default `/docker-compose.yaml` setting.

`docker/staging-schema.sql` initializes a **fresh staging database** once with the existing baseline and checked application migrations. Its readiness marker prevents application startup before initialization succeeds. It is not an upgrade runner or a production migration command. A restored database uses its original migration ledger and reviewed migration sequence. Record the exact server commit and applied script hashes before a rehearsal.

## Freeze, snapshot and import

Use synthetic source identities and provider accounts throughout the rehearsal. Follow [CLERK_IMPORT.md](CLERK_IMPORT.md) for export, reviewed manifests, dry runs, idempotent apply, interrupted retries and independently verified ownership. Keep emails, recordings, account credentials and tokens out of the evidence ledger.

1. Stop application writers, desktop sync, MCP clients and transit-file cleanup. Freeze source identity, company membership and invitations externally. The importer's `--maintenance` flag acknowledges that freeze; it does not enforce it.
2. Take a consistent custom-format PostgreSQL dump with `pg_dump --format=custom` using the staging database connection, and a consistent archive of its transit-file directory. Record checksums, original encryption-key reference, server commit, schema versions and capture time. Store both under restricted operator storage outside the repository.
3. Restore into a separate empty rehearsal database and separate file directory. Use `pg_restore --exit-on-error` with the reviewed target connection. Do not restore over the running production database or share writable file directories between original and restored applications.
4. Apply checked expansion migrations once, run two identical importer dry runs, review every exception and approve the exact plan fingerprint. Apply under the freeze; repeat the identical apply to verify `already_applied` and unchanged resource/file fingerprints.
5. Require a verified import ledger and zero unexplained unmapped production workspaces/grants. Pending, uncertain or blocked imports stop the switch. Original IDs, encrypted bytes, token hashes and revocation timestamps must agree with the snapshot.

Keep an untouched snapshot copy for comparison. Record snapshot/import counts and hashed exceptions in the [verification ledger](BETTER_AUTH_VERIFICATION.md); never record raw secret material.

## Live staging verification

Run the tests through the actual HTTPS reverse proxy and application, with PostgreSQL persistence:

- Verify signup, email verification and password recovery through the private staging SMTP capture. A captured email is evidence only after its delivered link completes the real Hono flow. SMTP capture is confined to the staging network and sends no production mail.
- Exercise A1/A2/B1 browser tabs, bookmarked URLs, invitation expiry/acceptance, current company roles, explicit workspace grants, archive/restore and stale provider consent. Confirm negative requests reach the server and write no forbidden resource or audit row.
- Connect real MCP clients with original workspace/member tokens. Create synthetic provider-side sentinels with the same connection label but distinguishable account IDs. Execute permitted reads and verify the actual receiving account. Conflicting selectors, another workspace's labels and human/desktop credentials on runtime endpoints must fail.
- Use the native pilot artifact and the [Meetings protocol](MEETINGS_OAUTH.md). Sign in and refresh, capture in A1, disconnect before finalization, save, restart, authorize A2/B1 and verify that the recording stays queued. Reauthorize the original A1 user and verify receiving workspace, creator, bytes and revision. Repeat with revoked/removed A1 access and verify independent B1 access remains usable.
- Exercise independently verified Clerk-era recording recovery. Sibling/client/other-user records and unowned archives stay local. Changing issuer requires fresh sign-in; the old keychain entry cannot become a new grant.

Record native build/commit, server commit, staging URL, OS, native callback/keychain results, sanitized recording identifier and receiving identity. The oldest compatible client is established only by this passing paired test, not by a successful build.

## Restore and recovery boundary

Rehearse both sides of the security-write boundary before proposing production promotion:

**Before new security writes or additional workspaces:** freeze all writers again; restore the consistent snapshot into the isolated recovery target; verify unchanged ownership, encrypted bytes, revoked token denial and historical removals. Only then evaluate switching the staged application back to its snapshot-compatible server/client. An old desktop release cannot use the new OAuth issuer, and rollback does not turn opaque Meetings tokens into Clerk credentials.

**After new security writes or additional workspaces:** do not replace the current state with an older source export or blindly restore the snapshot. Inventory the post-snapshot delta: offboarding, removed workspace grants, revoked runtime/desktop tokens and sessions, disconnected accounts, invitation changes, archive/restore and newly created workspaces. Preserve the current security state and either roll forward or reconcile that complete delta into a separately restored target under the freeze. Use current governance services; importer replay must not recreate access from the source snapshot. Missing or uncertain deltas stop recovery.

Verify on the recovery target that previously removed members, archived workspaces, revoked tokens and stale consents remain denied while independent company access still works. Compare workspace membership, resource ownership and file fingerprints before reopening writers. Record the chosen recovery direction, mutations, negative results and exact commits. A successful `pg_restore` alone is not a successful rollback rehearsal.

## Retirement and operator promotion

Retire legacy human-auth settings only after the paired compatibility and recovery gates pass. Rewrite the production Compose/configuration and operating instructions around Better Auth, remove Clerk human session/webhook paths and unused dependencies, and review remaining intentional references. Current pending references include production Compose/Docker public-key arguments, legacy server auth/webhook modules, their Cloudflare configuration and old README/operations settings. `@clerk/backend` is also used by the server-only source exporter; preserve that import capability until the final reviewed export is complete. Provider catalog integrations are independent and must remain functional.

Run `npm ci`, `npm run fix-check`, the complete tests with disposable PostgreSQL enabled, and `npm run build:web` on the final retirement commit. Evaluate the recorded dependency audit findings. Repeat affected staging checks when the final code or configuration changes.

Provide the operator with the complete release record, migration counts/exceptions, supported deployment modes, intentional references, paired client version, backup references and recovery stop conditions. Keep #10/#11/#12 and tracker #2 open until that evidence is reviewed after coordinated merge. Production `main` auto-deploys; merging the server PR is a production action, not a way to start the staging rehearsal.

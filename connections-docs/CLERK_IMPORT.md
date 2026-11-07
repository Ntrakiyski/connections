# Clerk identity import

This runbook covers issue [#9](https://github.com/Ntrakiyski/connections/issues/9). The importer preserves original Clerk user IDs, existing workspace IDs, independent workspace roles, encrypted resources, token hashes and revocation records. It establishes Better Auth users and company memberships before binding each legacy workspace in one transaction. It does not promote a deployment or satisfy the paired Meetings and Coolify rehearsal gates in #10–#12.

## Prepare a frozen staging copy

Back up PostgreSQL and the original transit-file directory together. Keep the original `OOMOL_CONNECT_ENCRYPTION_KEY`. Restore into an isolated staging database and retain a separate copy for rollback comparison. Apply the checked-in PostgreSQL expansion, governance and identity-import migrations once through the migration ledger before invoking the script. The CLI never initializes or migrates its target database. PostgreSQL is the hosted contract; SQLite uses `sqlite-migrations/0009_organization_identity.sql`, `0010_identity_governance.sql` and `0011_identity_import.sql` through its migration runner. D1 uses the same schema and importer service contract, but this Node CLI has no remote D1 apply command.

Freeze Clerk identity, membership and invitation mutations while exporting. Keep the staging application, agents, desktop sync and file cleanup stopped during inventory, apply and final verification. `--maintenance` acknowledges this externally enforced freeze; the importer does not stop writers. PostgreSQL takes table locks and rechecks the complete inventory in its commit transaction. SQLite/D1 use the corresponding atomic transaction/batch guards. A changed reviewed inventory aborts application rather than adopting new records.

Export identity facts from the actual instance selected by server-only `CLERK_SECRET_KEY`:

```sh
node scripts/clerk-identity-import.ts export --output /secure/staging/clerk-snapshot.json
```

The new snapshot file is created exclusively with mode 0600. It contains emails and stable source IDs, sign-in method names and membership/invitation facts. It excludes password hashes, MFA factors, OAuth tokens and invitation links. Keep it in restricted operator storage, outside git. Never use a production snapshot as a checked-in fixture. The sanitized test snapshot uses synthetic users, encrypted sentinel accounts and an actual local transit file.

Create a version-1 manifest with the snapshot's exact `sourceInstance`. Designate each existing initial workspace, a verified company member as owner, and a verified existing workspace admin. Directory role mappings do not alter workspace roles:

```json
{
  "version": 1,
  "sourceInstance": "ins_synthetic",
  "companies": [
    {
      "sourceOrganizationId": "org_alpha",
      "workspaceId": "A1",
      "ownerUserId": "user_operator",
      "workspaceAdminId": "user_operator",
      "slug": "alpha"
    }
  ],
  "directoryRoles": { "org:admin": "admin", "org:member": "member" },
  "localCompatibilityWorkspaceIds": []
}
```

Only the explicit local `default` workspace can be exempted. A hosted staging rehearsal must account for every legacy production workspace and grant. The manifest is reviewed operator input; organization creation metadata and email similarity do not determine ownership.

## Review and apply

Set `DATABASE_URL` to the restored staging database and `OOMOL_CONNECT_ENCRYPTION_KEY` to its original encryption key. Pass the existing transit-file root explicitly, including when it is empty:

```sh
node scripts/clerk-identity-import.ts dry-run \
  --snapshot /secure/staging/clerk-snapshot.json \
  --manifest /secure/staging/import-manifest.json \
  --files-root /secure/staging/transit-files
```

For SQLite, also pass `--sqlite /secure/staging/runtime.sqlite`; dry run opens it read-only and refuses a missing database. Dry run writes no database rows or files. Compare two runs: mappings, role counts and the plan fingerprint must agree while the source, target and files are frozen. Changing export collection order or capture time alone does not change the source fingerprint, unless an invitation's pending/expired classification changes.

Resolve every blocking exception before apply. Diagnostics use exception codes, hashed entity identifiers and concrete remedies. Duplicate verified aliases/primary emails, existing target identity/company collisions, unknown mappings, stale grants, unmapped active owners, missing workspace admins and invalid file ownership stop cutover. A wrong original encryption key or corrupt credential also blocks it. Historical unavailable owners remain stable historical IDs and appear as review exceptions; they cannot authorize new activity.

Apply only the reviewed plan fingerprint:

```sh
node scripts/clerk-identity-import.ts apply \
  --snapshot /secure/staging/clerk-snapshot.json \
  --manifest /secure/staging/import-manifest.json \
  --files-root /secure/staging/transit-files \
  --maintenance --plan REVIEWED_SHA256_PLAN_FINGERPRINT
```

Reports contain counts, fingerprints, original stable-ID mappings and sanitized exceptions. They contain no emails, credential contents, token strings, password hashes, transcripts or file contents. Keep reports with the release evidence. SQL parameters and raw SDK/database errors are not printed. Any blocked, uncertain or pending result exits unsuccessfully.

## Identity recovery and invitations

Passwords and external sign-in credentials are not transferred. Imported users establish a new password through the Better Auth emailed recovery flow using their original primary email and stable user ID. Verified source email remains verified; an unverified source email never creates verified membership. The original runtime token continues to select that original user's workspace after recovery. Email delivery must pass the staging rehearsal before human sign-in switches.

MFA-enabled and disabled/banned/locked accounts block import until a reviewed recovery or offboarding plan is reconciled in the source and a new frozen export is reviewed. Do not disable MFA merely to make import pass. Inventory sign-in methods to coordinate changes for SAML, external accounts, passkeys, phone and wallet users; source factors are never copied or silently treated as Better Auth credentials.

Outstanding invitations become server-only recovery records, not active Better Auth invitations or grants. A current company administrator reviews recipient, role, expiry and workspace intent, then reissues through the Connections invitation service. Old links and acceptances do not grant access. The import expires all target human sessions, account verifications and transient provider OAuth states; users obtain fresh sessions and restart consent.

## Completion and interrupted retries

`applied` means identity writes committed and resource/file preservation was verified. A second apply of the same source and manifest returns `already_applied`, with identical mappings and role counts and no duplicate grants. It never reconstructs source access after current offboarding, nor restores revoked tokens or disconnected accounts. Changed completed source/manifest input requires explicit delta reconciliation through current governance services.

The server-only ledger separates `verification='pending'` from `verification='verified'`. Its stored report remains `verification_pending` until the final guarded verification commits. `apply_uncertain` means acknowledgement was lost or a guarded commit failed; inspect the ledger and rerun the exact reviewed apply under the freeze. Absence of a ledger row permits a fresh guarded attempt. A pending row resumes preservation verification only. `verification_pending` never counts as completed import or permits cutover. Resource/file drift after identity commit requires reconciliation with the backup; do not delete the ledger to force a retry.

After success, compare the preserved fingerprints and counts, verify active and revoked synthetic tokens, decrypt and execute both same-label sentinel accounts, and confirm the original meeting/file ownership. Exercise imported-user recovery through Hono. Record zero unmapped production references before tightening schema constraints. Separate application-level sign-in and desktop compatibility checks remain required by #12.

Before new identity/security writes or extra workspaces exist, the restored backup is the rehearsal recovery boundary. After that boundary, reconcile subsequent removals, revoked keys and grants or roll forward; replaying an older source or dropping the expansion tables cannot safely recover access state. The full Coolify switch, delta reconciliation and rollback rehearsal remain issue #12.

## Local verification

```sh
npm run fix-check
CONNECTIONS_TEST_POSTGRES_URL=postgresql://... npm test -- \
  src/server/migration/clerk-identity-importer.test.ts \
  src/server/migration/clerk-snapshot-export.test.ts
```

The fixtures run SQLite, D1 contract and disposable PostgreSQL schemas. They verify repeatability, no-write previews, collisions, original resource/token/file ownership, recovery through real Hono/Better Auth, concurrent inventory changes, interrupted commits and resumed final verification. This synthetic local evidence does not substitute for the Coolify production-shaped staging rehearsal.

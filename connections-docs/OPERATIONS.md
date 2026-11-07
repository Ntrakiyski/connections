# Operations guide

## Reader and purpose

This guide is for the person operating a deployed Connections instance. After reading it, they can deploy a release, verify its workspace and MCP boundary, and choose the correct log source when debugging.

## Production boundaries

- Clerk authenticates people and owns Organization creation, switching, invitations, profile, and membership UI.
- One Clerk Organization is one Connections workspace.
- The Connections API is the only browser and MCP route to product data.
- InsForge PostgreSQL stores encrypted workspace data, runtime-token hashes, runs, and audit events.
- Coolify runs the Connections container and receives its operational logs.

`Main` is the production InsForge database. Do not point Coolify at an InsForge preview branch.

## Deploy a release

1. Push the reviewed change to GitHub `main`.
2. Redeploy the Compose service in Coolify, or let its Git integration deploy the pushed revision.
3. Confirm the deployment built the current Git commit and the container becomes healthy on port 3000.
4. Open the console, sign in through Clerk, and select an Organization.
5. Check `/health` and, when the change affects execution, make one safe action call from the intended workspace.

Production requires the public origin, PostgreSQL URL, stable credential-encryption key, Clerk secret and publishable keys, and Clerk webhook signing secret. The project README lists the exact variable names and optional runtime controls.

## Workspace and MCP verification

Create runtime tokens only from the active Clerk Organization. A token is permanently bound to the workspace and member that created it; it does not follow later browser Organization switches.

For a basic isolation check:

1. Create distinct tokens in two Organizations.
2. Give each Organization a differently labelled provider connection.
3. Connect each MCP client with its matching token and call `list_apps`.
4. Verify each client sees only its Organization's labels. An action request naming the other Organization's label must return `connection_not_found`.

Members see only their own connections, tokens, runs, and temporary files. Managers and admins can work with all workspace connections. Clerk remains the surface for membership and Organization-profile changes.

## Debugging and logs

Use the log source that owns the symptom:

| Symptom                                                                  | First place to inspect                        | Durable record                  |
| ------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------- |
| Container start, HTTP failures, provider exceptions, stack traces        | Coolify application logs                      | None by default                 |
| Action result, duration, error code, and redacted input summary          | Connections **Runs** page                     | InsForge `runs` records         |
| Provider configuration, token, policy, membership, and lifecycle changes | Connections audit API / database              | InsForge `audit_events` records |
| Database or InsForge gateway problem                                     | InsForge Logs: PostgreSQL or PostgREST source | InsForge platform logs          |

Connections emits structured Pino logs to standard output. Coolify captures these container logs; they are not copied into InsForge. The InsForge Logs page is useful for its PostgreSQL and platform services, but it is not a mirror of the Coolify-hosted Connections application.

Runs redact sensitive input fields before persistence. Audit events and runs are workspace-scoped, and archived-workspace data is permanently purged after its 14-day restore window.

For long-term, searchable operational logs and alerts, configure a Coolify log drain to a chosen observability destination. That is a deployment decision; no log-drain vendor is required for normal operation today.

## InsForge database branch hygiene

Use an InsForge preview branch only for risky schema, RLS, or authentication changes. A preview branch has its own database and does not change `Main` until its migration is deliberately merged/applied.

- Use `schema-only` branches for migration checks with synthetic data.
- Keep production data changes on `Main`; branches are not a mechanism for merging row data.
- Return the local CLI context to the parent Connections project before applying production migrations.
- Delete a preview branch after its successful merge or when its experiment is no longer needed. Deletion is irreversible, but it never affects `Main`.

The previous `workspace-security-controls` and `seed-workspace-providers` previews were removed after their work was either merged or superseded. Only `Main` remains the deployment target.

## Company identity schema expansion (#3)

The migration branch's [authentication contract](AUTHENTICATION.md), [Clerk importer runbook](CLERK_IMPORT.md) and [verification ledger](BETTER_AUTH_VERIFICATION.md) describe the Better Auth transition. The deployment instructions above describe the currently deployed Clerk release; production promotion of the transition is gated by issue #12.

This step changes the schema while existing Clerk human-auth paths remain in use. It does not deploy Better Auth sessions or enable new membership workflows. The target ownership and permission contract is in `LOCKED.md`.

Pin: `better-auth@1.7.18`; organization plugin and field/table mappings live in `src/server/auth-schema.ts`. The checked-in migrations match those mappings, including core session/account/verification tables. Upgrade the pin only with schema compatibility review. Do not run automatic auth-schema generation during server startup.

For PostgreSQL, back up the database and apply `migrations/20261107200000_organization-identity.sql` once through the normal migration ledger, in a transaction. A fresh database starts from `connections-docs/insforge-schema.sql` and applies its subsequent migrations. Identity/company tables enable RLS with no browser policies and explicitly revoke PUBLIC and existing InsForge `anon`/`authenticated` grants; use the server database role. Never give browser clients these tables or a database key.

SQLite local startup records each migration atomically and enables foreign keys. D1 deployment applies `sqlite-migrations/0009_organization_identity.sql` with the standard migration runner before serving the updated store code. It rebuilds only `workspace_memberships`, whose rows are copied exactly; it does not rebuild the workspace parent or resource tables. SQLite/D1 use Better Auth ISO date values in date columns; PostgreSQL uses timestamptz. Real human-session adapter integration remains the next auth ticket's release gate.

Expansion intentionally leaves existing workspace/company references NULL until the verified importer (#9) establishes mappings. Do not derive verified identities or company owner roles from email strings, resource ownership, or workspace roles. To bind a verified legacy workspace, create its auth users, company and independent company memberships, then set grant `organization_id` values before the workspace's parent in one transaction. The deferred composite FK validates parentage at commit; the workspace trigger refuses binding with any unmapped grant. A bound company parent is immutable. New company workspaces require independently seeded company membership for every workspace grant. The unique required Clerk column remains a compatibility key during expansion; use `connections-workspace:<workspaceId>` for new workspace keys until that requirement is retired.

The importer/cutover must report zero unmapped production workspaces or grants (except an explicitly supported local compatibility workspace) before tightening NOT NULL constraints and switching human auth. Preserve workspace IDs, owner references, encrypted blobs, original encryption keys, runtime hashes and revocation timestamps. After new membership/security writes, recover by reconciliation or roll forward; dropping the expansion tables is not a safe rollback.

Local regression checks:

```sh
npm ci
npm run fix-check
npm test
npm run build:web
# Optional synthetic local PostgreSQL database; no production URL or credentials.
CONNECTIONS_TEST_POSTGRES_URL=postgresql://... npm test -- src/server/storage/organization-migration.test.ts src/server/storage/two-company-permissions.test.ts
```

The PostgreSQL test role needs CREATE SCHEMA on its disposable database. Tests use random isolated schemas, synthetic accounts and stub provider calls, and remove their schemas afterward. SQLite and D1 contract tests run without external services. The migration fixture tests fresh/populated expansion, stable ownership/token records, duplicate memberships, parent-grant constraints, atomic backfill and browser-role lockdown.

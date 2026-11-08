# Connections Product Vision

Connections gives people one secure place to connect business applications and let approved AI agents use them through MCP. It builds on the OpenConnector provider runtime.

A person signs in with one verified account and can belong to multiple client companies. Each company owns one or more workspaces. A shared operator can work in company A's A1 and A2 and company B's B1 without merging their data or permissions.

Better Auth owns identity, human sessions, company membership and organization invitations. Connections owns workspace grants and all resource authorization. Company owners/admins govern people and provision workspaces; directory membership alone reveals no provider resources. Each workspace has independent admin, manager and member grants and always retains an admin.

The console provides account, company and workspace administration. A tab's URL selects its workspace, and every protected request carries that intent. Two tabs may operate in different companies at once. The server checks current company membership, workspace grant and archive status before returning data.

Within a workspace, a manager or admin enables providers and configures their OAuth applications. Members connect their own labeled accounts. An agent must select a specific account label for every action. Members use and manage their own connections, tokens and runs; managers can use and manage authorized workspace connections and configure providers; admins can also archive and restore workspace data.

Credentials and provider OAuth secrets are encrypted and workspace-scoped. Members' identically named connections in sibling workspaces or other companies remain independent. Browser clients and agents never receive provider secrets.

Each workspace has one MCP environment and can issue several named, revocable opaque `oct_` tokens. A token retains its original user and workspace and uses the user's current access on every request. Removing a grant revokes associated keys and disconnects the removed member's accounts in that workspace. Company offboarding removes all grants in that company while preserving other companies. Historical audits and authorized run logs remain available.

Provider actions with recognized mutation verbs require approval by default; read-only actions default to trusted. A manager/admin may change the workspace policy. The consuming agent host presents approval and controls execution; Connections has no approval inbox.

The Hono server is the sole route between the browser and product data. PostgreSQL and private storage stay behind the server API. SQLite remains local compatibility, and the checked-in SQLite schema also supports D1. Provider execution remains lazy and retains shared network safety controls.

An admin can archive a workspace after destructive confirmation. Its data becomes unavailable immediately, is retained for a 14-day restore window, and is permanently purged afterward. Restoring a workspace must not restore revoked credentials or keys.

The migration preserves existing workspace IDs, encrypted accounts, stable user ownership and runtime token hashes. Schema expansion comes first; verified import, Better Auth sessions, console changes, Meetings OAuth and a staged cutover follow the [migration tracker](https://github.com/Ntrakiyski/connections/issues/2). The connector release removes Clerk human session and webhook paths after the verified migration. The server-only Clerk exporter and historical source mapping remain for migration verification. Production promotion follows a two-company isolation fixture, a migration/rollback rehearsal and reviewed production ownership mappings. The Meetings desktop pilot is deferred to a separate release.

[LOCKED.md](LOCKED.md) is the binding decision record. The [architecture map](../docs/architecture/architecture.html) shows the target ownership boundaries; its checked-in JSON is the source for regeneration.

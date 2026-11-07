# Locked Product Decisions

## Product model

- Connections is a shared SaaS platform. One verified account can belong to several client companies, and each company can own several workspaces.
- Better Auth owns stable user identity, human sessions, company directory memberships, and organization invitations. InsForge Auth is not used.
- Connections owns workspace provisioning, explicit workspace grants, resource authorization, audit, and scoped offboarding. Application services control invitation and membership workflows; a public auth-plugin endpoint must not bypass them.
- A user ID is stable and independent of email aliases or profile changes. Email verification establishes a sign-in/invitation identity; matching unverified email text never establishes ownership.
- Company directory roles are `owner`, `admin`, and `member`. Owners/admins manage company people and provision workspaces; every company retains an owner. A company role alone grants no access to connections, tokens, runs, files, or provider configuration.
- Workspace grants are independently `admin`, `manager`, or `member`. A grant is valid only while the user belongs to the parent company. Company owners/admins assign an initial workspace admin during atomic provisioning; every workspace retains an admin.
- A member can belong to A and B with different directory roles and receive different grants in A1, A2, and B1. Removing access in one scope preserves independent access elsewhere.
- The console owns account/company/workspace management screens. Each tab carries explicit workspace intent in its URL and requests; global active-company/session state is never a resource authorization boundary.
- Existing Clerk organizations map to one company and their existing initial workspace through a verified importer. Preserve workspace IDs, user/resource ownership mappings, encrypted credentials, token hashes and revocation history.
- A physically isolated deployment is an optional customer-demand exception, not the default.

## Provider connections

- A workspace owns provider enablement, OAuth application configuration, and action availability.
- A workspace admin or manager configures a provider's OAuth app and enables the provider for the team.
- Members see and use only the providers and actions configured for their workspace.
- Enabling a provider exposes its full action catalog; `Require approval` is the only action-level configuration.
- Admins/managers enter each provider's OAuth client ID and secret in that provider's workspace settings.
- Each member connects their own provider accounts within the workspace.
- After a workspace enables/configures Gmail, a member opens the Gmail provider page, selects **Connect Gmail**, chooses their account, and completes the existing Google OAuth flow.
- A member may connect multiple labeled accounts for the same provider in one workspace.
- Members may rename or disconnect only their own connections; managers/admins may rename or disconnect any workspace connection.
- A workspace can hold multiple connections for the same provider, such as one Gmail account per member.
- Every connection has a clear workspace-visible label for people and agents to select.
- An agent must explicitly select its target connection for every action.
- Manager and admin membership automatically grants use of every workspace connection; members can use only their own.

## Workspace roles

- **Member:** sees and chats only with their own connections.
- **Manager:** sees, chats with, and can select all workspace connections and providers; configures provider OAuth apps, provider availability, and the actions shared with the team.
- **Admin:** has manager capabilities plus archive and restore of Connections workspace data.
- Connections application services own workspace invitations, grants, removals, and role changes; Better Auth stores company directory membership.
- Members cannot change workspace configuration.
- Company roles and workspace resource roles are independent. Directory membership without a workspace grant cannot access provider resources.

## MCP and runtime tokens

- Each workspace has one MCP environment.
- A workspace can generate multiple runtime tokens.
- Each member can create multiple named, revocable runtime tokens for their own agents or devices; every token is bound to that member's workspace membership and role.
- A token immediately uses the member's current workspace role; a role change does not require replacing tokens.
- Runtime tokens are opaque secrets stored only as hashes in the application database, enabling immediate revocation and role enforcement.

## Platform and data boundary

- Insforge's free tier is the initial managed PostgreSQL and private-storage platform.
- PostgreSQL is the hosted production contract. SQLite supports local compatibility; D1 uses the corresponding checked-in SQLite expansion migrations. Human-session serving in each adapter is gated by issue #5.
- Better Auth is the human-authentication system; InsForge supplies server-only PostgreSQL and private storage.
- The Connections Hono API is the sole browser-to-data boundary. The browser does not access Insforge directly.
- Connections owns authorization, audit logging, OAuth handling, MCP token validation, and provider-action execution.
- Workspace provider OAuth client secrets are encrypted, workspace-scoped application data. They are never browser-visible, MCP-visible, or stored as shared project secrets.

## Workspace lifecycle

- Any admin can archive a workspace after a clear destructive confirmation.
- Archiving immediately makes Connections-owned workspace data, runtime tokens, provider connections, and files unavailable.
- Connections retains archived data for 14 days, during which an admin may restore it.
- After 14 days, Connections permanently erases the archived data, credentials, and files.

## Visibility and audit

- Members see only runs made through their own tokens or connections; managers/admins see all workspace runs.
- MCP exposes only permitted connection labels and safe account metadata needed for selection, never provider secrets or raw OAuth details.
- The workspace keeps audit history for provider configuration, connections, member/role changes, runtime tokens, approval-rule changes, and deletion.

## Approval policy

- Each provider action has a workspace-scoped `Require approval` true/false setting.
- Actions with a recognized mutation verb in their ID or name default to `Require approval = on`; read-only actions default off. The default verb set covers `acknowledge`, `activate`, `add`, `append`, `apply`, `approve`, `archive`, `assign`, `attach`, `ban`, `cancel`, `change`, `clear`, `close`, `copy`, `create`, `deactivate`, `decline`, `delete`, `detach`, `disable`, `edit`, `enable`, `execute`, `export`, `forward`, `import`, `insert`, `mark`, `merge`, `modify`, `move`, `mute`, `patch`, `pin`, `post`, `publish`, `purge`, `put`, `remove`, `rename`, `replace`, `reply`, `reset`, `restore`, `revoke`, `rollback`, `save`, `schedule`, `send`, `set`, `share`, `start`, `stop`, `submit`, `suspend`, `tag`, `toggle`, `transfer`, `trigger`, `unarchive`, `unassign`, `unban`, `unfollow`, `unlock`, `unmute`, `unpin`, `untrash`, `update`, `upload`, `upsert`, `void`, and `write`. An admin or manager may change the stored workspace policy.
- OpenConnector stores and returns that setting only.
- The consuming MCP client or agent host presents the approval prompt and controls execution after approval.
- OpenConnector does not have an approval inbox, queued-execution system, or approval UI.

## Member removal

- Removing a member immediately revokes their runtime tokens.
- Their provider connections are disconnected and unavailable for all future use.
- Historical run logs can remain available to managers and admins; no future activity is possible through the removed member's connections.

## Schema expansion and release boundary

- Issue #3 introduces the pinned Better Auth schema and company/workspace constraints; it does not switch the running Clerk session handler. Issues #5–#12 gate human auth, provisioning, import, Meetings compatibility and release.
- `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `organizations`, `organization_memberships`, and `organization_invitations` are Better Auth-owned server tables. `workspace_memberships` remains Connections-owned.
- `workspaces.organization_id` and `workspace_memberships.organization_id` stay nullable only for pre-import Clerk/local compatibility. Every mapped workspace grant must reference the same parent company and an independent company membership. NULL grants in mapped workspaces and company reassignment are rejected by the database.
- Do not synthesize verified identities or company roles during schema expansion. The importer first verifies stable source mappings, inserts identity/company memberships, sets each legacy grant's parent, and then binds the workspace in one transaction. Composite parent foreign keys are deferred until commit; directory membership keys are immediate. Binding is blocked while any legacy grant remains unmapped.
- Keep `clerk_org_id` unique and required during expansion so the currently deployed Clerk paths remain compatible. Until retirement, a new company-owned workspace uses a unique `connections-workspace:<workspaceId>` compatibility value, never another workspace's Clerk mapping. It is not a company identifier or an authentication claim.
- After a verified backfill, require zero NULL organization references outside the explicit local compatibility workspace before validating NOT NULL production constraints. The importer/release tickets own that validation and the eventual removal of legacy mapping requirements.
- Never roll schema expansion back by dropping identity or grants after new membership/security writes. Reconcile removals and revoked keys or roll forward according to the release runbook.

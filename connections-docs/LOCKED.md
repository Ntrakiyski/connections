# Locked Product Decisions

## Product model

- OpenConnector is a shared SaaS platform, not an agency-admin control plane.
- Registered users can create and join multiple workspaces.
- Users sign in to the Connections web app through Clerk.
- Clerk validates identity and workspace membership; the application database owns the effective `member`, `manager`, and `admin` role used by runtime tokens and authorization.
- One Clerk Organization maps to one workspace.
- Clerk's Organization UI is the workspace profile and membership surface: organization creation, switching, naming, invitations, and member removal happen there. Connections does not duplicate those screens.
- Clerk's UserProfile UI is the personal profile and account-security surface. Connections does not duplicate those screens.
- Connections synchronizes Clerk membership changes into its authorization store so runtime tokens and workspace access reflect Clerk membership immediately.
- A private workspace has only its owner. A shared workspace has invited members.
- The workspace creator is its first admin, and every workspace must retain at least one admin.
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
- Clerk's Organization UI owns invitations, member removal, and role assignment.
- Members cannot change workspace configuration.
- Clerk's Organization roles map to Connections roles until Connections needs product-specific roles beyond Clerk's membership model.

## MCP and runtime tokens

- Each workspace has one MCP environment.
- A workspace can generate multiple runtime tokens.
- Each member can create multiple named, revocable runtime tokens for their own agents or devices; every token is bound to that member's workspace membership and role.
- A token immediately uses the member's current workspace role; a role change does not require replacing tokens.
- Runtime tokens are opaque secrets stored only as hashes in the application database, enabling immediate revocation and role enforcement.

## Automations

- Automations are workspace-scoped, versioned products composed from the workspace's existing labelled provider connections and enabled actions.
- Agents create and structurally edit automation drafts through Connections MCP; the browser is an inspection, safe-configuration, client-execution, release, endpoint, and observability surface, not a general workflow/code builder.
- Connections deploys one generic in-process `AutomationRunner`. Client automations are persisted definitions and do not add a repository script, container, or deployment.
- The `AutomationRunner` delegates every provider call to the existing workspace-scoped action runner. It does not receive or expose provider credentials.
- An automation step declares Input, Logic, Output, its allowed action, and its explicit connection label. The initial runner supports input, action, transform, return, and a persisted schedule step for the scheduled Gmail-draft use case.
- Published automation versions are immutable. Editing a draft never changes the currently live endpoint behaviour; runs retain their version and step history.
- A future live automation endpoint is private by default and authenticated by Connections, never by the target provider's OAuth credential. Scheduled Gmail Draft v1 intentionally has no public endpoint.
- Sandbox execution is not part of the first automation release. Add isolated arbitrary-code execution only for a proven requirement outside the declarative runner; it must receive a short-lived action-scoped capability rather than provider credentials.

## Platform and data boundary

- Insforge's free tier is the initial managed PostgreSQL and private-storage platform.
- SQLite remains for local/single-user development compatibility only.
- Clerk remains the only human-authentication system; Insforge Auth is not used.
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

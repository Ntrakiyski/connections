# Connections Product Vision

## Reader and purpose

This document is for a contributor joining the project. After reading it, they should understand the product we are building, the boundaries they must preserve, and when to consult the locked decisions before changing code.

Connections is a SaaS built from the OpenConnector provider runtime. It gives people and teams one secure place to connect their business applications, then lets their approved AI agents use those connections through MCP.

The current repository is the upstream single-runtime foundation, not the final product. The target is a multi-workspace application.

## The product

A registered user can create and join multiple workspaces. One Clerk Organization represents one workspace.

A workspace may be private, with only its creator, or shared, with invited teammates. The same person can belong to several workspaces and switch between them in the web app.

Each workspace is isolated: its members, providers, OAuth configuration, connections, tokens, files, runs, and audit history never appear in another workspace.

## Workspace experience

The console uses Clerk's workspace selector in the sidebar. Clerk provides organization creation, switching, profile management, invitations, and membership management. Connections uses that active organization as its workspace boundary and focuses its own console on provider connections, runtime tokens, and execution.

Within a workspace, the provider page shows only providers the workspace has enabled. A member can connect one or more labeled accounts for an enabled provider. For example, after Gmail is enabled and configured, a member selects **Connect Gmail**, chooses a Google account, and completes OAuth.

Connection labels are visible to the workspace so people and agents can choose deliberately. An agent always selects a specific connection for an action; it never silently chooses a default account.

## Team roles

Clerk establishes identity and Organization membership. Connections owns the effective workspace role used by authorization.

| Role    | What it can do                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Member  | Use and manage only their own connections, tokens, and runs.                                            |
| Manager | See and use all workspace connections and runs; enable/configure providers and their available actions. |
| Admin   | Has manager capabilities plus archive and restore of Connections workspace data.                        |

Clerk's Organization UI owns invitations, removals, and role changes. The workspace creator is the first admin, and a workspace must always retain at least one admin.

## Providers and approval

A manager or admin enables a provider for the workspace and configures its OAuth application. That makes the provider's full action catalog available to the team.

Every provider action requires approval by default. A manager or admin may disable that requirement for a trusted action. Connections stores this policy; it does not create an approval inbox. The MCP client or agent host asks the human for approval before executing an action that requires it.

OAuth client secrets and connected-account credentials are workspace-scoped encrypted data. They never reach the browser, MCP client, or another workspace.

## MCP and runtime tokens

Each workspace has one MCP environment. Members create named, revocable runtime tokens for their own agents or devices.

Runtime tokens are opaque secrets. Connections stores only their hashes and resolves the token to the member's current workspace role on every use. Revoking a token or changing a role takes effect immediately.

MCP exposes only permitted connection labels and safe account metadata. Members can use only their own connections; managers and admins can use every workspace connection.

## Platform boundaries

Clerk is the only human-authentication system. Insforge provides the initial managed PostgreSQL database and private storage. The Connections Hono API is the only route between the browser and product data; the browser does not query Insforge directly.

Connections owns authorization, auditing, OAuth handling, runtime-token validation, provider execution, and MCP behavior. The provider runtime remains lazy and uses the existing safety controls for provider network access.

## Lifecycle, observability, and safety

Members can see only their own runs. Managers and admins can inspect workspace-wide runs. The workspace records audit events for security-relevant changes such as provider configuration, connections, token changes, roles, approval policies, and deletion.

Removing a member immediately revokes their tokens and disconnects their provider accounts. Historical run logs may remain visible to managers and admins.

An admin can archive a workspace after a clear destructive confirmation. Archiving makes Connections-owned data unavailable immediately, retains it for a 14-day restore window, and then permanently erases its credentials, files, and other scoped records.

## Decision rule

This document describes the intended destination. [LOCKED.md](LOCKED.md) is the authoritative record of exact decisions. Read it before making an implementation choice; if it does not answer the question, raise the decision before adding speculative product behavior.

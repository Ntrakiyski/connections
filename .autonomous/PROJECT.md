# Project

## Problem

Teams need a secure, shared way to connect their business applications
(SaaS tools, APIs, databases) and let their approved AI agents use those
connections through MCP. Today this means every developer wires up their
own credentials, tokens leak into agent prompts, and there's no shared
workspace visibility over what's connected and who can use it.

## Solution

Connections is a shared SaaS platform built on the OpenConnector provider
runtime. It gives people and teams one secure place to:

- Connect their business applications (Gmail, GitHub, Slack, Notion, etc.)
  through a catalog of 130+ providers
- Manage OAuth credentials, API keys, and connection labels workspace-wide
- Grant AI agents MCP access to selected connections
- Control which actions require approval before execution
- Audit every action run and connection event

The existing runtime already executes provider actions, handles OAuth
flows, and exposes MCP tools. The product work transforms this single-user
runtime into a multi-workspace SaaS.

## Users

- **Individual developers** who wire their own tools into AI agents
- **Teams** who share provider connections across members
- **Workspace admins** who configure OAuth apps and set approval policies
- **AI agents** that consume connections through MCP

See VISION.md for the full product direction and LOCKED.md for binding
decisions.

## Outcomes

1. A registered user can create and join multiple workspaces
2. Workspace admins enable providers, configure OAuth, and set approval
   policies
3. Members connect labeled provider accounts within their workspace
4. AI agents select specific connections through MCP
5. Managers and admins inspect workspace-wide runs and audit events
6. Runtime tokens are revocable, scoped to the member's current role

## Out of Scope

- An approval inbox or queued-execution system (the MCP client handles
  approval prompts)
- Browser-side OAuth secret handling (secrets are workspace-scoped,
  encrypted server-side)
- Replacing Clerk as the identity system
- Direct browser access to Insforge data (API is the sole boundary)

## Open Questions

- What does migration from the current single-runtime SQLite store to the
  multi-workspace data model look like?
- How does the provider catalog stay in sync across workspaces in a
  multi-tenant deployment?

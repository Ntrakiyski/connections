<!--
Sync Impact Report
- Version change: uninitialized template → 1.0.0
- Modified principles: placeholder principles → I. Locked Decisions Are Binding;
  II. Workspace Isolation and Server-Side Authorization; III. Secrets and Provider
  Egress Stay Trusted; IV. Preserve the Provider Runtime Contract; V. Minimal,
  Verifiable Changes.
- Added sections: Product Boundaries; Development and Delivery Controls.
- Removed sections: none.
- Templates requiring updates:
  ✅ .specify/templates/plan-template.md
  ✅ .specify/templates/spec-template.md
  ✅ .specify/templates/tasks-template.md
  ✅ .specify/templates/commands/ (not present; no command templates to review)
- Deferred TODOs: original ratification date was not recorded.
-->

# Connections Constitution

## Core Principles

### I. Locked Decisions Are Binding

`connections-docs/LOCKED.md` is the authoritative record for product and architecture
decisions. Every product plan and implementation MUST read it with
`connections-docs/VISION.md` before making a product choice. A change that conflicts
with a locked decision MUST stop for an explicit decision; it MUST NOT preserve upstream
behavior or invent product policy by default. Accepted decisions MUST update `LOCKED.md`;
material product-direction changes MUST update `VISION.md`.

Rationale: Connections is deliberately evolving beyond the upstream single-runtime
product, so assumptions from that runtime are not a substitute for product decisions.

### II. Workspace Isolation and Server-Side Authorization

All workspace-owned data and behavior—including membership, providers, OAuth settings,
connections, credentials, files, runs, audit events, and runtime tokens—MUST be scoped
to one workspace and inaccessible across workspace boundaries. Clerk is the sole human
identity and organization-membership system; Connections owns effective `member`,
`manager`, and `admin` authorization. The Connections Hono API is the sole
browser-to-product-data boundary: browsers MUST NOT access Insforge directly.

Runtime tokens MUST be opaque, stored only as hashes, bound to the creator's workspace
membership, and evaluated against the creator's current role on every use. A member
removal MUST immediately revoke that member's tokens and disconnect their accounts.

Rationale: tenant isolation and immediate authorization changes are the product's core
security guarantee.

### III. Secrets and Provider Egress Stay Trusted

Provider OAuth client secrets and connected-account credentials MUST be encrypted,
workspace-scoped application data. They MUST NOT be exposed to the browser, MCP clients,
other workspaces, logs, or shared project secrets. MCP MAY expose only permitted
connection labels and safe account metadata; an action MUST use an explicitly selected
connection.

All provider network egress MUST use the shared SSRF-guarded fetch path. DNS validation
remains enabled unless the egress host is a hardcoded, code-controlled literal. Private
network access MAY apply only to a trusted, configured self-hosted instance and MUST
never apply to user-supplied download/content URLs; reserved, loopback, link-local, and
cloud-metadata destinations remain blocked.

Rationale: provider credentials and outbound requests are the highest-risk trust
boundaries in Connections.

### IV. Preserve the Provider Runtime Contract

OpenConnector remains the provider-execution foundation. Upstream-compatible catalog,
action, connection-alias, envelope, error-code, and lazy-loading behavior MUST remain
stable unless a locked Connections requirement deliberately changes it. Each fact has one
clear owner: provider definitions own catalog metadata and schemas; executors receive
metadata rather than importing definitions for convenience; `/v1` response shaping lives
in `src/server/runtime-api.ts`.

Provider schemas MUST use the shared JSON-schema helpers. Provider code MUST use the
established definition/actions/executors structure and shared executor helpers rather
than duplicate action wiring.

Rationale: a stable, lazy runtime protects existing clients while the multi-workspace
product is built around it.

### V. Minimal, Verifiable Changes

Changes MUST solve the root cause with the smallest coherent diff, reuse existing
patterns before adding abstractions or dependencies, and avoid unrelated rewrites.
Modules MUST have a clear responsibility; imports MUST target owning modules rather than
barrel files. TypeScript uses native Node execution, `interface` for object-shaped
contracts, `oxfmt`, and `oxlint`; it MUST NOT add `tsx`, experimental type stripping, or
Prettier.

Every change MUST have proportionate evidence: inspect the user-facing result and run the
strongest relevant checks. Code changes MUST run `npm run fix-check`; provider catalog or
action changes MUST also run `npm run generate:catalog`; changed user-facing examples
MUST be exercised manually. Unrun checks and remaining risks MUST be recorded.

Rationale: the safest multi-tenant product change is narrowly scoped, maintainable, and
demonstrably correct.

## Product Boundaries

One Clerk Organization maps to one workspace; each workspace has one MCP environment.
Managers and admins configure providers and see workspace-wide connections and runs;
members manage and use only their own connections and runs. A workspace MUST retain at
least one admin. Each enabled provider exposes its full catalog, with workspace-scoped
`Require approval` enabled by default for every action. Connections stores and returns
that policy only; the MCP client or agent host owns approval prompting and execution.

Workspace deletion requires a clear destructive confirmation, makes all workspace
resources immediately unavailable, retains an encrypted restorable backup for 14 days,
and then permanently erases it. Audit history MUST cover provider configuration,
connections, member and role changes, tokens, approval rules, and deletion.

SQLite supports only local/single-user development compatibility. Insforge is the initial
managed PostgreSQL and private-storage platform. A physically isolated deployment is an
optional customer-demand exception, not the default product model.

## Development and Delivery Controls

Before non-trivial work, maintain `tasks/todo.md` with the goal, constraints, steps,
verification, and evidence-based review; record recurring corrections or failed
assumptions in `tasks/lessons.md`. Plans and specifications MUST identify applicable
locked decisions, workspace/authorization effects, secret and egress boundaries,
compatibility effects, and verification. Public documentation MUST describe normal OSS
usage and may describe official Connections SaaS/team paths, but MUST NOT claim
unreleased behavior or expose internal compatibility projects.

Before completion, review the actual artifact, edge cases, authorization/visibility
boundaries, and stakeholder-facing wording. Do not claim a check passed without evidence.
Generated catalog artifacts, provider metadata ownership, and public wire shapes require
deliberate compatibility review. Product or architecture decisions made during delivery
must be recorded in `connections-docs/LOCKED.md` before they are treated as policy.

## Governance

This constitution governs project planning, implementation, review, and delivery. It is
subordinate to explicit user instructions and the binding product decisions in
`connections-docs/LOCKED.md`; repository guidance in `AGENTS.md` supplies the operating
conventions used to enforce it. Every plan and review MUST record constitutional
compliance or a documented, approved exception.

Amendments require an explicit product or engineering decision, an update to this file,
and consistency review of affected `.specify/templates/`, `AGENTS.md`, and public
guidance. Versioning follows semantic intent: MAJOR for incompatible principle removal
or redefinition, MINOR for a new principle or materially expanded mandate, and PATCH for
clarification-only changes. The review for every amendment MUST verify the version, ISO
dates, placeholder removal, and dependent-template alignment.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date was not recorded | **Last Amended**: 2026-07-15

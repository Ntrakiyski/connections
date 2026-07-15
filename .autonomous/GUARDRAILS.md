# Guardrails

## Secrets and Credentials

- Never log, store in plaintext, or return OAuth client secrets, API keys,
  or runtime tokens in any API response or MCP tool output.
- All provider credentials are encrypted at rest with AES-GCM. The
  encryption key (`OOMOL_CONNECT_ENCRYPTION_KEY`) is never hardcoded.
- OAuth client secrets are workspace-scoped encrypted data. They never
  reach the browser, MCP client, or another workspace.
- Runtime tokens are stored only as hashes. The raw token is returned once
  at creation and never again.
- Never read or print `.env` files, credential files, or any file
  containing secrets.

## Network Egress (SSRF)

- All provider HTTP requests must go through the SSRF-guarded fetch
  (`context.fetcher` in executors, `providerFetch` in proxies). Never use
  the global `fetch`.
- The guard validates the request URL and every redirect `Location` with
  `assertPublicHttpUrl`, follows redirects manually, and validates
  DNS-resolved addresses by default.
- `skipDnsValidation: true` is allowed ONLY when the egress host is a
  hardcoded literal fully controlled by the code. NEVER when the host
  comes from credential/user input or a user-supplied URL.
- Self-hosted providers on private networks require
  `allowPrivateNetwork: true` AND the `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK`
  environment flag. Reserved, loopback, link-local, and cloud-metadata
  targets stay blocked even with the flag on.
- User-supplied content/download URLs must ALWAYS be validated public-only
  — call `assertPublicHttpUrl` without `allowPrivateNetwork`.

## Data Boundaries

- The Hono API is the sole browser-to-data boundary. The browser does not
  query Insforge directly.
- Workspace data is strictly isolated: no workspace's members, providers,
  connections, tokens, or runs appear in another workspace.
- The Connections server owns authorization, audit logging, OAuth handling,
  and runtime-token validation. Clerk only validates identity and
  Organization membership.

## Destructive Actions

- Removing a member immediately revokes their runtime tokens and
  disconnects their provider accounts. This is irreversible without
  manual restoration.
- Workspace deletion makes it unavailable immediately with a restorable
  backup for 14 days, then permanently erases everything. Always require
  explicit confirmation before any delete operation.
- Never drop tables, delete production data, or run destructive SQL
  without explicit approval.

## Code and Repo

- Do not commit, push, or rewrite git history unless asked.
- Never add `tsx` or `--experimental-strip-types`. Use native Node.js
  TypeScript execution.
- Do not create barrel files (`index.ts`). Import from the concrete module
  that owns the API.
- Prefer `interface` for object-shaped contracts. Keep unions and mapped
  types as `type`.
- Do not manually wrap code to 80 columns. Let `oxfmt` decide formatting.
- Provider code lives in `src/providers/<service>/` with `definition.ts`,
  `actions.ts`, `executors.ts`, and optional `runtime.ts`/`scopes.ts`.
- Do not import provider definitions from executor modules just to reuse
  metadata. Inject catalog metadata from the server/loader side.
- Run `npm run fix-check` before finishing code changes (lint fixes,
  formatting fixes, `src` typecheck).
- Run `npm run generate:catalog` when provider definitions or actions change.

## Product Decisions

- If a proposed change conflicts with `LOCKED.md`, stop and obtain a
  decision. Do not silently preserve upstream behavior or invent a new
  product rule.
- Update `LOCKED.md` when a product or architecture decision is accepted.
  Update `VISION.md` when the product direction materially changes.
- The current single-runtime SQLite behavior is the foundation, not the
  target product. Do not add features that assume single-user forever.

## Agent Conduct

- Unknown facts stay unknown until resolved. Do not invent configuration,
  API behavior, or product rules.
- Back verification claims with source paths, command output, or evidence
  files. "Tests passed" without artifacts is not a pass.
- Read before write. Understand the existing codebase before writing a
  single line. Search for patterns and follow them exactly.
- Consistency over novelty. Match existing patterns even if you know a
  "better" way. The codebase should read like one person wrote it.
- The provider runtime remains lazy. Catalog generation may import provider
  definitions, but executor modules should load only when an action or
  credential validator is actually used.

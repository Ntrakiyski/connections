# Context

## Source Documents

- `AGENTS.md` — repository conventions, architecture rules, code style,
  provider patterns, SSRF guard, verification workflow
- `connections-docs/VISION.md` — Connections product target: multi-workspace SaaS for
  provider connections + MCP access
- `connections-docs/LOCKED.md` — binding product and architecture decisions (Clerk identity,
  workspace isolation, OAuth model, MCP token design, audit, deletion)
- `package.json` — `@oomol-lab/open-connector` v1.1.0, npm workspaces with
  `web/`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (native TS), TypeScript 7 |
| Server | Hono 4 |
| Frontend | Vite + React + Radix UI (`web/`) |
| Database | SQLite (local) / Cloudflare D1 (production) |
| File storage | Local disk / Cloudflare KV, R2 (transit files) |
| MCP | `@modelcontextprotocol/sdk` v1.29+ |
| OAuth | Custom OAuth flow service (no third-party library) |
| Testing | Vitest 4 |
| Lint/Format | oxlint, oxfmt (no Prettier) |
| Deployment | Wrangler (Cloudflare Workers) |

## Architecture Layers

```
src/
├── core/              Types, JSON schema, guarded fetch (SSRF),
│                      credential fields, action policy, action search,
│                      provider definition, execution, validation, cast
├── providers/<svc>/   Per-provider: definition.ts, actions.ts,
│                      executors.ts, runtime.ts, scopes.ts (~130+ providers)
├── server/            Hono app, routing, storage (SQLite/D1),
│   ├── api/           secrets (encryption codec), files (transit),
│   ├── storage/       proxy runner, MCP endpoints
│   ├── secrets/
│   ├── files/
│   └── proxy/
├── oauth/             OAuth flow service, client config, credential refresh
├── catalog-store.ts   Generated catalog loader from JSON
├── connection-service.ts  Connection CRUD + credential management
└── mcp.ts             MCP server bridge — exposes provider actions as tools
web/                   Vite React console (separate workspace)
```

## Key Modules

### Core (`src/core/`)
- `types.ts` — `JsonSchema`, `AuthType`, `ProviderDefinition`, `ActionDefinition`,
  `CredentialDefinition`, `RuntimeLogger`
- `guarded-fetch.ts` — SSRF-safe fetch: validates URLs, follows redirects
  manually, DNS address validation. All provider egress goes through this.
- `json-schema.ts` — schema builder helpers, imported as `s`
- `provider-definition.ts` — `defineProvider`, `defineProviderExecutors`,
  `defineApiKeyProviderExecutors`, `defineProviderProxy`
- `action-policy.ts` — allow/block lists for actions and proxies
- `action-search.ts` — MiniSearch-backed action discovery
- `execution.ts` — action execution pipeline, credential resolution
- `cast.ts` — generic low-level casting/reading helpers

### Server (`src/server/`)
- `connect-app.ts` — assembles the full application (services, routes, MCP)
- `connect-server.ts` — Hono route definitions: `/v1/` API, OAuth, MCP, Scalar
  docs, static assets
- `index.ts` — Node.js entry point, loads catalog, wires services, starts server
- `cloudflare.ts` — Cloudflare Workers entry point
- `storage/` — `SqliteRuntimeDatabase` + `D1RuntimeStore` for connections,
  OAuth state, run logs, runtime tokens
- `secrets/` — AES-GCM encryption codec for stored credentials

### OAuth (`src/oauth/`)
- `oauth-flow-service.ts` — OAuth 2.0 authorization code flow
- `oauth-client-config-service.ts` — per-provider OAuth client ID/secret management
- `oauth-credential-refresh-service.ts` — token refresh lifecycle

### MCP (`src/mcp.ts`)
- Creates an MCP server from the provider catalog
- Each provider becomes an MCP server; each action becomes a tool
- Searchable tool index for agent discovery

## Domain Vocabulary

| Term | Meaning |
|------|---------|
| Provider | A third-party service integration (e.g. Gmail, GitHub) |
| Action | A single operation a provider supports (e.g. `send_email`) |
| Connection | A labeled, configured provider account (OAuth or API key) |
| Workspace | An isolated team environment (one Clerk Organization) |
| Runtime token | An opaque, revocable secret for MCP/API access |
| Transit file | Temporary file uploaded during action execution |
| Catalog | Generated JSON describing all providers and their actions |
| Approval policy | Per-action `Require approval` boolean setting |

## Known Constraints

- Current runtime is single-user SQLite; multi-workspace data model is the
  target
- Provider OAuth secrets must be encrypted at rest (AES-GCM, workspace-scoped)
- All provider network egress must pass through the SSRF-guarded fetch
- The web console is a separate Vite package under `web/`, not part of `src/`
- Clerk is the only identity provider; no alternative auth systems
- Insforge is the managed PostgreSQL + storage platform for production
- The Hono API is the sole browser-to-data boundary

# OpenAPI Provider Reference

Use this reference when adding a provider from an OpenAPI or Swagger JSON/YAML specification.

## Goal

Turn the specification into a curated, runnable Connections provider. Do not blindly mirror every operation. The output remains normal provider source:

```text
src/providers/<service>/
  definition.ts
  actions.ts
  executors.ts
  runtime.ts        # optional, preferred for shared request logic
  scopes.ts         # optional, for provider-native OAuth scopes
```

## Inspect The Spec

1. Fetch or read the spec without committing it unless the user explicitly wants the raw spec stored and rights allow redistribution.
2. Identify whether it is OpenAPI 3.x or Swagger 2.0.
3. Record `info.title`, `info.version`, `host`/`basePath` or `servers`, security schemes, tags, and operation count.
4. Resolve `$ref` only as needed for the selected operations. Avoid copying large generated schemas into source.
5. Prefer official operation descriptions, parameter descriptions, enum values, formats, required fields, pagination cursors, and documented error envelopes.

For YAML, use a local parser available in the repo or a short throwaway inspection command. Do not add a runtime dependency solely to inspect a spec.

## Choose The First Action Set

Start with at most 5 runnable actions unless the user asks for wider coverage. Pick actions that are:

- useful to agents;
- representative of the provider API;
- safe enough for an initial provider slice;
- backed by clear request and response schemas;
- feasible with the provider's available auth type.

Prefer read/list/get actions first. Add mutating actions only when the user requested them or they are essential to proving the integration.

Do not expose administrative, destructive, payment, bulk, file, streaming, or webhook operations in the first slice unless explicitly requested and carefully modeled.

## Map OpenAPI To Actions

For each selected operation:

- Convert `operationId` or `method + path` into a stable provider-local action name using snake_case.
- Use `defineProviderAction(service, { name, description, inputSchema, outputSchema })`.
- Build `inputSchema` from path parameters, query parameters, headers that users must supply, and request body fields.
- Keep path and query parameters at top level unless nesting is clearly better for agents.
- Mark required path parameters and required body fields as required.
- Preserve enums, string formats, min/max values, pagination fields, and defaults when meaningful.
- Use provider-native OAuth scopes or permission names in `requiredScopes`/`providerPermissions`.
- Normalize output around the documented success payload. Use a loose object only for undocumented nested provider payloads, not for the whole action when stable top-level fields are known.

When a schema is huge, create a smaller agent-facing contract that contains the stable and useful fields, and keep `raw` only when needed for provider transparency.

## Map Auth

Translate OpenAPI `securityDefinitions` or `components.securitySchemes` into repository auth:

- `apiKey` in a header or query usually maps to `api_key`. Prefer header-based use in the executor when both are allowed.
- HTTP bearer maps to `api_key` when users paste a bearer token, or to `oauth2` only when the spec documents the full OAuth flow needed here.
- OAuth2 maps to `oauth2` only when authorization URL, token URL, scopes, and token auth method are known.
- Multiple required credential fields map to `custom_credential`.

Add a cheap `credentialValidators` implementation when the spec has a simple current-user, account, profile, or harmless list endpoint.

## Implement Runtime

Create `runtime.ts` when more than one action shares request construction. It should own:

- base URL construction;
- auth headers;
- JSON request/response handling;
- path parameter interpolation;
- query parameters;
- provider error mapping;
- small response normalization helpers.

Use shared helpers such as `requestJson`, `objectPayload`, `arrayPayload`, `definedBody`, `compactObject`, `optionalString`, `requiredString`, `optionalInteger`, and provider-runtime credential helpers when they fit.

All provider egress must use the injected guarded fetch from `defineProviderExecutors`, `defineApiKeyProviderExecutors`, `defineOAuthProviderExecutors`, or `defineBearerProviderExecutors`. Never call global `fetch` from provider runtime code.

## Executor Pattern

Keep handlers keyed by provider-local action name:

```ts
const handlers = {
  list_items(input, context) {
    return providerRequest(context, { method: "GET", path: "/items", query: { page: input.page } });
  },
};

export const executors = defineProviderExecutors({
  service,
  handlers,
  async createContext(context, fetcher) {
    const credential = await requireApiKeyCredential(context, service);
    return { apiKey: credential.apiKey, fetcher, signal: context.signal };
  },
});
```

Do not import `definition.ts` from `executors.ts`. If a type from `actions.ts` helps keep handler keys aligned, import it as a type only.

## OpenAPI Generator Choice

Default to a hand-curated provider slice. Create a provider-specific generator like `dokploy/generate.ts` only when:

- the user explicitly wants broad generated coverage;
- the source spec is stable and publicly redistributable or can be fetched reproducibly;
- generated output will still be reviewed and shaped into this repository's provider conventions;
- the generator output is not committed as opaque schema noise.

For normal provider work, inspect the spec and hand-write the first useful actions.

## Validation

After implementation:

1. Run `npm run generate:catalog`.
2. Run `npm run fix-check`.
3. Run targeted tests if provider logic includes non-trivial URL interpolation, auth validation, pagination, error mapping, file handling, or SSRF-sensitive user-configured base URLs.
4. Review generated and source diffs. Generated registry/catalog files are ignored and should not be hand-edited.

In the final handoff, state which OpenAPI operations became actions, which operations were intentionally omitted, and what auth assumptions remain for users to configure.

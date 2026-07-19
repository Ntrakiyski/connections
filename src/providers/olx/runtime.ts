import type { QueryValue } from "../../core/request.ts";
import type { OAuthProviderContext } from "../provider-runtime.ts";
import type { OlxFieldSpec, OlxOperation } from "./operations.ts";

import { compactObject, optionalInteger, optionalNumber, optionalRecord, optionalString } from "../../core/cast.ts";
import { queryParams } from "../../core/request.ts";
import { providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";
import { olxOperations } from "./operations.ts";

export type OlxActionContext = OAuthProviderContext;

interface OlxRequestInput {
  method: OlxOperation["method"];
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
}

const olxApiBaseUrl = "https://www.olx.bg/api/partner";
const olxApiVersion = "2.0";

export const olxActionHandlers: Record<
  string,
  (input: Record<string, unknown>, context: OlxActionContext) => Promise<unknown>
> = Object.fromEntries(
  olxOperations.map((operation) => [
    operation.name,
    async (input: Record<string, unknown>, context: OlxActionContext) => executeOlxOperation(operation, input, context),
  ]),
);

export async function validateOlxCredential(
  accessToken: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{
  profile: {
    accountId: string;
    displayName: string;
  };
  grantedScopes: string[];
  metadata: Record<string, unknown>;
}> {
  const user = normalizePayload(
    "user",
    await olxRequestObject({
      accessToken,
      tokenType: "Bearer",
      fetcher,
      signal,
    }),
  );

  return {
    profile: {
      accountId: user.id != null ? `olx:user:${String(user.id)}` : "olx:user",
      displayName: optionalString(user.email) ?? optionalString(user.name) ?? "OLX User",
    },
    grantedScopes: [],
    metadata: compactObject({
      apiBaseUrl: olxApiBaseUrl,
      apiVersion: olxApiVersion,
      userId: user.id,
      email: user.email,
      status: user.status,
      isBusiness: user.isBusiness,
    }),
  };
}

async function executeOlxOperation(
  operation: OlxOperation,
  input: Record<string, unknown>,
  context: OlxActionContext,
): Promise<unknown> {
  const payload = await olxRequest(context, {
    method: operation.method,
    path: interpolatePath(operation.path, operation.pathParams ?? [], input),
    query: readQuery(operation.queryParams ?? [], input),
    body: operation.body ? readBody(input.body) : undefined,
  });

  if (operation.outputKind === "empty") {
    return { success: true, result: optionalRecord(payload) ?? null };
  }

  const output =
    operation.outputKind === "data_array"
      ? normalizeArray(readObject(payload, "OLX response").data).map((item) =>
          normalizePayload(operation.outputKey, item),
        )
      : operation.outputKind === "array"
        ? normalizeArray(payload).map((item) => normalizePayload(operation.outputKey, item))
        : normalizePayload(operation.outputKey, payload);

  return { [operation.outputKey]: output };
}

async function olxRequestObject(
  context: OlxActionContext,
  input: OlxRequestInput = { method: "GET", path: "/users/me" },
): Promise<Record<string, unknown>> {
  return readObject(await olxRequest(context, input), "OLX response");
}

async function olxRequest(context: OlxActionContext, input: OlxRequestInput): Promise<unknown> {
  const url = new URL(input.path.replace(/^\//, ""), `${olxApiBaseUrl}/`);
  for (const [key, value] of Object.entries(queryParams(input.query ?? {}))) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  let payload: unknown;
  try {
    response = await context.fetcher(url, {
      method: input.method,
      headers: {
        accept: "application/json",
        authorization: `${context.tokenType ?? "Bearer"} ${context.accessToken}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
        "user-agent": providerUserAgent,
        Version: olxApiVersion,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: context.signal,
    });
    payload = await readOlxPayload(response);
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `OLX request failed: ${error.message}` : "OLX request failed",
    );
  }

  if (!response.ok) {
    throw createOlxError(response, payload);
  }

  return payload;
}

async function readOlxPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(502, "OLX returned invalid JSON");
  }
}

function createOlxError(response: Response, payload: unknown): ProviderRequestError {
  const message = extractOlxErrorMessage(payload) ?? `OLX request failed with HTTP ${response.status}`;
  if (response.status === 401) {
    return new ProviderRequestError(409, message, payload);
  }
  if (response.status === 403) {
    return new ProviderRequestError(403, message, payload);
  }
  if (response.status === 404 || response.status === 422 || response.status === 400) {
    return new ProviderRequestError(400, message, payload);
  }
  if (response.status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  return new ProviderRequestError(response.status >= 500 ? 502 : response.status || 500, message, payload);
}

function extractOlxErrorMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  const error = optionalRecord(record?.error);
  return optionalString(error?.detail) ?? optionalString(error?.title) ?? optionalString(record?.message);
}

function interpolatePath(path: string, fields: OlxFieldSpec[], input: Record<string, unknown>): string {
  return fields.reduce((output, field) => {
    const value = readFieldValue(field, input[field.name]);
    if (value === undefined || value === null) {
      throw new ProviderRequestError(400, `${field.name} is required.`);
    }
    return output.replace(`{${field.name}}`, encodeURIComponent(String(value)));
  }, path);
}

function readQuery(fields: OlxFieldSpec[], input: Record<string, unknown>): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const field of fields) {
    query[field.wireName ?? field.name] = readFieldValue(field, input[field.name]);
  }
  return query;
}

function readFieldValue(field: OlxFieldSpec, value: unknown): QueryValue {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (field.type === "integer") {
    return optionalInteger(value);
  }
  if (field.type === "number") {
    return optionalNumber(value);
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (field.type === "integer_array") {
    return Array.isArray(value) && value.every((item) => Number.isInteger(item))
      ? value.map((item) => String(item)).join(",")
      : undefined;
  }
  return optionalString(value);
}

function readBody(value: unknown): Record<string, unknown> {
  const body = optionalRecord(value);
  if (body) {
    return body;
  }
  throw new ProviderRequestError(400, "body must be an object.");
}

function normalizePayload(outputKey: string, value: unknown): Record<string, unknown> {
  const payload = readObject(value, `OLX ${outputKey}`);
  if (outputKey === "user" || outputKey === "businessUser") return normalizeUser(payload);
  if (outputKey === "regions" || outputKey === "region") return normalizeRegion(payload);
  if (outputKey === "cities" || outputKey === "city") return normalizeCity(payload);
  if (outputKey === "categories" || outputKey === "category") return normalizeCategory(payload);
  if (outputKey === "adverts" || outputKey === "advert") return normalizeAdvert(payload);
  return payload;
}

function normalizeUser(payload: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    id: optionalInteger(payload.id),
    email: optionalString(payload.email),
    status: optionalString(payload.status),
    name: optionalString(payload.name),
    phone: optionalString(payload.phone),
    createdAt: optionalString(payload.created_at),
    lastLoginAt: optionalString(payload.last_login_at),
    avatar: optionalString(payload.avatar) ?? null,
    isBusiness: typeof payload.is_business === "boolean" ? payload.is_business : undefined,
    raw: payload,
  });
}

function normalizeRegion(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    id: optionalInteger(value.id),
    name: optionalString(value.name),
  };
}

function normalizeCity(value: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    ...value,
    id: optionalInteger(value.id),
    regionId: optionalInteger(value.region_id),
    name: optionalString(value.name),
    county: optionalString(value.county),
    municipality: optionalString(value.municipality),
    latitude: typeof value.latitude === "number" ? value.latitude : undefined,
    longitude: typeof value.longitude === "number" ? value.longitude : undefined,
  });
}

function normalizeCategory(value: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    ...value,
    id: optionalInteger(value.id),
    name: optionalString(value.name),
    parentId: optionalInteger(value.parent_id) ?? null,
    photosLimit: optionalInteger(value.photos_limit),
    isLeaf: typeof value.is_leaf === "boolean" ? value.is_leaf : undefined,
  });
}

function normalizeAdvert(value: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    id: optionalInteger(value.id),
    status: optionalString(value.status),
    url: optionalString(value.url),
    title: optionalString(value.title),
    description: optionalString(value.description),
    categoryId: typeof value.category_id === "number" ? value.category_id : undefined,
    advertiserType: optionalString(value.advertiser_type),
    externalId: optionalString(value.external_id),
    externalUrl: optionalString(value.external_url),
    createdAt: optionalString(value.created_at),
    activatedAt: optionalString(value.activated_at),
    validTo: optionalString(value.valid_to),
    contact: optionalRecord(value.contact),
    location: optionalRecord(value.location),
    price: optionalRecord(value.price) ?? null,
    salary: optionalRecord(value.salary) ?? null,
    images: Array.isArray(value.images) ? value.images : [],
    raw: value,
  });
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new ProviderRequestError(502, "OLX returned a non-array response");
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (record) {
    return record;
  }
  throw new ProviderRequestError(502, `${label} was not an object`);
}

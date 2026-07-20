import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { GooglePlacesActionName } from "./actions.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

export const googlePlacesApiBaseUrl = "https://places.googleapis.com";

type GooglePlacesRequestPhase = "validate" | "execute";
type GooglePlacesActionHandler = (input: Record<string, unknown>, context: ApiKeyProviderContext) => Promise<unknown>;

export const googlePlacesActionHandlers: Record<GooglePlacesActionName, GooglePlacesActionHandler> = {
  search_text(input, context) {
    const { fieldMask, body } = prepareBody(input);
    return googlePlacesRequest("/v1/places:searchText", "POST", fieldMask, body, context, "execute");
  },
  search_nearby(input, context) {
    const { fieldMask, body } = prepareBody(input);
    return googlePlacesRequest("/v1/places:searchNearby", "POST", fieldMask, body, context, "execute");
  },
  get_place_details(input, context) {
    const fieldMask = requireFieldMask(input.fieldMask);
    const placeId = optionalString(input.placeId)?.trim();
    if (!placeId) {
      throw new ProviderRequestError(400, "placeId is required");
    }

    const url = new URL(`/v1/places/${encodeURIComponent(placeId)}`, googlePlacesApiBaseUrl);
    for (const [key, value] of Object.entries({
      languageCode: optionalString(input.languageCode),
      regionCode: optionalString(input.regionCode),
      sessionToken: optionalString(input.sessionToken),
    })) {
      if (value) url.searchParams.set(key, value);
    }
    return googlePlacesRequest(url, "GET", fieldMask, undefined, context, "execute");
  },
};

export async function validateGooglePlacesCredential(
  input: { apiKey: string },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const validationEndpoint = "/v1/places/ChIJj61dQgK6j4AR4GeTYWZsKWw";
  await googlePlacesRequest(
    validationEndpoint,
    "GET",
    "id",
    undefined,
    { apiKey: input.apiKey, fetcher, signal },
    "validate",
  );

  return {
    profile: {
      accountId: "google_places",
      displayName: "Google Places API Key",
    },
    grantedScopes: [],
    metadata: compactObject({
      apiBaseUrl: googlePlacesApiBaseUrl,
      validationEndpoint,
    }),
  };
}

function prepareBody(input: Record<string, unknown>): { fieldMask: string; body: Record<string, unknown> } {
  const fieldMask = requireFieldMask(input.fieldMask);
  const { fieldMask: _fieldMask, ...body } = input;
  return { fieldMask, body };
}

function requireFieldMask(value: unknown): string {
  const fieldMask = optionalString(value)?.trim();
  if (!fieldMask) {
    throw new ProviderRequestError(400, "fieldMask is required");
  }
  if (/\s/.test(fieldMask)) {
    throw new ProviderRequestError(400, "fieldMask must not contain spaces");
  }
  return fieldMask;
}

async function googlePlacesRequest(
  pathOrUrl: string | URL,
  method: "GET" | "POST",
  fieldMask: string,
  body: Record<string, unknown> | undefined,
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  phase: GooglePlacesRequestPhase,
): Promise<Record<string, unknown>> {
  const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, googlePlacesApiBaseUrl);

  let response: Response;
  let payload: unknown;
  try {
    response = await context.fetcher(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        "user-agent": providerUserAgent,
        "x-goog-api-key": context.apiKey,
        "x-goog-fieldmask": fieldMask,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: context.signal,
    });
    payload = await readGooglePlacesPayload(response);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Google Places request failed: ${error.message}` : "Google Places request failed",
    );
  }

  if (!response.ok) {
    throw createGooglePlacesError(response.status, payload, phase);
  }

  const record = optionalRecord(payload);
  if (!record) {
    throw new ProviderRequestError(502, "Google Places response must be an object");
  }
  return record;
}

async function readGooglePlacesPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(502, "Google Places returned invalid JSON");
  }
}

function createGooglePlacesError(
  status: number,
  payload: unknown,
  phase: GooglePlacesRequestPhase,
): ProviderRequestError {
  const message = extractGooglePlacesMessage(payload) ?? `Google Places request failed with ${status || 500}`;

  if (status === 429) return new ProviderRequestError(429, message, payload);
  if (phase === "validate" && (status === 400 || status === 401 || status === 403)) {
    return new ProviderRequestError(400, message, payload);
  }
  if (phase === "execute" && (status === 401 || status === 403)) {
    return new ProviderRequestError(status, message, payload);
  }
  if (status === 400 || status === 422) return new ProviderRequestError(400, message, payload);
  return new ProviderRequestError(status || 502, message, payload);
}

function extractGooglePlacesMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  const error = optionalRecord(record?.error);
  return optionalString(error?.message) ?? optionalString(record?.message);
}

import type { CredentialValidationResult } from "../../core/types.ts";
import type { BoardActionName } from "./actions.ts";

import { objectArray, optionalRecord, optionalString, requiredString, requiredStringArray } from "../../core/cast.ts";
import { assertPublicHttpUrl, encodePathSegment, isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { providerRequest, ProviderRequestError } from "../provider-runtime.ts";

type BoardActionHandler = (input: Record<string, unknown>, context: BoardContext) => Promise<unknown>;

export interface BoardContext {
  baseUrl: string;
  bearerToken?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export const boardActionHandlers: Record<BoardActionName, BoardActionHandler> = {
  list_boards(_input, context) {
    return requestBoardJson(context, "/api/boards", "GET");
  },
  read_board(input, context) {
    return requestBoardJson(context, `/api/boards/${roomId(input)}`, "GET");
  },
  rename_board(input, context) {
    return requestBoardJson(context, `/api/boards/${roomId(input)}`, "PATCH", {
      name: requiredString(input.name, "name", inputError),
    });
  },
  create_or_update_records(input, context) {
    return requestBoardJson(context, `/api/boards/${roomId(input)}/records`, "POST", {
      records: objectArray(input.records, "records", inputError),
    });
  },
  delete_records(input, context) {
    return requestBoardJson(context, `/api/boards/${roomId(input)}/records`, "DELETE", {
      recordIds: requiredStringArray(input.recordIds, "recordIds", inputError),
    });
  },
};

export function createBoardContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): BoardContext {
  const context: BoardContext = {
    baseUrl: normalizeBoardBaseUrl(values.baseUrl),
    fetcher,
    signal,
  };
  const bearerToken = optionalString(values.bearerToken);
  if (bearerToken) context.bearerToken = bearerToken;
  return context;
}

export async function validateBoardCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createBoardContext(values, fetcher, signal);
  const payload = optionalRecord(await requestBoardJson(context, "/api/boards", "GET"));
  if (!payload || !Array.isArray(payload.boards)) {
    throw new ProviderRequestError(400, "Board credential validation returned an unexpected response");
  }
  const host = new URL(context.baseUrl).host;
  return {
    profile: { accountId: `board:${host}`, displayName: `Board ${host}` },
    grantedScopes: [],
    metadata: { baseUrl: context.baseUrl },
  };
}

/** Validate and normalize a self-hosted Board root URL. */
export function normalizeBoardBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const raw = requiredString(value, "baseUrl", credentialError);
  const url = assertPublicHttpUrl(raw, {
    fieldName: "baseUrl",
    createError: credentialError,
    allowPrivateNetwork,
  });
  if (url.username || url.password || url.search || url.hash) {
    throw credentialError("baseUrl must not include credentials, query parameters, or a fragment");
  }
  if (url.pathname.replace(/\/+$/u, "") !== "") {
    throw credentialError("baseUrl must be the Board server root URL");
  }
  return url.origin;
}

async function requestBoardJson(
  context: BoardContext,
  path: string,
  method: "DELETE" | "GET" | "PATCH" | "POST",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (context.bearerToken) headers.authorization = `Bearer ${context.bearerToken}`;
  const response = await providerRequest(
    { fetcher: context.fetcher, signal: context.signal },
    {
      url: new URL(path, `${context.baseUrl}/`),
      method,
      headers,
      body,
      source: "Board",
    },
  );
  return response.data;
}

function roomId(input: Record<string, unknown>): string {
  return encodePathSegment(requiredString(input.roomId, "roomId", inputError));
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

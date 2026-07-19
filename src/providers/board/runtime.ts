import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderFetch } from "../provider-runtime.ts";

import { requiredString } from "../../core/cast.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

export interface BoardContext {
  baseUrl: string;
  token: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
}

export const boardActionHandlers = {
  async list_boards(_input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    return boardRequest(context, "GET", "/api/boards");
  },
  async read_board(input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    const roomId = requiredString(input.roomId, "roomId", boardInputError);
    return boardRequest(context, "GET", `/api/boards/${encodeURIComponent(roomId)}`);
  },
  async get_board_snapshot(input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    const roomId = requiredString(input.roomId, "roomId", boardInputError);
    return boardRequest(context, "GET", `/api/boards/${encodeURIComponent(roomId)}/snapshot`);
  },
  async rename_board(input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    const roomId = requiredString(input.roomId, "roomId", boardInputError);
    return boardRequest(context, "PATCH", `/api/boards/${encodeURIComponent(roomId)}`, {
      name: requiredString(input.name, "name", boardInputError),
    });
  },
  async create_or_update_records(input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    const roomId = requiredString(input.roomId, "roomId", boardInputError);
    return boardRequest(context, "POST", `/api/boards/${encodeURIComponent(roomId)}/records`, {
      records: input.records,
    });
  },
  async delete_records(input: Record<string, unknown>, context: BoardContext): Promise<unknown> {
    const roomId = requiredString(input.roomId, "roomId", boardInputError);
    return boardRequest(context, "DELETE", `/api/boards/${encodeURIComponent(roomId)}/records`, {
      recordIds: input.recordIds,
    });
  },
};

export function normalizeBoardBaseUrl(value: unknown): string {
  const raw = requiredString(value, "boardUrl", boardInputError).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "boardUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "boardUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "boardUrl must not include credentials, query parameters, or a fragment");
  }
  if (url.pathname.replace(/\/+$/u, "") !== "") {
    throw new ProviderRequestError(400, "boardUrl must be the Board server root URL");
  }
  return url.origin;
}

export async function validateBoardCredential(
  values: Record<string, string>,
  token: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context: BoardContext = {
    baseUrl: normalizeBoardBaseUrl(values.boardUrl),
    token,
    fetcher,
    signal,
  };
  const session = (await boardRequest(context, "GET", "/api/auth/session")) as {
    workspaceId?: string;
    workspaceName?: string;
    authType?: string;
  };
  return {
    profile: {
      accountId: session.workspaceId ?? "board-workspace",
      displayName: session.workspaceName ? `Board: ${session.workspaceName}` : "Board workspace",
    },
    grantedScopes: session.authType === "integration_token" ? ["workspace"] : [],
    metadata: { boardUrl: context.baseUrl },
  };
}

async function boardRequest(context: BoardContext, method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const url = new URL(endpoint, `${context.baseUrl}/`);
  const headers = new Headers({ accept: "application/json", authorization: `Bearer ${context.token}` });
  const init: RequestInit = { method, headers, signal: context.signal };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const response = await context.fetcher(url, init);
  const text = await response.text();
  const payload = text ? readJson(text) : undefined;
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Board request failed with HTTP ${response.status}`;
    throw new ProviderRequestError(response.status, message, payload);
  }
  return payload ?? {};
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(502, "Board returned a non-JSON response");
  }
}

function boardInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

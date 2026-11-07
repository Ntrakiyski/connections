export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestOptions {
  workspaceId?: string;
  signal?: AbortSignal;
}

export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      headers: headersFor(path, options),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    }),
    options.signal,
  );
}

export async function apiPost<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: "POST",
      headers: headersFor(path, options, true),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      body: JSON.stringify(body),
    }),
    options.signal,
  );
}

export async function apiPut<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: "PUT",
      headers: headersFor(path, options, true),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      body: JSON.stringify(body),
    }),
    options.signal,
  );
}

export async function apiPatch<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: "PATCH",
      headers: headersFor(path, options, true),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      body: JSON.stringify(body),
    }),
    options.signal,
  );
}

export async function apiDelete<T = unknown>(path: string, options: RequestOptions = {}, body?: unknown): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: "DELETE",
      headers: headersFor(path, options, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    }),
    options.signal,
  );
}

function headersFor(path: string, options: RequestOptions, json = false): Headers {
  options.signal?.throwIfAborted();
  const accountPath =
    /^\/api\/(identity(?:\/|$)|account(?:\/|$)|companies(?:\/|$)|company-invitations(?:\/|$)|auth\/logout(?:\?|$))/.test(
      path,
    );
  if (!accountPath && !options.workspaceId) throw new ApiError(400, "Choose a workspace before making this request.");
  const headers = new Headers();
  if (json) {
    headers.set("content-type", "application/json");
  }
  if (options.workspaceId) headers.set("x-workspace-id", options.workspaceId);
  return headers;
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  signal?.throwIfAborted();
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined")
      window.dispatchEvent(new Event("connections-session-invalidated"));
    throw new ApiError(response.status, errorMessage(payload) ?? `Request failed with ${response.status}`);
  }
  return payload as T;
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  if ("errorMessage" in payload && typeof payload.errorMessage === "string") {
    return payload.errorMessage;
  }
  if ("message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  if ("error" in payload && payload.error && typeof payload.error === "object") {
    const error = payload.error as { message?: unknown };
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}

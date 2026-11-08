export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatementBinding;
  batch<T = never>(statements: D1PreparedStatementBinding[]): Promise<D1RunResult<T>[]>;
  exec?(query: string): Promise<unknown>;
}

export interface D1RunResult<T = never> {
  success: boolean;
  results?: T[];
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementBinding {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: D1RunResult["meta"] }>;
  run(): Promise<D1RunResult>;
}

export interface R2BucketBinding {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: unknown,
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBinding | null>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectBinding {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface KVNamespaceBinding {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void>;
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

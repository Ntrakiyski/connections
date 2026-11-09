import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  isWorkflowEditorRequest,
  workflowConnectorToken,
  workflowScope,
  workflowScopeId,
  workflowSecretEqual,
} from "./workflow-runtime.ts";

const {
  CONNECTIONS_WORKFLOW_POOL_SECRET: secret,
  OPEN_FLOW_CONNECTOR_ORIGIN: connector,
  OPEN_FLOW_CONNECTOR_CONSOLE_ORIGIN: consoleOrigin,
} = process.env;
if (!secret || Buffer.byteLength(secret) < 32 || !connector || !consoleOrigin)
  throw new Error("Missing private workflow pool configuration");

const root = process.env.OPEN_FLOW_DATA_DIR ?? "/data/open-flow";
const scopes = new Map();
const workers = new Map();
const ports = new Set();
let stopping = false;

function reservePort() {
  for (let port = 4000; port < 4048; port++) {
    if (!ports.has(port)) {
      ports.add(port);
      return port;
    }
  }
  throw new Error("No workflow runner slots available");
}

async function workspaceStatus(scope) {
  const response = await fetch(new URL("/v1/health", connector), {
    headers: { authorization: `Bearer ${workflowConnectorToken(scope, secret)}` },
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  await response?.body?.cancel();
  return response?.status;
}

async function start(scope, id, worker) {
  if ((await workspaceStatus(scope)) !== 200 || stopping) throw new Error("The workspace is unavailable");
  const dir = join(root, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!scopes.has(id)) {
    const pending = join(dir, "scope.pending.json");
    await writeFile(pending, JSON.stringify(scope), { mode: 0o600 });
    await rename(pending, join(dir, "scope.json"));
  }
  scopes.set(id, scope);
  if (stopping) throw new Error("The workflow pool is shutting down");

  const port = reservePort();
  const token = randomBytes(32).toString("base64url");
  worker.origin = `http://127.0.0.1:${port}`;
  worker.token = token;
  const child = spawn(process.execPath, ["--no-node-snapshot", "server/main.js"], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OPEN_FLOW_DATA_DIR: dir,
      OPEN_FLOW_HOST: "127.0.0.1",
      OPEN_FLOW_PORT: String(port),
      OPEN_FLOW_TOKEN: token,
      OPEN_FLOW_CONNECTOR_ORIGIN: connector,
      OPEN_FLOW_CONNECTOR_CONSOLE_ORIGIN: consoleOrigin,
      OPEN_FLOW_CONNECTOR_TOKEN: workflowConnectorToken(scope, secret),
      OPEN_FLOW_SESSION_COOKIE_SECURE: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  worker.child = child;
  child.on("error", () => console.error("Workflow runner process failed to start"));
  worker.closed = new Promise((resolve) =>
    child.once("close", () => {
      ports.delete(port);
      workers.delete(id);
      resolve();
    }),
  );

  for (let attempt = 0; attempt < 60 && workers.get(id) === worker && !stopping; attempt++) {
    const response = await fetch(worker.origin + "/healthz", { signal: AbortSignal.timeout(1000) }).catch(
      () => undefined,
    );
    await response?.body?.cancel();
    if (response?.ok) return worker;
    await delay(200);
  }
  child.kill("SIGTERM");
  throw new Error("The workflow runner did not become healthy");
}

function ensureWorker(scope, id) {
  let worker = workers.get(id);
  if (!worker) {
    worker = {};
    workers.set(id, worker);
    const current = worker;
    current.ready = start(scope, id, current).catch((error) => {
      if (!current.child) workers.delete(id);
      throw error;
    });
  }
  return worker.ready;
}

await mkdir(root, { recursive: true, mode: 0o700 });
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
  try {
    const { workspaceId, userId } = JSON.parse(await readFile(join(root, entry.name, "scope.json"), "utf8"));
    const scope = workflowScope(workspaceId, userId);
    if (scope && workflowScopeId(scope) === entry.name) scopes.set(entry.name, scope);
  } catch {
    console.error("Could not load one persisted workflow scope");
  }
}

let reconciling = false;
async function reconcile() {
  if (reconciling || stopping) return;
  reconciling = true;
  try {
    await Promise.allSettled(
      Array.from(scopes, async ([id, scope]) => {
        const status = await workspaceStatus(scope);
        const worker = workers.get(id);
        if (stopping) return;
        if (status === 401 || status === 403) worker?.child?.kill("SIGTERM");
        else if (status === 200 && !worker) await ensureWorker(scope, id);
      }),
    );
  } finally {
    reconciling = false;
  }
}

const forwarded = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "idempotency-key",
  "x-open-flow-client",
];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://pool.internal");
    if (url.pathname === "/healthz") return response.writeHead(stopping ? 503 : 200).end();
    if (!workflowSecretEqual(request.headers.authorization ?? "", `Bearer ${secret}`))
      return response.writeHead(401).end();
    const scope = workflowScope(
      request.headers["x-connections-workspace-id"],
      request.headers["x-connections-user-id"],
    );
    if (!scope) return response.writeHead(400).end();
    const id = workflowScopeId(scope);
    if (stopping) return response.writeHead(503).end();
    if (url.pathname === "/provision" && request.method === "POST") {
      await ensureWorker(scope, id);
      return response.writeHead(204).end();
    }
    if (!scopes.has(id) || !isWorkflowEditorRequest(url.pathname, request.method)) return response.writeHead(404).end();

    const worker = await ensureWorker(scope, id);
    const headers = new Headers({ authorization: `Bearer ${worker.token}` });
    for (const name of forwarded) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const destination = new URL(worker.origin);
    destination.pathname = url.pathname;
    destination.search = url.search;
    const cancel = new AbortController();
    response.once("close", () => cancel.abort());
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(60_000)]),
    });
    response.writeHead(
      upstream.status,
      Object.fromEntries(
        [...upstream.headers].filter(([name]) =>
          ["content-type", "content-disposition", "etag", "retry-after"].includes(name),
        ),
      ),
    );
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (response.headersSent) response.destroy();
    else response.writeHead(503).end();
  }
});

server.listen(3000, "0.0.0.0");
const timer = setInterval(() => void reconcile(), 15_000);
void reconcile();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close();
  server.closeAllConnections();
  await Promise.allSettled(
    Array.from(workers.values(), async (worker) => {
      worker.child?.kill("SIGTERM");
      await worker.closed;
    }),
  );
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

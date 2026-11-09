import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface WorkflowScope {
  workspaceId: string;
  userId: string;
}

export interface WorkflowPool {
  origin: string;
  secret: string;
}

const id = /^[A-Za-z0-9_-]{1,128}$/;
const editorApi = /^\/v1\/(?:flows|runs|tags|variables|trigger-keys)(?:\/|$)/;
const connectorReads =
  /^\/v1\/connector\/(?:proxy\/(?:providers|actions)|providers|actions(?:\/[^/]+)?|action-metadata(?:\/[^/]+)?|connections(?:\/[^/]+)?|leina\/bots)$/;

export function workflowScope(workspaceId: unknown, userId: unknown): WorkflowScope | undefined {
  if (typeof workspaceId === "string" && typeof userId === "string" && id.test(workspaceId) && id.test(userId)) {
    return { workspaceId, userId };
  }
}

export function workflowScopeId(scope: WorkflowScope): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.workspaceId, scope.userId]))
    .digest("hex");
}

export function workflowSecretEqual(actual: string, expected: string): boolean {
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}

export function workflowConnectorToken(scope: WorkflowScope, secret: string): string {
  const payload = Buffer.from(JSON.stringify([scope.workspaceId, scope.userId])).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update("connector-workflow-v1:" + payload)
    .digest("base64url");
  return `ocw_${payload}.${signature}`;
}

export function verifyWorkflowConnectorToken(token: string, secret: string): WorkflowScope | undefined {
  const match = /^ocw_([A-Za-z0-9_-]{1,360})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match?.[1]) return;
  try {
    const value: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return;
    const scope = workflowScope(value[0], value[1]);
    if (scope && workflowSecretEqual(token, workflowConnectorToken(scope, secret))) return scope;
  } catch {
    return;
  }
}

export function isWorkflowEditorRequest(path: string, method: string): boolean {
  if (/%(?:2f|5c|25|00)/i.test(path)) return false;
  return editorApi.test(path) || ((method === "GET" || method === "HEAD") && connectorReads.test(path));
}

export function parseWorkflowPool(origin: string | undefined, secret: string | undefined): WorkflowPool | undefined {
  if (!origin && !secret) return;
  if (!origin || !secret || Buffer.byteLength(secret) < 32)
    throw new Error("The workflow pool requires an origin and a private secret.");
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid workflow pool origin.");
  return { origin, secret };
}

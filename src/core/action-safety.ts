import type { ActionDefinition, ActionRiskTag, IdempotencySupport } from "./types.ts";

export type { ActionRiskTag, IdempotencySupport } from "./types.ts";
export type SafetyMode = "observe" | "enforce";
export type RetryMode = "observe" | "enforce";

export interface ActionSafetyMetadata {
  riskTags: ActionRiskTag[];
  idempotency: IdempotencySupport;
  retryable: boolean;
}

export interface SafetyFeatureConfig {
  mode: SafetyMode;
}

export interface RateLimitSafetyConfig {
  mode: SafetyMode;
  maxConcurrent: number;
}

export interface RetrySafetyConfig {
  mode: RetryMode;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface WorkspaceSafetyConfig {
  scopePreflight: SafetyFeatureConfig;
  idempotency: SafetyFeatureConfig;
  retry: RetrySafetyConfig;
  rateLimit: RateLimitSafetyConfig;
}

export type WorkspaceSafetyConfigPatch = {
  scopePreflight?: Partial<SafetyFeatureConfig>;
  idempotency?: Partial<SafetyFeatureConfig>;
  retry?: Partial<RetrySafetyConfig>;
  rateLimit?: Partial<RateLimitSafetyConfig>;
};

export interface ResolvedProviderSafetyConfig {
  workspace: WorkspaceSafetyConfig;
  provider?: WorkspaceSafetyConfigPatch;
  resolved: WorkspaceSafetyConfig;
}

const readVerbs = new Set(["get", "list", "read", "retrieve", "search", "find", "lookup", "check", "preview"]);
const writeVerbs = new Set([
  "add",
  "append",
  "apply",
  "assign",
  "attach",
  "create",
  "edit",
  "import",
  "insert",
  "mark",
  "merge",
  "modify",
  "move",
  "post",
  "publish",
  "put",
  "rename",
  "replace",
  "reply",
  "restore",
  "save",
  "schedule",
  "set",
  "share",
  "submit",
  "tag",
  "toggle",
  "transfer",
  "trigger",
  "unarchive",
  "upsert",
  "update",
  "upload",
  "write",
]);
const deleteVerbs = new Set([
  "archive",
  "ban",
  "cancel",
  "clear",
  "close",
  "delete",
  "detach",
  "disable",
  "purge",
  "remove",
  "revoke",
  "stop",
  "suspend",
  "unban",
  "void",
]);
const sendVerbs = new Set(["email", "forward", "invite", "message", "notify", "reply", "send", "sms"]);
const purchaseVerbs = new Set(["buy", "charge", "checkout", "invoice", "pay", "payment", "purchase", "refund"]);
const adminVerbs = new Set([
  "admin",
  "approve",
  "configure",
  "permission",
  "policy",
  "role",
  "scope",
  "setting",
  "user",
]);

export const defaultWorkspaceSafetyConfig: WorkspaceSafetyConfig = {
  scopePreflight: { mode: "observe" },
  idempotency: { mode: "observe" },
  retry: {
    mode: "observe",
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  },
  rateLimit: { mode: "observe", maxConcurrent: 4 },
};

export function resolveWorkspaceSafetyConfig(
  workspace: WorkspaceSafetyConfigPatch | undefined,
  provider: WorkspaceSafetyConfigPatch | undefined,
): ResolvedProviderSafetyConfig {
  const workspaceConfig = mergeSafetyConfig(defaultWorkspaceSafetyConfig, workspace);
  return {
    workspace: workspaceConfig,
    provider,
    resolved: mergeSafetyConfig(workspaceConfig, provider),
  };
}

export function mergeSafetyConfig(
  base: WorkspaceSafetyConfig,
  patch: WorkspaceSafetyConfigPatch | undefined,
): WorkspaceSafetyConfig {
  return {
    scopePreflight: { ...base.scopePreflight, ...patch?.scopePreflight },
    idempotency: { ...base.idempotency, ...patch?.idempotency },
    retry: { ...base.retry, ...patch?.retry },
    rateLimit: { ...base.rateLimit, ...patch?.rateLimit },
  };
}

export function normalizeSafetyConfigPatch(value: unknown): WorkspaceSafetyConfigPatch {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const patch: WorkspaceSafetyConfigPatch = {};
  const scopePreflight = normalizeFeatureConfig(record.scopePreflight);
  const idempotency = normalizeFeatureConfig(record.idempotency);
  const retry = normalizeRetryConfig(record.retry);
  const rateLimit = normalizeRateLimitConfig(record.rateLimit);
  if (scopePreflight) patch.scopePreflight = scopePreflight;
  if (idempotency) patch.idempotency = idempotency;
  if (retry) patch.retry = retry;
  if (rateLimit) patch.rateLimit = rateLimit;
  return patch;
}

export function actionSafetyMetadata(action: ActionDefinition): ActionSafetyMetadata {
  const riskTags = uniqueRiskTags(action.riskTags?.length ? action.riskTags : inferActionRiskTags(action));
  const idempotency = action.idempotency ?? (isReadOnly(riskTags) ? "not_supported" : "optional");
  return {
    riskTags,
    idempotency,
    retryable: isReadOnly(riskTags),
  };
}

export function inferActionRiskTags(action: Pick<ActionDefinition, "id" | "name">): ActionRiskTag[] {
  const words = actionWords(`${action.id} ${action.name}`);
  const tags = new Set<ActionRiskTag>();
  if (words.some((word) => sendVerbs.has(word))) tags.add("send");
  if (words.some((word) => purchaseVerbs.has(word))) tags.add("purchase");
  if (words.some((word) => adminVerbs.has(word))) tags.add("admin");
  if (words.some((word) => deleteVerbs.has(word))) {
    tags.add("delete");
    tags.add("irreversible");
  }
  if (words.some((word) => writeVerbs.has(word))) tags.add("write");
  if (tags.size === 0 && words.some((word) => readVerbs.has(word))) tags.add("read");
  if (tags.size === 0) tags.add("write");
  return [...tags];
}

export function isReadOnly(riskTags: readonly ActionRiskTag[]): boolean {
  return riskTags.length === 1 && riskTags[0] === "read";
}

function actionWords(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function uniqueRiskTags(tags: readonly string[]): ActionRiskTag[] {
  return [...new Set(tags.filter((tag): tag is ActionRiskTag => isRiskTag(tag)))];
}

function isRiskTag(value: string): value is ActionRiskTag {
  return ["read", "write", "delete", "send", "purchase", "admin", "irreversible"].includes(value);
}

function normalizeFeatureConfig(value: unknown): Partial<SafetyFeatureConfig> | undefined {
  const record = optionalRecord(value);
  const mode = normalizeSafetyMode(record?.mode);
  return mode ? { mode } : undefined;
}

function normalizeRetryConfig(value: unknown): Partial<RetrySafetyConfig> | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const retry: Partial<RetrySafetyConfig> = {};
  const mode = normalizeRetryMode(record.mode);
  const maxAttempts = positiveInteger(record.maxAttempts);
  const baseDelayMs = positiveInteger(record.baseDelayMs);
  const maxDelayMs = positiveInteger(record.maxDelayMs);
  if (mode) retry.mode = mode;
  if (maxAttempts !== undefined) retry.maxAttempts = maxAttempts;
  if (baseDelayMs !== undefined) retry.baseDelayMs = baseDelayMs;
  if (maxDelayMs !== undefined) retry.maxDelayMs = maxDelayMs;
  return Object.keys(retry).length > 0 ? retry : undefined;
}

function normalizeRateLimitConfig(value: unknown): Partial<RateLimitSafetyConfig> | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const rateLimit: Partial<RateLimitSafetyConfig> = {};
  const mode = normalizeSafetyMode(record.mode);
  const maxConcurrent = positiveInteger(record.maxConcurrent);
  if (mode) rateLimit.mode = mode;
  if (maxConcurrent !== undefined) rateLimit.maxConcurrent = maxConcurrent;
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

function normalizeSafetyMode(value: unknown): SafetyMode | undefined {
  return value === "observe" || value === "enforce" ? value : undefined;
}

function normalizeRetryMode(value: unknown): RetryMode | undefined {
  return value === "observe" || value === "enforce" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

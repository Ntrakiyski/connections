import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionPolicyService } from "../../core/action-policy.ts";
import type { ActionRiskTag, WorkspaceSafetyConfig } from "../../core/action-safety.ts";
import type { ExecutionContext, ExecutionResult, TransitFileWriter } from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { ITransitFileService } from "../files/transit-file-store.ts";
import type { Logger } from "../logger.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogCaller } from "../storage/runtime-store.ts";
import type { WorkspaceRole } from "../storage/runtime-token-service.ts";
import type { WorkspaceControlService } from "../workspace-control-service.ts";

import { defaultWorkspaceSafetyConfig, isReadOnly } from "../../core/action-safety.ts";
import { executeAction as executeProviderAction } from "../../core/execution.ts";
import { summarizeForRunLog } from "./run-log-summary.ts";

export interface ActionRunnerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  runs: IRunLogStore;
  transitFiles?: ITransitFileService;
  actionPolicy?: ActionPolicyService;
  controls?: WorkspaceControlService;
  logger?: Logger;
  workspace?: ActionRunnerWorkspace;
  createWorkspaceRunner?(workspaceId: string): ActionRunner;
}

export interface ActionRunnerWorkspace {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface RunActionInput {
  actionId: string;
  input: unknown;
  caller: RunLogCaller;
  connectionName?: string;
  idempotencyKey?: string;
}

export interface ActionRunResult {
  executionId: string;
  result: ExecutionResult;
}

/**
 * Shared execution boundary for HTTP, MCP, and future local callers.
 */
export class ActionRunner {
  private readonly options: ActionRunnerOptions;

  constructor(options: ActionRunnerOptions) {
    this.options = options;
  }

  /** Returns the workspace-bound runner when the runtime provides scoped stores. */
  forWorkspace(workspaceId: string): ActionRunner {
    return this.options.createWorkspaceRunner?.(workspaceId) ?? this;
  }

  async run(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    if (!action) {
      this.options.logger?.warn(
        {
          actionId: input.actionId,
          caller: input.caller,
          connectionName: input.connectionName,
          errorCode: "invalid_input",
        },
        "action run rejected",
      );
      return undefined;
    }

    const logContext = {
      actionId: action.id,
      service: action.service,
      caller: input.caller,
      connectionName: input.connectionName,
    };
    this.options.logger?.info(logContext, "action run started");
    const connection = await this.options.connections.getConnectionSummary(action.service, input.connectionName);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const executionId = crypto.randomUUID();
    const safetyConfig = await this.resolveSafetyConfig(action.service);
    const safety = action.safety;
    const scopePreflight = evaluateScopePreflight(action.requiredScopes, connection?.profile.grantedScopes ?? []);
    let idempotencyStatus: NonNullable<RunLog["safety"]>["idempotency"] = input.idempotencyKey ? "observed" : "none";
    const normalizedConnectionName = input.connectionName ?? connection?.connectionName ?? "default";
    const inputHash = input.idempotencyKey ? await hashStableJson(input.input) : undefined;
    let replayedResult: ExecutionResult | undefined;
    if (this.shouldApplyIdempotency(input.idempotencyKey, safetyConfig, safety.riskTags, safety.idempotency)) {
      const existing = await this.options.controls?.getIdempotencyRecord(
        action.id,
        normalizedConnectionName,
        input.idempotencyKey!,
      );
      if (existing) {
        if (existing.inputHash === inputHash) {
          idempotencyStatus = "replayed";
          replayedResult = existing.result as ExecutionResult;
        } else {
          idempotencyStatus = "conflict";
        }
      }
    }
    const executor = action.execution.locallyExecutable
      ? await this.options.providerLoader.loadActionExecutor(
          action.service,
          action.id,
          this.options.catalog.providers.find((provider) => provider.service === action.service)?.displayName,
        )
      : undefined;
    let retryCount = 0;
    const result =
      replayedResult ??
      (idempotencyStatus === "conflict"
        ? idempotencyConflictResult()
        : shouldBlockForMissingIdempotency(input.idempotencyKey, safetyConfig, safety.riskTags, safety.idempotency)
          ? missingIdempotencyKeyResult()
          : shouldBlockForMissingScopes(scopePreflight, safetyConfig)
            ? missingScopesResult(action.requiredScopes, connection?.profile.grantedScopes ?? [])
            : await executeWithinRateLimit(
                rateLimitKey(this.options.workspace?.workspaceId ?? "default", action.service),
                safetyConfig,
                () =>
                  this.executeWithRetry(
                    () =>
                      executeProviderAction(
                        action,
                        executor,
                        input.input,
                        this.createExecutionContext(input.connectionName),
                        this.options.actionPolicy,
                      ),
                    safetyConfig,
                    safety.riskTags,
                    input.idempotencyKey,
                    safety.idempotency,
                    (attempts) => {
                      retryCount = attempts;
                    },
                  ),
              ));
    const completedAtMs = Date.now();
    if (
      result.ok &&
      !replayedResult &&
      this.shouldApplyIdempotency(input.idempotencyKey, safetyConfig, safety.riskTags, safety.idempotency) &&
      inputHash
    ) {
      await this.options.controls?.setIdempotencyRecord({
        actionId: action.id,
        connectionName: normalizedConnectionName,
        idempotencyKey: input.idempotencyKey!,
        inputHash,
        executionId,
        result,
      });
      idempotencyStatus = "stored";
    }

    await this.options.runs.add({
      id: executionId,
      workspaceId: this.options.workspace?.workspaceId ?? "default",
      userId: this.options.workspace?.userId ?? "local-dev",
      service: action.service,
      actionId: input.actionId,
      caller: input.caller,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      ok: result.ok,
      connectionProfile: connection?.profile,
      inputSummary: summarizeForRunLog(input.input),
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      safety: this.createRunSafety(action.safety.riskTags, scopePreflight, idempotencyStatus, retryCount),
    });

    const completedLogContext = {
      ...logContext,
      executionId,
      durationMs: completedAtMs - startedAtMs,
      ok: result.ok,
      errorCode: result.error?.code,
    };
    if (result.ok) {
      this.options.logger?.info(completedLogContext, "action run completed");
    } else {
      this.options.logger?.warn(completedLogContext, "action run failed");
    }

    return { executionId, result };
  }

  listRuns(input?: RunLogListInput): Promise<RunLogPage> {
    const query: RunLogListInput = input ? { ...input } : {};
    if (this.options.workspace?.role === "member") {
      query.userId = this.options.workspace.userId;
    }
    return this.options.runs.list(query);
  }

  private createExecutionContext(connectionName: string | undefined): ExecutionContext {
    const context: ExecutionContext = {
      ...this.options.connections.forConnection(connectionName),
    };
    if (this.options.workspace) {
      context.identity = {
        workspaceId: this.options.workspace.workspaceId,
        userId: this.options.workspace.userId,
        role: this.options.workspace.role,
      };
    }
    if (this.options.transitFiles) {
      context.transitFiles = this.createTransitFileWriter(this.options.transitFiles);
    }
    return context;
  }

  private async resolveSafetyConfig(service: string): Promise<WorkspaceSafetyConfig> {
    return (await this.options.controls?.getProviderSafetyConfig(service))?.resolved ?? defaultWorkspaceSafetyConfig;
  }

  private shouldApplyIdempotency(
    key: string | undefined,
    config: WorkspaceSafetyConfig,
    riskTags: readonly ActionRiskTag[],
    support: string,
  ): boolean {
    return Boolean(
      key &&
      config.idempotency.mode === "enforce" &&
      support !== "not_supported" &&
      (!isReadOnly(riskTags) || support === "required"),
    );
  }

  private async executeWithRetry(
    execute: () => Promise<ExecutionResult>,
    config: WorkspaceSafetyConfig,
    riskTags: readonly ActionRiskTag[],
    idempotencyKey: string | undefined,
    idempotency: string,
    onRetryCount: (retryCount: number) => void,
  ): Promise<ExecutionResult> {
    const canRetryWrite = Boolean(idempotencyKey && idempotency === "required");
    const canRetry = config.retry.mode === "enforce" && (isReadOnly(riskTags) || canRetryWrite);
    const maxAttempts = canRetry ? Math.max(1, config.retry.maxAttempts) : 1;
    let attempt = 0;
    while (true) {
      const result = await execute();
      if (result.ok || attempt >= maxAttempts - 1 || !isRetryableResult(result)) {
        onRetryCount(attempt);
        return result;
      }
      attempt += 1;
      await sleep(Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  private createRunSafety(
    riskTags: string[],
    scopePreflight: "not_required" | "passed" | "missing" | "unknown",
    idempotency: "none" | "observed" | "stored" | "replayed" | "conflict",
    retryCount: number,
  ): NonNullable<RunLog["safety"]> {
    return {
      riskTags,
      scopePreflight,
      idempotency,
      retryCount,
    };
  }

  private createTransitFileWriter(transitFiles: ITransitFileService): TransitFileWriter {
    const workspace = this.options.workspace;
    const access = workspace
      ? {
          workspaceId: workspace.workspaceId,
          userId: workspace.userId,
          canManageWorkspace: workspace.role !== "member",
        }
      : undefined;
    return {
      maxBytes: transitFiles.maxBytes,
      create: async (file) => await transitFiles.create(file, access),
      read: async (fileId) => await transitFiles.read(fileId, access),
      delete: async (fileId) => await transitFiles.delete(fileId, access),
    };
  }
}

type ScopePreflightStatus = NonNullable<RunLog["safety"]>["scopePreflight"];
type RateLimitRelease = () => void;
type RateLimiterState = {
  active: number;
  queue: Array<(release: RateLimitRelease) => void>;
};

const rateLimiters = new Map<string, RateLimiterState>();

function evaluateScopePreflight(requiredScopes: string[], grantedScopes: string[]): ScopePreflightStatus {
  if (requiredScopes.length === 0) {
    return "not_required";
  }
  if (grantedScopes.length === 0) {
    return "unknown";
  }
  const granted = new Set(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope)) ? "passed" : "missing";
}

function shouldBlockForMissingScopes(status: ScopePreflightStatus, config: WorkspaceSafetyConfig): boolean {
  return config.scopePreflight.mode === "enforce" && status === "missing";
}

function shouldBlockForMissingIdempotency(
  key: string | undefined,
  config: WorkspaceSafetyConfig,
  riskTags: readonly ActionRiskTag[],
  support: string,
): boolean {
  return Boolean(config.idempotency.mode === "enforce" && support === "required" && !key && !isReadOnly(riskTags));
}

function missingScopesResult(requiredScopes: string[], grantedScopes: string[]): ExecutionResult {
  const granted = new Set(grantedScopes);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  return {
    ok: false,
    error: {
      code: "authorization_failed",
      message: `Reconnect with missing provider scopes: ${missing.join(", ")}.`,
      details: { requiredScopes, grantedScopes, missingScopes: missing },
    },
  };
}

function missingIdempotencyKeyResult(): ExecutionResult {
  return {
    ok: false,
    error: {
      code: "idempotency_key_required",
      message: "idempotencyKey is required for this action.",
    },
  };
}

function idempotencyConflictResult(): ExecutionResult {
  return {
    ok: false,
    error: {
      code: "idempotency_conflict",
      message: "idempotencyKey was already used with different action input.",
    },
  };
}

function isRetryableResult(result: ExecutionResult): boolean {
  return result.error?.code === "rate_limited" || result.error?.code === "provider_error";
}

async function executeWithinRateLimit<T>(
  key: string,
  config: WorkspaceSafetyConfig,
  execute: () => Promise<T>,
): Promise<T> {
  if (config.rateLimit.mode !== "enforce") {
    return await execute();
  }
  const release = await acquireRateLimit(key, Math.max(1, config.rateLimit.maxConcurrent));
  try {
    return await execute();
  } finally {
    release();
  }
}

function acquireRateLimit(key: string, maxConcurrent: number): Promise<RateLimitRelease> {
  const state = rateLimiters.get(key) ?? { active: 0, queue: [] };
  rateLimiters.set(key, state);
  if (state.active < maxConcurrent) {
    state.active += 1;
    return Promise.resolve(() => releaseRateLimit(key));
  }
  return new Promise((resolve) => state.queue.push(resolve));
}

function releaseRateLimit(key: string): void {
  const state = rateLimiters.get(key);
  if (!state) return;
  const next = state.queue.shift();
  if (next) {
    next(() => releaseRateLimit(key));
    return;
  }
  state.active -= 1;
  if (state.active <= 0) {
    rateLimiters.delete(key);
  }
}

function rateLimitKey(workspaceId: string, service: string): string {
  return `${workspaceId}:${service}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hashStableJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

import type { CatalogStore, RuntimeActionDefinition } from "./catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "./connection-service.ts";
import type { ActionPolicyService } from "./core/action-policy.ts";
import type { ActionSearchIndexProvider } from "./core/action-search.ts";
import type { JsonSchema, ProviderDefinition } from "./core/types.ts";
import type { IProviderLoader } from "./providers/provider-loader.ts";
import type { ActionRunner } from "./server/actions/action-runner.ts";
import type { AutomationService } from "./server/automations/automation-service.ts";
import type { GmailDraftAutomationDefinition, AutomationScheduleInput } from "./server/automations/automation-store.ts";
import type { WorkspaceContext } from "./server/storage/runtime-token-service.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ConnectionError } from "./connection-service.ts";
import { createActionSearchIndexProvider, searchActions as searchActionIndex } from "./core/action-search.ts";
import { renderActionMarkdown } from "./server/api/action-markdown.ts";

/**
 * Dependencies required by the local MCP server.
 */
export interface IMcpServerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  actions: ActionRunner;
  actionPolicy?: ActionPolicyService;
  actionSearch?: ActionSearchIndexProvider;
  workspaceContext?: WorkspaceContext;
  isProviderEnabled?(service: string): Promise<boolean>;
  requireApproval?(action: RuntimeActionDefinition): Promise<boolean>;
  automation?: AutomationService;
}

/**
 * Compact tool descriptor used by HTTP previews and docs.
 */
export interface IMcpToolSummary {
  name: string;
  title: string;
  description: string;
}

const mcpToolSummaries: IMcpToolSummary[] = [
  {
    name: "list_apps",
    title: "List Apps",
    description: "List available provider apps with connection and action counts.",
  },
  {
    name: "search_actions",
    title: "Search Actions",
    description: "Search catalog actions by query and optional provider service id.",
  },
  {
    name: "get_action_guide",
    title: "Get Action Guide",
    description: "Return the compact markdown guide for one action, including examples and parameters.",
  },
  {
    name: "execute_action",
    title: "Execute Action",
    description: "Execute one local provider action by id with a JSON input object.",
  },
  {
    name: "list_automations",
    title: "List Automations",
    description: "List workspace automation drafts and live versions.",
  },
  { name: "get_automation", title: "Get Automation", description: "Read an automation, schedules, and recent runs." },
  { name: "build_automation", title: "Build Automation", description: "Create a Gmail draft automation draft." },
  {
    name: "edit_automation_draft",
    title: "Edit Automation Draft",
    description: "Replace a Gmail draft automation definition.",
  },
  {
    name: "test_automation",
    title: "Test Automation",
    description: "Create one real Gmail draft from a draft automation without scheduling it.",
  },
  {
    name: "publish_automation",
    title: "Publish Automation",
    description: "Publish a tested draft after explicit confirmation.",
  },
  { name: "run_automation", title: "Run Automation", description: "Create a scheduled Gmail draft run." },
  { name: "stop_automation_schedule", title: "Stop Automation Schedule", description: "Stop a future schedule." },
  {
    name: "disable_automation",
    title: "Disable Automation",
    description: "Disable an automation and all future schedules.",
  },
  { name: "get_automation_runs", title: "Get Automation Runs", description: "List automation run history." },
];

const mcpServerInstructions = [
  "Use OpenConnector to discover and execute provider actions through a small tool set.",
  "Start with list_apps or search_actions.",
  "Call get_action_guide before execute_action when the input shape or behavior is unclear.",
  "Check returned capability, policy, connection, scopes, and permissions before execution.",
  "When capability.requireApproval is true, ask the user for explicit approval in the current conversation before calling execute_action. Do not execute until they approve.",
  "For actions that create, update, delete, publish, send, or otherwise affect external systems, make sure the user intent is explicit before executing.",
  "Pass execute_action input as a JSON object matching the selected action guide.",
  "For execute_action, always pass the exact connectionName returned for the selected provider; Connections never chooses an account for you.",
  "Your actions are scoped to your current workspace. You can only access connections configured in this workspace.",
].join("\n");

/**
 * Return the fixed discovery-oriented MCP tool list.
 *
 * The local runtime can contain hundreds of provider actions, so MCP exposes a
 * small set of search/read/execute tools instead of one tool per provider
 * action.
 */
export function listMcpToolSummaries(): IMcpToolSummary[] {
  return mcpToolSummaries;
}

/**
 * Create a stateless MCP server instance for one Streamable HTTP request.
 */
export function createMcpServer(options: IMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "oomol-connect",
      version: "0.1.0",
    },
    {
      instructions: mcpServerInstructions,
    },
  );

  server.registerTool(
    "list_apps",
    {
      title: "List Apps",
      description: "List available provider apps with connection and action counts.",
      inputSchema: {
        query: z.string().optional().describe("Optional case-insensitive app name, service, category, or auth filter."),
      },
    },
    async ({ query }) => toolResult(successPayload(await listApps(options, query))),
  );

  if (options.automation && options.workspaceContext) registerAutomationTools(server, options);

  server.registerTool(
    "search_actions",
    {
      title: "Search Actions",
      description:
        "Search catalog actions by query and optional provider service id. Use this before requesting an action guide.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Optional case-insensitive search text matched against action id, name, description, and scopes."),
        service: z
          .string()
          .optional()
          .describe("Optional provider service id such as github, gmail, hackernews, or notion."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of actions to return."),
      },
    },
    async ({ query, service, limit }) =>
      toolResult(successPayload(await searchActions(options, { query, service, limit }))),
  );

  server.registerTool(
    "get_action_guide",
    {
      title: "Get Action Guide",
      description: "Return one action's compact markdown guide, including local execute examples and input parameters.",
      inputSchema: {
        actionId: z.string().describe("Full action id, for example github.get_current_user."),
      },
    },
    async ({ actionId }) => toolResult(await getActionGuide(options, actionId)),
  );

  server.registerTool(
    "execute_action",
    {
      title: "Execute Action",
      description:
        "Execute one local provider action by id with a JSON input object and an explicit connection label. Check capability.requireApproval first and ask the user in the current conversation when it is true.",
      inputSchema: {
        actionId: z.string().describe("Full action id, for example hackernews.get_item."),
        connectionName: z
          .string()
          .min(1)
          .describe("Exact connection label for this action. Use a label returned by list_apps."),
        input: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Action input object matching the selected action guide."),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Optional duplicate-protection key for write actions that support idempotency."),
      },
    },
    async ({ actionId, connectionName, input, idempotencyKey }) =>
      toolResult(await executeAction(options, actionId, connectionName, input, idempotencyKey)),
  );

  return server;
}

function registerAutomationTools(server: McpServer, options: IMcpServerOptions): void {
  const automation = options.automation!;
  const actor = options.workspaceContext!;
  const id = z.string().min(1).describe("Automation id.");
  const definition = z.object({
    name: z.string().min(1),
    description: z.string().default(""),
    slug: z.string().min(1),
    connectionName: z.string().min(1),
    actionId: z.literal("gmail.create_email_draft"),
    steps: z.tuple([
      z.object({ id: z.literal("compose"), name: z.string(), kind: z.literal("input") }),
      z.object({ id: z.literal("schedule"), name: z.string(), kind: z.literal("schedule") }),
      z.object({ id: z.literal("create-draft"), name: z.string(), kind: z.literal("action") }),
    ]),
  });
  const runInput = z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
    scheduledFor: z.string().min(1),
    timeZone: z.string().min(1),
    repeat: z.boolean(),
    cadence: z.enum(["daily", "weekly"]).optional(),
    endAt: z.string().optional(),
  });
  const testInput = runInput.pick({ to: true, subject: true, body: true });
  const tool =
    <T>(operation: () => Promise<T>) =>
    async (): Promise<CallToolResult> =>
      toolResult(await automationResult(operation));
  server.registerTool(
    "list_automations",
    { title: "List Automations", description: "List workspace automations.", inputSchema: {} },
    tool(async () => await automation.list(actor)),
  );
  server.registerTool(
    "get_automation",
    { title: "Get Automation", description: "Read one automation.", inputSchema: { automationId: id } },
    async ({ automationId }) =>
      toolResult(await automationResult(async () => await automation.get(actor, automationId))),
  );
  server.registerTool(
    "build_automation",
    { title: "Build Automation", description: "Create a Gmail draft automation draft.", inputSchema: { definition } },
    async ({ definition: value }) =>
      toolResult(
        await automationResult(async () => await automation.build(actor, value as GmailDraftAutomationDefinition)),
      ),
  );
  server.registerTool(
    "edit_automation_draft",
    {
      title: "Edit Automation Draft",
      description: "Replace a Gmail automation draft.",
      inputSchema: { automationId: id, definition },
    },
    async ({ automationId, definition: value }) =>
      toolResult(
        await automationResult(
          async () => await automation.edit(actor, automationId, value as GmailDraftAutomationDefinition),
        ),
      ),
  );
  server.registerTool(
    "test_automation",
    {
      title: "Test Automation",
      description: "Create one real Gmail draft from this draft version without creating a schedule.",
      inputSchema: {
        automationId: id,
        input: testInput,
        confirmed: z.literal(true).describe("Set only after the user explicitly approves creating one Gmail draft."),
      },
    },
    async ({ automationId, input, confirmed }) =>
      toolResult(await automationResult(async () => await automation.test(actor, automationId, input, confirmed))),
  );
  server.registerTool(
    "publish_automation",
    {
      title: "Publish Automation",
      description: "Publish after explicit user confirmation.",
      inputSchema: {
        automationId: id,
        confirmed: z.literal(true).describe("Set only after the user explicitly approves publishing."),
      },
    },
    async ({ automationId, confirmed }) =>
      toolResult(await automationResult(async () => await automation.publish(actor, automationId, confirmed))),
  );
  server.registerTool(
    "run_automation",
    {
      title: "Run Automation",
      description: "Create a one-off or recurring schedule.",
      inputSchema: { automationId: id, input: runInput },
    },
    async ({ automationId, input }) =>
      toolResult(
        await automationResult(
          async () => await automation.schedule(actor, automationId, input as AutomationScheduleInput),
        ),
      ),
  );
  server.registerTool(
    "stop_automation_schedule",
    {
      title: "Stop Automation Schedule",
      description: "Stop one schedule.",
      inputSchema: { scheduleId: z.string().min(1) },
    },
    async ({ scheduleId }) =>
      toolResult(await automationResult(async () => await automation.stopSchedule(actor, scheduleId))),
  );
  server.registerTool(
    "disable_automation",
    {
      title: "Disable Automation",
      description: "Disable an automation and all future schedules.",
      inputSchema: { automationId: id },
    },
    async ({ automationId }) =>
      toolResult(await automationResult(async () => await automation.disable(actor, automationId))),
  );
  server.registerTool(
    "get_automation_runs",
    { title: "Get Automation Runs", description: "List automation runs.", inputSchema: { automationId: id } },
    async ({ automationId }) =>
      toolResult(await automationResult(async () => await automation.listRuns(actor, automationId))),
  );
}

async function automationResult<T>(operation: () => Promise<T>): Promise<ToolPayload> {
  try {
    return successPayload(await operation());
  } catch (error) {
    return errorPayload(
      error instanceof Error && "code" in error ? String((error as { code: string }).code) : "automation_error",
      error instanceof Error ? error.message : "Automation operation failed.",
    );
  }
}

async function listApps(options: IMcpServerOptions, query: string | undefined): Promise<unknown> {
  const normalized = query?.trim().toLowerCase();
  const providers = (
    await Promise.all(
      options.catalog.providers.map(async (provider) => ({
        provider,
        enabled: (await options.isProviderEnabled?.(provider.service)) ?? true,
      })),
    )
  )
    .filter(({ provider, enabled }) => {
      if (!enabled) return false;
      if (!normalized) {
        return true;
      }

      return [provider.service, provider.displayName, provider.categories.join(" "), provider.authTypes.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    })
    .map(async ({ provider }) => {
      const connections = await options.connections.listConnectionsByService(provider.service);
      return {
        service: provider.service,
        displayName: provider.displayName,
        categories: provider.categories,
        authTypes: provider.authTypes,
        actionCount: provider.actions.length,
        executableActionCount: provider.actions.filter((action) => action.execution.locallyExecutable).length,
        connections,
      };
    });

  return Promise.all(providers);
}

async function searchActions(
  options: IMcpServerOptions,
  input: { query?: string; service?: string; limit: number },
): Promise<unknown> {
  const query = input.query?.trim();
  const actionSearch = options.actionSearch ?? createActionSearchIndexProvider(options.catalog.actions);
  const rankedActions = query
    ? searchActionIndex(await actionSearch.get(), query, { service: input.service, limit: input.limit })
        .map((result) => options.catalog.actionsById.get(result.id))
        .filter((action): action is RuntimeActionDefinition => Boolean(action))
    : options.catalog.actions
        .filter((action) => !input.service || action.service === input.service)
        .slice(0, input.limit);
  const actions = (
    await Promise.all(
      rankedActions.map(async (action) => ({
        action,
        enabled: (await options.isProviderEnabled?.(action.service)) ?? true,
      })),
    )
  )
    .filter(({ enabled }) => enabled)
    .map(async ({ action }) => ({
      id: action.id,
      service: action.service,
      name: action.name,
      description: action.description,
      capability: await describeActionCapability(options, action),
      inputSummary: summarizeInputSchema(action.inputSchema),
    }));

  return Promise.all(actions);
}

async function getActionGuide(options: IMcpServerOptions, actionId: string): Promise<ToolPayload> {
  const action = options.catalog.actionsById.get(actionId);
  if (!action || !((await options.isProviderEnabled?.(action.service)) ?? true)) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }

  return successPayload({
    capability: await describeActionCapability(options, action),
    markdown: renderActionMarkdown(action, await describeActionMarkdownContext(options, action)),
  });
}

async function executeAction(
  options: IMcpServerOptions,
  actionId: string,
  connectionName: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ToolPayload> {
  const action = options.catalog.actionsById.get(actionId);
  if (!action || !((await options.isProviderEnabled?.(action.service)) ?? true)) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }

  let run;
  try {
    run = await options.actions.run({
      actionId,
      input,
      caller: "mcp",
      connectionName,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ConnectionError) {
      return errorPayload(error.code, error.message);
    }
    throw error;
  }
  if (!run) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }
  if (!run.result.ok) {
    return {
      ok: false,
      error: run.result.error ?? {
        code: "execution_failed",
        message: "Action execution failed.",
      },
    };
  }
  return successPayload(run.result.output);
}

function summarizeInputSchema(schema: JsonSchema): unknown {
  const properties =
    schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, JsonSchema>) : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [],
  );

  return Object.entries(properties).map(([name, property]) => ({
    name,
    required: required.has(name),
    type: describeSchemaType(property),
    description: typeof property.description === "string" ? property.description : "",
  }));
}

type ActionCapability = {
  execution: RuntimeActionDefinition["execution"];
  safety: RuntimeActionDefinition["safety"];
  authTypes: ProviderDefinition["authTypes"];
  requiredScopes: string[];
  providerPermissions: string[];
  policy: ReturnType<ActionPolicyService["evaluate"]> | { allowed: true };
  connections: ConnectionSummary[];
  requireApproval: boolean;
  approvalInstruction: string | null;
  safetyConfig?: unknown;
};

async function describeActionCapability(
  options: IMcpServerOptions,
  action: RuntimeActionDefinition,
): Promise<ActionCapability> {
  const provider = options.catalog.providers.find((candidate) => candidate.service === action.service);
  const requireApproval = (await options.requireApproval?.(action)) ?? true;
  return {
    execution: action.execution,
    safety: action.safety,
    authTypes: provider?.authTypes ?? [],
    requiredScopes: action.requiredScopes,
    providerPermissions: action.providerPermissions,
    policy: options.actionPolicy?.evaluate(action) ?? { allowed: true },
    connections: await options.connections.listConnectionsByService(action.service),
    requireApproval,
    approvalInstruction: requireApproval
      ? "Ask the user for explicit approval in the current conversation before executing this action."
      : null,
  };
}

async function describeActionMarkdownContext(
  options: IMcpServerOptions,
  action: RuntimeActionDefinition,
): Promise<{ connections: ConnectionSummary[]; providerPermissions: string[] }> {
  return {
    connections: await options.connections.listConnectionsByService(action.service),
    providerPermissions: action.providerPermissions,
  };
}

function describeSchemaType(schema: JsonSchema | undefined): string {
  if (!schema) {
    return "unknown";
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((value) => describeSchemaType(value as JsonSchema)).join(" | ");
  }
  return typeof schema.type === "string" ? schema.type : "unknown";
}

type ToolPayload =
  | {
      ok: true;
      data: unknown;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

function successPayload(data: unknown): ToolPayload {
  return { ok: true, data };
}

function errorPayload(code: string, message: string): ToolPayload {
  return {
    ok: false,
    error: { code, message },
  };
}

function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true }),
  };
}

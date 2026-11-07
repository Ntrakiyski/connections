import type { ActionDefinition, ActionExecutor, ProviderDefinition } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { createConnectApp } from "./connect-app.ts";
import { TransitFileService } from "./files/transit-files.ts";
import { PlainTextSecretCodec } from "./secrets/secret-codec-core.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "./storage/sqlite-runtime-store.ts";
import { seedTwoCompanies, sentinelCatalog, SentinelProviderLoader } from "./test-fixtures/two-company.ts";

const tempDirs: string[] = [];

const echoAction: ActionDefinition = {
  id: "example.echo",
  service: "example",
  name: "echo",
  description: "Echo input.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

const exampleProvider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [echoAction],
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MCP workspace isolation", () => {
  it("routes the two-company fixture by token and requires an explicit authorized label", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connections-two-company-mcp-"));
    tempDirs.push(directory);
    const path = join(directory, "connect.sqlite");
    const database = new SqliteRuntimeDatabase(path);
    const raw = new DatabaseSync(path);
    try {
      await seedTwoCompanies(database, {
        write: async (sql, values) => {
          raw.prepare(sql).run(...values);
        },
        placeholder: () => "?",
        authTimestamp: Date.parse("2026-07-15T00:00:00.000Z"),
        verifiedBoolean: 1,
      });
      const loader = new SentinelProviderLoader();
      const connect = await createConnectApp({
        catalog: sentinelCatalog,
        providerLoader: loader,
        runtimeDatabase: database,
        transitFiles: new TransitFileService({
          rootDir: join(directory, "files"),
          publicOrigin: "http://localhost",
          ttlSeconds: 60,
          maxBytes: 1024,
        }),
        publicOrigin: "http://localhost",
        secretCodec: new PlainTextSecretCodec(),
        clerkSecretKey: "sk_test_two_company_fixture",
      });
      const tokens = new RuntimeTokenService(database.runtimeTokenStore);
      for (const [workspaceId, expected] of [
        ["A1", "A1-alice"],
        ["A2", "A2-operator"],
        ["B1", "B1-employee"],
      ]) {
        if (!workspaceId || !expected) throw new Error("Incomplete fixture selection.");
        const token = await tokens.createToken(workspaceId, "operator", `Operator ${workspaceId}`);
        await withMcpClient(
          (input, init) => Promise.resolve(connect.app.request(input, init)),
          token.token,
          async (client) => {
            const before = loader.selectedAccounts.length;
            const missingLabel = await client.callTool({
              name: "execute_action",
              arguments: { actionId: "sentinel.get_account", input: {} },
            });
            expect(missingLabel.isError).toBe(true);
            expect(loader.selectedAccounts).toHaveLength(before);
            const result = await client.callTool({
              name: "execute_action",
              arguments: { actionId: "sentinel.get_account", connectionName: "shared", input: {} },
            });
            expect(toolPayload(result)).toMatchObject({ ok: true, data: { selectedAccount: expected, workspaceId } });
          },
        );
      }
      const token = await tokens.createToken("A1", "alice", "A1 member");
      await withMcpClient(
        (input, init) => Promise.resolve(connect.app.request(input, init)),
        token.token,
        async (client) => {
          const result = await client.callTool({
            name: "execute_action",
            arguments: { actionId: "sentinel.get_account", connectionName: "bob", input: {} },
          });
          expect(toolPayload(result)).toMatchObject({ ok: false, error: { code: "connection_not_found" } });
        },
      );
      expect(loader.selectedAccounts).toEqual(["A1-alice", "A2-operator", "B1-employee"]);
      await expect(database.createScopedStores("A1").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "A1-alice",
      });
      await expect(database.createScopedStores("A2").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "A2-operator",
      });
      await expect(database.createScopedStores("B1").connectionStore.get("sentinel", "shared")).resolves.toMatchObject({
        apiKey: "B1-employee",
      });
    } finally {
      raw.close();
      database.close();
    }
  });

  it("binds each API key to its own workspace and rejects another workspace's connection label", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oomol-connect-mcp-"));
    tempDirs.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "connect.sqlite"));
    const catalog = createCatalogStore([exampleProvider], { executableActionIds: [echoAction.id] });

    await seedWorkspace(database, "workspace-one", "org_one", "user-one", "one-connection");
    await seedWorkspace(database, "workspace-two", "org_two", "user-two", "two-connection");
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const oneToken = await tokens.createToken("workspace-one", "user-one", "Organization one MCP");
    const twoToken = await tokens.createToken("workspace-two", "user-two", "Organization two MCP");
    const connect = await createConnectApp({
      catalog,
      providerLoader: new EchoProviderLoader(),
      runtimeDatabase: database,
      transitFiles: new TransitFileService({
        rootDir: join(directory, "files"),
        publicOrigin: "http://localhost",
        ttlSeconds: 60,
        maxBytes: 1024,
      }),
      publicOrigin: "http://localhost",
      secretCodec: new PlainTextSecretCodec(),
      clerkSecretKey: "sk_test_mcp_workspace_isolation",
    });

    try {
      await withMcpClient(
        (input, init) => Promise.resolve(connect.app.request(input, init)),
        oneToken.token,
        async (client) => {
          await expect(connectionNames(client)).resolves.toEqual(["one-connection"]);

          const crossWorkspaceRun = await client.callTool({
            name: "execute_action",
            arguments: { actionId: echoAction.id, connectionName: "two-connection", input: {} },
          });
          expect(crossWorkspaceRun.isError).toBe(true);
          expect(toolPayload(crossWorkspaceRun)).toMatchObject({
            ok: false,
            error: { code: "connection_not_found" },
          });
        },
      );

      await withMcpClient(
        (input, init) => Promise.resolve(connect.app.request(input, init)),
        twoToken.token,
        async (client) => {
          await expect(connectionNames(client)).resolves.toEqual(["two-connection"]);
        },
      );
    } finally {
      database.close();
    }
  });
});

async function seedWorkspace(
  database: SqliteRuntimeDatabase,
  workspaceId: string,
  clerkOrgId: string,
  userId: string,
  connectionName: string,
): Promise<void> {
  const now = "2026-07-15T00:00:00.000Z";
  await database.workspaceStore.create({
    id: workspaceId,
    clerkOrgId,
    name: workspaceId,
    createdAt: now,
    updatedAt: now,
  });
  await database.membershipStore.setRole(workspaceId, userId, "manager");
  await database.workspaceControlStore.enableProvider({
    workspaceId,
    service: exampleProvider.service,
    enabledBy: userId,
    enabledAt: now,
  });
  await database.createScopedStores(workspaceId).connectionStore.set(exampleProvider.service, connectionName, {
    authType: "api_key",
    apiKey: `${workspaceId}-secret`,
    values: { apiKey: `${workspaceId}-secret` },
    profile: {
      accountId: `${workspaceId}-account`,
      displayName: connectionName,
      grantedScopes: [],
    },
    metadata: {},
  });
}

async function withMcpClient(
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  token: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: request,
  });
  const client = new Client({ name: "workspace-isolation-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

async function connectionNames(client: Client): Promise<string[]> {
  const result = await client.callTool({ name: "list_apps", arguments: { service: exampleProvider.service } });
  const payload = toolPayload(result) as {
    data: Array<{ connections: Array<{ connectionName: string }> }>;
  };
  return payload.data.flatMap((provider) => provider.connections.map((connection) => connection.connectionName));
}

function toolPayload(result: unknown): unknown {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("MCP tool response did not contain content.");
  const text = content.find(
    (item): item is { type: string; text?: string } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text",
  )?.text;
  if (!text) throw new Error("MCP tool response did not contain a text payload.");
  return JSON.parse(text);
}

class EchoProviderLoader implements IProviderLoader {
  async loadActionExecutor(): Promise<ActionExecutor> {
    return async (input) => ({ ok: true, output: input });
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<undefined> {
    return undefined;
  }
}

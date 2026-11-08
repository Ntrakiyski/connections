import type { CatalogStore } from "../../catalog-store.ts";
import type { ActionExecutor, CredentialValidators, ProviderDefinition, ResolvedCredential } from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { RuntimeDatabase } from "../storage/runtime-database.ts";

import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { ActionRunner } from "../actions/action-runner.ts";

export const fixtureTime = "2026-07-15T00:00:00.000Z";
export const fixtureUsers: readonly string[] = ["operator", "alice", "bob", "employee"];
interface FixtureWorkspace {
  id: string;
  organizationId: string;
}
export const fixtureWorkspaces: readonly FixtureWorkspace[] = [
  { id: "A1", organizationId: "company-A" },
  { id: "A2", organizationId: "company-A" },
  { id: "B1", organizationId: "company-B" },
];

export const sentinelProvider: ProviderDefinition = {
  service: "sentinel",
  displayName: "Synthetic Sentinel",
  categories: ["Developer Tools"],
  authTypes: ["api_key", "custom_credential", "oauth2"],
  auth: [
    { type: "api_key" },
    {
      type: "custom_credential",
      fields: [{ key: "password", label: "Password", inputType: "password", required: true, secret: true }],
    },
    {
      type: "oauth2",
      authorizationUrl: "https://sentinel.invalid/authorize",
      tokenUrl: "https://sentinel.invalid/token",
      scopes: [],
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
  actions: [
    {
      id: "sentinel.get_account",
      service: "sentinel",
      name: "get_account",
      description: "Observe the synthetic account selected by this operation.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

export const sentinelCatalog: CatalogStore = createCatalogStore([sentinelProvider], {
  executableActionIds: ["sentinel.get_account"],
});

export interface FixtureSql {
  write(sql: string, values: Array<string | number>): Promise<void>;
  placeholder(index: number): string;
  authTimestamp: string | number;
  verifiedBoolean: number | boolean;
}

/** Seed independent directory memberships before inserting workspace resource grants. */
export async function seedTwoCompanies(database: RuntimeDatabase, sql: FixtureSql): Promise<void> {
  const insert = async (table: string, columns: string[], values: Array<string | number | boolean>): Promise<void> => {
    // All identifiers are fixture-owned constants; values stay bound parameters.
    await sql.write(
      `insert into ${table} (${columns.join(", ")}) values (${values.map((_, index) => sql.placeholder(index + 1)).join(", ")})`,
      values.map((value) => (typeof value === "boolean" ? Number(value) : value)),
    );
  };
  for (const userId of fixtureUsers) {
    await insert(
      "auth_user",
      ["id", "name", "email", "email_verified", "created_at", "updated_at"],
      [userId, userId, `${userId}@synthetic.invalid`, sql.verifiedBoolean, sql.authTimestamp, sql.authTimestamp],
    );
  }
  for (const organizationId of ["company-A", "company-B"]) {
    await insert(
      "organizations",
      ["id", "name", "slug", "created_at"],
      [organizationId, organizationId, organizationId.toLowerCase(), sql.authTimestamp],
    );
  }
  const organizationMembers = [
    ["company-A", "operator", "owner"],
    ["company-A", "alice", "member"],
    ["company-A", "bob", "member"],
    ["company-B", "operator", "admin"],
    ["company-B", "employee", "member"],
  ];
  for (const [organizationId, userId, role] of organizationMembers) {
    if (!organizationId || !userId || !role) throw new Error("Incomplete fixture membership.");
    await insert(
      "organization_memberships",
      ["id", "organization_id", "user_id", "role", "created_at"],
      [`${organizationId}-${userId}`, organizationId, userId, role, sql.authTimestamp],
    );
  }
  for (const workspace of fixtureWorkspaces) {
    await insert(
      "workspaces",
      ["id", "organization_id", "clerk_org_id", "name", "created_at", "updated_at"],
      [workspace.id, workspace.organizationId, `legacy-${workspace.id}`, workspace.id, fixtureTime, fixtureTime],
    );
    await database.workspaceControlStore.enableProvider({
      workspaceId: workspace.id,
      service: sentinelProvider.service,
      enabledBy: "operator",
      enabledAt: fixtureTime,
    });
  }
  const grants = [
    ["A1", "company-A", "operator", "admin"],
    ["A2", "company-A", "operator", "manager"],
    ["B1", "company-B", "operator", "admin"],
    ["A1", "company-A", "alice", "member"],
    ["A1", "company-A", "bob", "member"],
    ["B1", "company-B", "employee", "member"],
  ];
  for (const [workspaceId, organizationId, userId, role] of grants) {
    if (!workspaceId || !organizationId || !userId || !role) throw new Error("Incomplete fixture grant.");
    await insert(
      "workspace_memberships",
      ["workspace_id", "organization_id", "user_id", "role", "created_at", "updated_at"],
      [workspaceId, organizationId, userId, role, fixtureTime, fixtureTime],
    );
  }
  const accounts = [
    { workspaceId: "A1", userId: "alice", label: "shared", sentinel: "A1-alice" },
    { workspaceId: "A1", userId: "bob", label: "bob", sentinel: "A1-bob" },
    { workspaceId: "A2", userId: "operator", label: "shared", sentinel: "A2-operator" },
    { workspaceId: "B1", userId: "employee", label: "shared", sentinel: "B1-employee" },
  ];
  for (const account of accounts) {
    await database
      .createScopedStores(account.workspaceId)
      .connectionStore.set(
        sentinelProvider.service,
        account.label,
        sentinelCredential(account.sentinel),
        account.userId,
      );
  }
}

export function sentinelCredential(sentinel: string): Extract<ResolvedCredential, { authType: "api_key" }> {
  return {
    authType: "api_key",
    apiKey: sentinel,
    values: { apiKey: sentinel },
    profile: { accountId: sentinel, displayName: sentinel, grantedScopes: [] },
    metadata: {},
  };
}

/** The stub observes provider account selection without credentials, network calls, or third-party state. */
export class SentinelProviderLoader implements IProviderLoader {
  readonly selectedAccounts: string[] = [];
  readonly validatedAccounts: string[] = [];
  validationBarrier?: () => Promise<void>;

  async loadActionExecutor(): Promise<ActionExecutor> {
    return async (_input, context) => {
      const credential = await context.getCredential(sentinelProvider.service);
      if (!credential || credential.authType !== "api_key") throw new Error("Synthetic API-key credential required.");
      this.selectedAccounts.push(credential.apiKey);
      return { ok: true, output: { selectedAccount: credential.apiKey, workspaceId: context.identity?.workspaceId } };
    };
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<CredentialValidators> {
    return {
      apiKey: async ({ apiKey }) => {
        this.validatedAccounts.push(apiKey);
        await this.validationBarrier?.();
        return { profile: { accountId: apiKey, displayName: apiKey, grantedScopes: [] } };
      },
      customCredential: async ({ values }) => {
        this.validatedAccounts.push(values.password);
        await this.validationBarrier?.();
        return {};
      },
      oauth2: async (credential) => {
        this.validatedAccounts.push(credential.accessToken);
        await this.validationBarrier?.();
        return {};
      },
    };
  }
}

export async function fixtureService(
  database: RuntimeDatabase,
  loader: SentinelProviderLoader,
  workspaceId: string,
  userId: string,
): Promise<ConnectionService> {
  const role = await database.membershipStore.getRole(workspaceId, userId);
  if (!role) throw new Error(`No fixture workspace grant: ${workspaceId}/${userId}.`);
  return new ConnectionService({
    catalog: sentinelCatalog,
    providerLoader: loader,
    store: database.createScopedStores(workspaceId).connectionStore,
    actor: { userId, canManageWorkspace: role !== "member" },
  });
}

export async function fixtureRunner(
  database: RuntimeDatabase,
  loader: SentinelProviderLoader,
  workspaceId: string,
  userId: string,
): Promise<ActionRunner> {
  const role = await database.membershipStore.getRole(workspaceId, userId);
  if (!role) throw new Error(`No fixture workspace grant: ${workspaceId}/${userId}.`);
  return new ActionRunner({
    catalog: sentinelCatalog,
    providerLoader: loader,
    connections: await fixtureService(database, loader, workspaceId, userId),
    runs: database.createScopedStores(workspaceId).runLogStore,
    workspace: { workspaceId, userId, role },
  });
}

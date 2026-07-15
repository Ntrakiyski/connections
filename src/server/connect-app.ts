import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { WorkspaceServerServices } from "./connect-server.ts";
import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { WorkspaceContext } from "./storage/runtime-token-service.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { ConnectServer } from "./connect-server.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { WorkspaceControlService } from "./workspace-control-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  publicOrigin: string;
  secretCodec: ISecretCodec;
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
  clerkOptional?: boolean;
  actionPolicy?: ActionPolicyService;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  computeRuntimeAuthConfigured?: boolean;
}

export interface ConnectApp {
  app: Hono;
  runtimeAuthConfigured: boolean;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore);
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
  const createWorkspaceServices = (workspace: WorkspaceContext): WorkspaceServerServices => {
    const stores = options.runtimeDatabase.createScopedStores(workspace.workspaceId);
    const controls = new WorkspaceControlService(
      options.catalog,
      options.runtimeDatabase.workspaceControlStore,
      workspace,
    );
    const oauthClientConfigs = new OAuthClientConfigService({
      catalog: options.catalog,
      origin: options.publicOrigin,
      store: stores.oauthClientConfigStore,
    });
    const connections = new ConnectionService({
      catalog: options.catalog,
      oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs),
      providerLoader: options.providerLoader,
      store: stores.connectionStore,
      actor: { userId: workspace.userId, canManageWorkspace: workspace.role !== "member" },
      createWorkspaceService: (workspaceId) =>
        createWorkspaceServices({
          ...workspace,
          workspaceId,
        }).connections,
      logger: options.logger,
    });
    return {
      controls,
      connections,
      oauthClientConfigs,
      oauthFlow: new OAuthFlowService({
        clientConfigs: oauthClientConfigs,
        connections,
        states: stores.oauthStateStore,
        statePrefix: `${workspace.workspaceId}.${workspace.userId}`,
        userId: workspace.userId,
      }),
      actions: new ActionRunner({
        catalog: options.catalog,
        providerLoader: options.providerLoader,
        connections,
        runs: stores.runLogStore,
        transitFiles: options.transitFiles,
        actionPolicy: options.actionPolicy,
        logger: options.logger,
        workspace,
        createWorkspaceRunner: (workspaceId) =>
          createWorkspaceServices({
            ...workspace,
            workspaceId,
          }).actions,
      }),
      runtimeTokens: new RuntimeTokenService(stores.runtimeTokenStore),
    };
  };
  const defaultServices = createWorkspaceServices({ workspaceId: "default", userId: "local-dev", role: "admin" });

  return {
    app: new ConnectServer({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections: defaultServices.connections,
      oauthClientConfigs: defaultServices.oauthClientConfigs,
      oauthFlow: defaultServices.oauthFlow,
      actions: defaultServices.actions,
      transitFiles: options.transitFiles,
      runtimeTokens: defaultServices.runtimeTokens,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        secretKey: options.clerkSecretKey,
        publishableKey: options.clerkPublishableKey,
        optional: options.clerkOptional,
        workspaceStore: options.runtimeDatabase.workspaceStore,
        membershipStore: options.runtimeDatabase.membershipStore,
      },
      clerkWebhooks: {
        signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
        workspaceStore: options.runtimeDatabase.workspaceStore,
        membershipStore: options.runtimeDatabase.membershipStore,
        workspaceControls: options.runtimeDatabase.workspaceControlStore,
        runtimeTokens,
        removeMemberConnections: async (workspaceId, userId) => {
          await options.runtimeDatabase.createScopedStores(workspaceId).connectionStore.deleteByOwner(userId);
        },
      },
      runtimeTokenAuth: {
        runtimeTokens,
        memberships: options.runtimeDatabase.membershipStore,
      },
      createWorkspaceServices,
      actionPolicy: options.actionPolicy,
      logger: options.logger,
    }).createApp(),
    runtimeAuthConfigured: options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens(),
  };
}

import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { WorkspaceServerServices } from "./connect-server.ts";
import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { AuthMailDelivery, ConnectionsHumanAuth } from "./human-auth.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { WorkspaceContext } from "./storage/runtime-token-service.ts";
import type { Hono } from "hono";

import { ConnectionError, ConnectionService } from "../connection-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowError, OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { resolveWorkspaceAccess } from "./api/principal-auth.ts";
import { CompanyDirectoryService } from "./company-directory.ts";
import { CompanyInvitationService } from "./company-invitations.ts";
import { CompanyService } from "./company-service.ts";
import { ConnectServer } from "./connect-server.ts";
import { MeetingsOAuthService } from "./meetings-oauth.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { WorkspaceControlService } from "./workspace-control-service.ts";
import { WorkspaceLifecycleService } from "./workspace-lifecycle-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  publicOrigin: string;
  secretCodec: ISecretCodec;
  humanAuth?: ConnectionsHumanAuth;
  authMailDelivery?: AuthMailDelivery;
  trustedAuthOrigins?: string[];
  developmentBypass?: boolean;
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
  if (options.humanAuth && !options.runtimeDatabase.identityDirectory) {
    throw new Error("Human authentication requires a live identity directory.");
  }
  if (options.humanAuth && (!options.runtimeDatabase.identityMutations || !options.authMailDelivery)) {
    throw new Error("Human authentication requires transactional company governance and invitation mail delivery.");
  }
  if (options.humanAuth && !options.runtimeDatabase.providerOAuthConsents) {
    throw new Error("Human authentication requires a server-owned provider consent directory.");
  }
  const accessStores = {
    directory: options.runtimeDatabase.identityDirectory,
    workspaceStore: options.runtimeDatabase.workspaceStore,
    membershipStore: options.runtimeDatabase.membershipStore,
  };
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore);
  const meetingsOAuth =
    options.humanAuth && options.runtimeDatabase.identityMutations && accessStores.directory
      ? new MeetingsOAuthService({
          auth: options.humanAuth,
          store: options.runtimeDatabase.identityMutations,
          access: { ...accessStores, directory: accessStores.directory },
          origin: options.publicOrigin,
        })
      : undefined;
  await meetingsOAuth?.initialize();
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
  const createWorkspaceServices = (workspace: WorkspaceContext): WorkspaceServerServices => {
    const boundServices = (workspaceId: string): WorkspaceServerServices => {
      if (workspaceId !== workspace.workspaceId)
        throw new ConnectionError("workspace_scope_conflict", "A bound credential cannot select another workspace.");
      return createWorkspaceServices(workspace);
    };
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
      createWorkspaceService: (workspaceId) => boundServices(workspaceId).connections,
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
        statePrefix: options.humanAuth ? undefined : `${workspace.workspaceId}.${workspace.userId}`,
        userId: workspace.userId,
        workspaceId: workspace.workspaceId,
        assertAccess: options.humanAuth
          ? async (service) => {
              if (!accessStores.directory) throw new Error("Identity directory is required.");
              await resolveWorkspaceAccess(
                { ...accessStores, directory: accessStores.directory },
                workspace.userId,
                workspace.workspaceId,
              );
              await controls.assertProviderEnabled(service);
            }
          : undefined,
      }),
      actions: new ActionRunner({
        catalog: options.catalog,
        providerLoader: options.providerLoader,
        connections,
        runs: stores.runLogStore,
        transitFiles: options.transitFiles,
        actionPolicy: options.actionPolicy,
        controls,
        logger: options.logger,
        workspace,
        createWorkspaceRunner: (workspaceId) => boundServices(workspaceId).actions,
      }),
      runtimeTokens: new RuntimeTokenService(stores.runtimeTokenStore),
      lifecycle:
        options.humanAuth && options.runtimeDatabase.workspaceLifecycleStore
          ? new WorkspaceLifecycleService(
              options.runtimeDatabase.workspaceLifecycleStore,
              runtimeTokens,
              options.runtimeDatabase.workspaceControlStore,
              workspace,
              async () => {
                const stored = await options.runtimeDatabase.workspaceStore.getById(workspace.workspaceId);
                if (!stored) throw new Error("Workspace not found.");
                return stored;
              },
            )
          : undefined,
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
      developmentBypass: options.developmentBypass,
      principalAuth:
        options.humanAuth && options.runtimeDatabase.identityDirectory
          ? {
              auth: options.humanAuth,
              trustedOrigins: options.trustedAuthOrigins ?? [new URL(options.publicOrigin).origin],
              directory: options.runtimeDatabase.identityDirectory,
              workspaceStore: options.runtimeDatabase.workspaceStore,
              membershipStore: options.runtimeDatabase.membershipStore,
              runtimeTokens,
              meetingsOAuth,
            }
          : undefined,
      companyServices:
        options.humanAuth && options.runtimeDatabase.identityMutations && options.authMailDelivery
          ? {
              companies: new CompanyService(options.runtimeDatabase.identityMutations),
              directory: new CompanyDirectoryService(options.runtimeDatabase.identityMutations),
              invitations: new CompanyInvitationService(options.runtimeDatabase.identityMutations, {
                publicOrigin: options.publicOrigin,
                sendMail: options.authMailDelivery,
              }),
            }
          : undefined,
      meetingStore: options.runtimeDatabase.meetingStore,
      meetingsOAuth,
      runtimeTokenAuth: {
        runtimeTokens,
        memberships: options.runtimeDatabase.membershipStore,
        workspaceStore: options.runtimeDatabase.workspaceStore,
      },
      createWorkspaceServices,
      completeProviderOAuth: options.humanAuth
        ? async (input) => {
            const consent = await options.runtimeDatabase.providerOAuthConsents?.take(input.state);
            if (!consent) throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
            if (!accessStores.directory) throw new Error("Identity directory is required.");
            const workspace = await resolveWorkspaceAccess(
              { ...accessStores, directory: accessStores.directory },
              consent.userId,
              consent.workspaceId,
            );
            const result = await createWorkspaceServices(workspace).oauthFlow.completeRedeemedAuthorization(
              input,
              consent.pending,
            );
            return { ...result, state: input.state, userId: consent.userId, workspaceId: consent.workspaceId };
          }
        : undefined,
      purgeExpiredWorkspaces: options.humanAuth
        ? async () => {
            await options.runtimeDatabase.workspaceLifecycleStore?.purgeExpired(new Date().toISOString());
          }
        : undefined,
      actionPolicy: options.actionPolicy,
      logger: options.logger,
    }).createApp(),
    runtimeAuthConfigured: options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens(),
  };
}

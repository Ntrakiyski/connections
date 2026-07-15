import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore } from "../../oauth/oauth-client-config-service.ts";
import type { OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore } from "../../oauth/oauth-flow-service.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord, WorkspaceRole } from "./runtime-token-service.ts";

export interface Workspace {
  id: string;
  clerkOrgId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface IWorkspaceStore {
  getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined>;
  getById(id: string): Promise<Workspace | undefined>;
  create(workspace: Workspace): Promise<void>;
}

export interface IWorkspaceMembershipStore {
  getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined>;
  setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}

/** Workspace-addressed connection storage for services that cannot pre-bind a store. */
export interface IWorkspaceConnectionStore {
  get(workspaceId: string, service: string, connectionName: string): Promise<ResolvedCredential | undefined>;
  set(workspaceId: string, service: string, connectionName: string, credential: ResolvedCredential): Promise<void>;
  delete(workspaceId: string, service: string, connectionName: string): Promise<void>;
  list(workspaceId: string): Promise<StoredConnection[]>;
}

export interface IWorkspaceOAuthConfigStore {
  get(workspaceId: string, service: string): Promise<OAuthClientConfig | undefined>;
  set(workspaceId: string, config: OAuthClientConfig): Promise<void>;
  delete(workspaceId: string, service: string): Promise<void>;
  list(workspaceId: string): Promise<OAuthClientConfig[]>;
}

export interface IWorkspaceTokenStore {
  add(workspaceId: string, record: RuntimeTokenRecord): Promise<void>;
  list(workspaceId: string): Promise<RuntimeTokenRecord[]>;
  revoke(workspaceId: string, id: string): Promise<boolean>;
  markUsed(workspaceId: string, id: string, usedAt: string): Promise<void>;
  findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined>;
}

export interface IWorkspaceRunLogStore {
  add(workspaceId: string, run: RunLog): Promise<void>;
  list(workspaceId: string, input?: RunLogListInput): Promise<RunLogPage>;
}

export interface WorkspaceScopedStores {
  connectionStore: IConnectionStore;
  oauthClientConfigStore: IOAuthClientConfigStore;
  oauthStateStore: IOAuthStateStore;
  runtimeTokenStore: IRuntimeTokenStore;
  runLogStore: IRunLogStore;
}

export interface RuntimeDatabase {
  /** Legacy default-workspace access for local tools and migration compatibility. */
  connectionStore: IConnectionStore;
  oauthClientConfigStore: IOAuthClientConfigStore;
  oauthStateStore: IOAuthStateStore;
  runtimeTokenStore: IRuntimeTokenStore;
  runLogStore: IRunLogStore;
  workspaceStore: IWorkspaceStore;
  membershipStore: IWorkspaceMembershipStore;
  createScopedStores(workspaceId: string): WorkspaceScopedStores;
}

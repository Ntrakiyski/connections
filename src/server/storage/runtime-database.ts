import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { WorkspaceSafetyConfigPatch } from "../../core/action-safety.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore } from "../../oauth/oauth-client-config-service.ts";
import type { OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore } from "../../oauth/oauth-flow-service.ts";
import type { AutomationStore } from "../automations/automation-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord, WorkspaceRole } from "./runtime-token-service.ts";

export interface Workspace {
  id: string;
  clerkOrgId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Set while the encrypted workspace backup is retained. */
  deletedAt?: string;
  /** ISO timestamp at which the backup must be permanently erased. */
  purgeAt?: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProvider {
  workspaceId: string;
  service: string;
  enabledBy: string;
  enabledAt: string;
}

export interface WorkspaceActionPolicy {
  workspaceId: string;
  actionId: string;
  requireApproval: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceSafetySettings {
  workspaceId: string;
  value: WorkspaceSafetyConfigPatch;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceProviderSafetySettings {
  workspaceId: string;
  service: string;
  value: WorkspaceSafetyConfigPatch;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceIdempotencyRecord {
  workspaceId: string;
  actionId: string;
  connectionName: string;
  idempotencyKey: string;
  inputHash: string;
  executionId: string;
  result: unknown;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  userId: string;
  event: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export type MeetingSyncState = "live" | "final";

export interface MeetingRecord {
  /** Internal database ID returned by list/upsert and used for GET lookups. */
  id: string;
  workspaceId: string;
  externalId: string;
  createdBy: string;
  state: MeetingSyncState;
  revision: number;
  title: string;
  transcript: string;
  transcriptSegments: unknown[];
  rawTranscript?: string;
  rawTranscriptSegments?: unknown[];
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MeetingWrite = Omit<MeetingRecord, "id" | "workspaceId" | "createdAt" | "updatedAt" | "finalizedAt">;
export type MeetingWriteResult = { status: "created" | "updated" | "ignored"; meeting: MeetingRecord };

export interface IMeetingStore {
  list(workspaceId: string): Promise<MeetingRecord[]>;
  getById(workspaceId: string, id: string): Promise<MeetingRecord | undefined>;
  /** Private sync key used only by PUT idempotency. */
  get(workspaceId: string, externalId: string): Promise<MeetingRecord | undefined>;
  put(workspaceId: string, input: MeetingWrite): Promise<MeetingWriteResult>;
}

export interface IWorkspaceControlStore {
  listProviders(workspaceId: string): Promise<WorkspaceProvider[]>;
  enableProvider(provider: WorkspaceProvider): Promise<void>;
  disableProvider(workspaceId: string, service: string): Promise<boolean>;
  getActionPolicy(workspaceId: string, actionId: string): Promise<WorkspaceActionPolicy | undefined>;
  setActionPolicy(policy: WorkspaceActionPolicy): Promise<void>;
  getWorkspaceSafetySettings(workspaceId: string): Promise<WorkspaceSafetySettings | undefined>;
  setWorkspaceSafetySettings(settings: WorkspaceSafetySettings): Promise<void>;
  getProviderSafetySettings(workspaceId: string, service: string): Promise<WorkspaceProviderSafetySettings | undefined>;
  setProviderSafetySettings(settings: WorkspaceProviderSafetySettings): Promise<void>;
  getIdempotencyRecord(
    workspaceId: string,
    actionId: string,
    connectionName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceIdempotencyRecord | undefined>;
  setIdempotencyRecord(record: WorkspaceIdempotencyRecord): Promise<void>;
  addAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]>;
}

export interface IWorkspaceStore {
  getByClerkOrgId(clerkOrgId: string): Promise<Workspace | undefined>;
  getById(id: string): Promise<Workspace | undefined>;
  create(workspace: Workspace): Promise<void>;
  /** Mirrors the Clerk-owned Organization profile name for lifecycle confirmation. */
  updateName(workspaceId: string, name: string, updatedAt: string): Promise<void>;
}

/** Persists the archive, restore, and irrevocable purge state for a workspace. */
export interface IWorkspaceLifecycleStore {
  archive(workspaceId: string, deletedAt: string, purgeAt: string): Promise<boolean>;
  restore(workspaceId: string, restoredAt: string): Promise<boolean>;
  purgeExpired(now: string): Promise<string[]>;
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
  workspaceLifecycleStore?: IWorkspaceLifecycleStore;
  membershipStore: IWorkspaceMembershipStore;
  workspaceControlStore: IWorkspaceControlStore;
  automationStore?: AutomationStore;
  meetingStore: IMeetingStore;
  createScopedStores(workspaceId: string): WorkspaceScopedStores;
}

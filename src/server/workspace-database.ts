import type { RuntimeDatabase, WorkspaceScopedStores } from "./storage/runtime-database.ts";
import type { WorkspaceContext } from "./storage/runtime-token-service.ts";

/** Workspace-bound runtime storage for one authenticated request. */
export type WorkspaceScopedStore = WorkspaceScopedStores;

export function createWorkspaceScopedStore(
  database: RuntimeDatabase,
  workspace: WorkspaceContext,
): WorkspaceScopedStore {
  return database.createScopedStores(workspace.workspaceId);
}

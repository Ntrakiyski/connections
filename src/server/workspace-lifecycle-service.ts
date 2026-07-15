import type { IWorkspaceControlStore, IWorkspaceLifecycleStore, Workspace } from "./storage/runtime-database.ts";
import type { RuntimeTokenService, WorkspaceContext } from "./storage/runtime-token-service.ts";

const retentionMs = 14 * 24 * 60 * 60 * 1000;

export class WorkspaceLifecycleError extends Error {
  readonly code:
    | "workspace_forbidden"
    | "invalid_confirmation"
    | "workspace_not_archived"
    | "workspace_lifecycle_failed";

  constructor(
    code: "workspace_forbidden" | "invalid_confirmation" | "workspace_not_archived" | "workspace_lifecycle_failed",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * Archives Connections-owned workspace data while Clerk keeps owning the
 * organization, identity, and membership surface. Stored credentials remain
 * encrypted in place throughout the 14-day restore window.
 */
export class WorkspaceLifecycleService {
  private readonly store: IWorkspaceLifecycleStore;
  private readonly tokens: RuntimeTokenService;
  private readonly audits: Pick<IWorkspaceControlStore, "addAuditEvent">;
  private readonly workspace: WorkspaceContext;
  private readonly getWorkspace: () => Promise<Workspace>;

  constructor(
    store: IWorkspaceLifecycleStore,
    tokens: RuntimeTokenService,
    audits: Pick<IWorkspaceControlStore, "addAuditEvent">,
    workspace: WorkspaceContext,
    getWorkspace: () => Promise<Workspace>,
  ) {
    this.store = store;
    this.tokens = tokens;
    this.audits = audits;
    this.workspace = workspace;
    this.getWorkspace = getWorkspace;
  }

  async archive(confirmation: string): Promise<{ deletedAt: string; purgeAt: string }> {
    this.assertAdmin();
    const workspace = await this.getWorkspace();
    if (confirmation.trim() !== workspace.name) {
      throw new WorkspaceLifecycleError("invalid_confirmation", "Type the workspace name exactly to delete it.");
    }
    const deletedAt = new Date().toISOString();
    const purgeAt = new Date(Date.now() + retentionMs).toISOString();
    if (!(await this.store.archive(this.workspace.workspaceId, deletedAt, purgeAt))) {
      throw new WorkspaceLifecycleError("workspace_lifecycle_failed", "The workspace could not be archived.");
    }
    await this.tokens.revokeTokensForWorkspace(this.workspace.workspaceId);
    await this.audit("workspace.deleted", { purgeAt });
    return { deletedAt, purgeAt };
  }

  async restore(): Promise<void> {
    this.assertAdmin();
    const workspace = await this.getWorkspace();
    if (!workspace.deletedAt || !workspace.purgeAt) {
      throw new WorkspaceLifecycleError("workspace_not_archived", "The workspace is not archived.");
    }
    const restoredAt = new Date().toISOString();
    if (!(await this.store.restore(this.workspace.workspaceId, restoredAt))) {
      throw new WorkspaceLifecycleError("workspace_lifecycle_failed", "The workspace could not be restored.");
    }
    await this.audit("workspace.restored");
  }

  purgeExpired(): Promise<string[]> {
    return this.store.purgeExpired(new Date().toISOString());
  }

  private assertAdmin(): void {
    if (this.workspace.role !== "admin") {
      throw new WorkspaceLifecycleError(
        "workspace_forbidden",
        "Only workspace admins can delete or restore a workspace.",
      );
    }
  }

  private async audit(event: string, details?: Record<string, unknown>): Promise<void> {
    await this.audits.addAuditEvent({
      id: crypto.randomUUID(),
      workspaceId: this.workspace.workspaceId,
      userId: this.workspace.userId,
      event,
      resourceType: "workspace",
      details,
      createdAt: new Date().toISOString(),
    });
  }
}

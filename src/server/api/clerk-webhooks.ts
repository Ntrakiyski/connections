import type {
  IWorkspaceControlStore,
  IWorkspaceMembershipStore,
  IWorkspaceStore,
} from "../storage/runtime-database.ts";
import type { RuntimeTokenService, WorkspaceRole } from "../storage/runtime-token-service.ts";
import type { Hono } from "hono";

import { verifyWebhook } from "@clerk/backend/webhooks";

export interface ClerkWebhookOptions {
  signingSecret?: string;
  workspaceStore: IWorkspaceStore;
  membershipStore: IWorkspaceMembershipStore;
  workspaceControls: IWorkspaceControlStore;
  runtimeTokens: RuntimeTokenService;
  removeMemberConnections(workspaceId: string, userId: string): Promise<void>;
}

/** Registers the Clerk-signed membership synchronization endpoint. */
export function registerClerkWebhookRoutes(app: Hono, options: ClerkWebhookOptions): void {
  app.post("/api/webhooks/clerk", async (context) => {
    if (!options.signingSecret) {
      return context.json({ error: "Clerk webhooks are not configured." }, 404);
    }

    let event: Awaited<ReturnType<typeof verifyWebhook>>;
    try {
      event = await verifyWebhook(context.req.raw, { signingSecret: options.signingSecret });
    } catch {
      return context.json({ error: "Invalid Clerk webhook signature." }, 400);
    }

    if (event.type === "organizationMembership.created" || event.type === "organizationMembership.updated") {
      const workspace = await ensureWorkspace(options, event.data.organization.id, event.data.organization.name);
      await options.membershipStore.setRole(
        workspace.id,
        event.data.public_user_data.user_id,
        mapClerkRole(event.data.role),
      );
      await audit(options, workspace.id, event.data.public_user_data.user_id, "membership.synced", "membership", {
        role: mapClerkRole(event.data.role),
      });
      return context.json({ ok: true });
    }

    if (event.type === "organizationMembership.deleted") {
      const workspace = await options.workspaceStore.getByClerkOrgId(event.data.organization.id);
      if (workspace) {
        await removeMember(options, workspace.id, event.data.public_user_data.user_id);
      }
      return context.json({ ok: true });
    }

    if (event.type === "organization.deleted" && event.data.id) {
      const workspace = await options.workspaceStore.getByClerkOrgId(event.data.id);
      if (workspace) {
        const members = await options.membershipStore.listMembers(workspace.id);
        await Promise.all(members.map((member) => removeMember(options, workspace.id, member.userId)));
      }
    }

    return context.json({ ok: true });
  });
}

export function mapClerkRole(role: string): WorkspaceRole {
  if (role === "org:admin") return "admin";
  if (role === "org:manager") return "manager";
  return "member";
}

async function ensureWorkspace(
  options: ClerkWebhookOptions,
  clerkOrgId: string,
  name: string,
): Promise<{ id: string }> {
  const existing = await options.workspaceStore.getByClerkOrgId(clerkOrgId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const workspace = { id: crypto.randomUUID(), clerkOrgId, name, createdAt: now, updatedAt: now };
  try {
    await options.workspaceStore.create(workspace);
    return workspace;
  } catch (error) {
    const racedWorkspace = await options.workspaceStore.getByClerkOrgId(clerkOrgId);
    if (racedWorkspace) return racedWorkspace;
    throw error;
  }
}

async function removeMember(options: ClerkWebhookOptions, workspaceId: string, userId: string): Promise<void> {
  await options.runtimeTokens.revokeTokensForUser(workspaceId, userId);
  await options.removeMemberConnections(workspaceId, userId);
  await options.membershipStore.removeMember(workspaceId, userId);
  await audit(options, workspaceId, userId, "membership.removed", "membership");
}

async function audit(
  options: ClerkWebhookOptions,
  workspaceId: string,
  userId: string,
  event: string,
  resourceType: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await options.workspaceControls.addAuditEvent({
    id: crypto.randomUUID(),
    workspaceId,
    userId,
    event,
    resourceType,
    details,
    createdAt: new Date().toISOString(),
  });
}

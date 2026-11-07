import type { AuthMailDelivery } from "./human-auth.ts";
import type { IIdentityMutationStore } from "./storage/identity-mutations.ts";
import type { OrganizationRole } from "./storage/runtime-database.ts";
import type { WorkspaceRole } from "./storage/runtime-token-service.ts";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CompanyOperationError,
  GovernanceMutation,
  commitGovernanceMutation,
  verifiedUser,
} from "./company-governance.ts";

export interface InvitationWorkspaceGrant {
  workspaceId: string;
  role: WorkspaceRole;
}
export interface CompanyInvitationCreation {
  organizationId: string;
  email: string;
  role: OrganizationRole;
  grants: InvitationWorkspaceGrant[];
}
export interface InvitationDeliveryResult {
  invitationId: string;
  delivery: "sent" | "failed";
}
export interface InvitationAcceptance {
  invitationId: string;
  organizationId: string;
}
export interface CompanyInvitationOptions {
  publicOrigin: string;
  sendMail: AuthMailDelivery;
}
export interface PendingCompanyInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
}

const creationSchema = z
  .object({
    organizationId: z.string().min(1),
    email: z.email().transform((email) => email.toLowerCase()),
    role: z.enum(["owner", "admin", "member"]),
    grants: z.array(z.object({ workspaceId: z.string().min(1), role: z.enum(["admin", "manager", "member"]) })).max(25),
  })
  .refine(
    (input) => new Set(input.grants.map((grant) => grant.workspaceId)).size === input.grants.length,
    "Workspace grants must be unique.",
  );
const dateSchema = z.union([z.string(), z.number(), z.date()]).transform((date) => new Date(date).toISOString());
const invitationSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  organization_name: z.string(),
  email: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  status: z.string(),
  expires_at: dateSchema,
  inviter_id: z.string(),
});

/** Better Auth owns invitation records; these workflows atomically authorize and issue workspace grants. */
export class CompanyInvitationService {
  private readonly store: IIdentityMutationStore;
  private readonly options: CompanyInvitationOptions;
  constructor(store: IIdentityMutationStore, options: CompanyInvitationOptions) {
    this.store = store;
    this.options = options;
  }

  async create(actorId: string, input: CompanyInvitationCreation): Promise<InvitationDeliveryResult> {
    const data = creationSchema.parse(input);
    const invitationId = randomUUID();
    const plan = new GovernanceMutation(data.organizationId, actorId);
    plan.companyAdmin();
    if (data.grants.length)
      plan.assert(
        "invitation_valid",
        data.grants
          .map(() => "exists(select 1 from workspaces where id=? and organization_id=? and deleted_at is null)")
          .join(" and "),
        data.grants.flatMap((grant) => [grant.workspaceId, data.organizationId]),
      );
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    plan.add(
      "insert into organization_invitations(id, organization_id, email, role, status, expires_at, created_at, inviter_id) values(?,?,?,?,'pending',?,?,?)",
      [invitationId, data.organizationId, data.email, data.role, expiresAt, plan.now, actorId],
    );
    for (const grant of data.grants)
      plan.add(
        "insert into workspace_invitation_grants(invitation_id, organization_id, workspace_id, role) values(?,?,?,?)",
        [invitationId, data.organizationId, grant.workspaceId, grant.role],
      );
    plan.audit("company.invitation.created", undefined, undefined, {
      invitationId,
      email: data.email,
      role: data.role,
      grants: data.grants,
    });
    await commitGovernanceMutation(this.store, plan, data.organizationId);
    return this.deliver(invitationId, data.email);
  }

  async resend(actorId: string, invitationId: string): Promise<InvitationDeliveryResult> {
    const invitation = await this.invitation(invitationId);
    const plan = new GovernanceMutation(invitation.organization_id, actorId);
    plan.companyAdmin();
    this.pending(plan, invitationId);
    plan.audit("company.invitation.resent", undefined, undefined, { invitationId });
    await commitGovernanceMutation(this.store, plan, invitation.organization_id);
    return this.deliver(invitationId, invitation.email);
  }

  async cancel(actorId: string, invitationId: string): Promise<void> {
    const invitation = await this.invitation(invitationId);
    const plan = new GovernanceMutation(invitation.organization_id, actorId);
    plan.companyAdmin();
    plan.add("update organization_invitations set status='canceled' where id=? and status='pending'", [invitationId]);
    plan.audit("company.invitation.canceled", undefined, undefined, { invitationId });
    await commitGovernanceMutation(this.store, plan, invitation.organization_id);
  }

  async accept(userId: string, invitationId: string): Promise<InvitationAcceptance> {
    const invitation = await this.invitation(invitationId);
    const result = { invitationId, organizationId: invitation.organization_id };
    if (await this.receipt(userId, invitationId)) return result;
    const plan = new GovernanceMutation(invitation.organization_id, userId);
    plan.assert(
      "authorized",
      "exists(select 1 from auth_user u join organization_invitations i on lower(i.email)=lower(u.email) where u.id=? and u.email_verified=true and i.id=?)",
      [userId, invitationId],
    );
    this.pending(plan, invitationId);
    plan.companyAdmin(invitation.inviter_id);
    plan.assert(
      "invitation_valid",
      "not exists(select 1 from workspace_invitation_grants g left join workspaces w on w.id=g.workspace_id and w.organization_id=g.organization_id where g.invitation_id=? and (w.id is null or w.deleted_at is not null))",
      [invitationId],
    );
    // Existing directory roles and workspace grants remain independently governed.
    plan.add(
      "insert into organization_memberships(id, organization_id, user_id, role, created_at) values(?,?,?,?,?) on conflict(organization_id,user_id) do nothing",
      [randomUUID(), invitation.organization_id, userId, invitation.role, plan.now],
    );
    plan.add(
      "insert into workspace_memberships(workspace_id, organization_id, user_id, role, created_at, updated_at) select workspace_id, organization_id, ?, role, ?, ? from workspace_invitation_grants where invitation_id=? on conflict(workspace_id,user_id) do nothing",
      [userId, plan.now, plan.now, invitationId],
    );
    plan.add("update organization_invitations set status='accepted' where id=? and status='pending'", [invitationId]);
    plan.add("insert into invitation_acceptances(invitation_id, user_id, accepted_at) values(?,?,?)", [
      invitationId,
      userId,
      plan.now,
    ]);
    plan.add(
      "insert into audit_events(id, workspace_id, user_id, event, resource_type, resource_id, details, created_at) select ? || workspace_id, workspace_id, ?, 'workspace.member.granted', 'workspace_member', ?, ?, ? from workspace_invitation_grants where invitation_id=?",
      [
        randomUUID(),
        userId,
        userId,
        JSON.stringify({ subjectId: userId, invitationId, inviterId: invitation.inviter_id }),
        plan.now,
        invitationId,
      ],
    );
    plan.audit("company.invitation.accepted", userId, undefined, { invitationId, inviterId: invitation.inviter_id });
    try {
      await commitGovernanceMutation(this.store, plan, invitation.organization_id);
    } catch (error) {
      // Concurrent successful finalization produces one receipt. Retrying never recreates a removed grant.
      if (
        error instanceof CompanyOperationError &&
        error.code === "invitation_invalid" &&
        (await this.receipt(userId, invitationId))
      )
        return result;
      throw error;
    }
    return result;
  }

  async listForRecipient(userId: string): Promise<PendingCompanyInvitation[]> {
    const rows = await this.store.read({
      sql: `select i.*, o.name as organization_name from organization_invitations i join organizations o on o.id=i.organization_id join auth_user u on lower(u.email)=lower(i.email) where u.id=? and u.email_verified=true and i.status='pending' and i.expires_at > ${this.store.currentTimeSQL} order by i.created_at, i.id`,
      values: [userId],
    });
    return rows.map((value) => {
      const row = invitationSchema.parse(value);
      return {
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        email: row.email,
        role: row.role,
        expiresAt: row.expires_at,
      };
    });
  }

  private pending(plan: GovernanceMutation, invitationId: string): void {
    plan.assert(
      "invitation_valid",
      `exists(select 1 from organization_invitations where id=? and status='pending' and expires_at > ${this.store.currentTimeSQL})`,
      [invitationId],
    );
  }

  private async invitation(invitationId: string): Promise<z.output<typeof invitationSchema>> {
    const rows = await this.store.read({
      sql: "select i.*, o.name as organization_name from organization_invitations i join organizations o on o.id=i.organization_id where i.id=?",
      values: [invitationId],
    });
    if (!rows.length)
      throw new CompanyOperationError("invitation_invalid", "This invitation is no longer available.", 404);
    return invitationSchema.parse(rows[0]);
  }

  private async receipt(userId: string, invitationId: string): Promise<boolean> {
    return (
      (
        await this.store.read({
          sql: `select a.invitation_id from invitation_acceptances a where a.invitation_id=? and a.user_id=? and ${verifiedUser}`,
          values: [invitationId, userId, userId],
        })
      ).length > 0
    );
  }

  private async deliver(invitationId: string, email: string): Promise<InvitationDeliveryResult> {
    const url = new URL("/", this.options.publicOrigin);
    url.searchParams.set("invitation", invitationId);
    try {
      await this.options.sendMail({
        to: email,
        subject: "Your Connections company invitation",
        text: `Sign in with this verified email to accept your company invitation: ${url}`,
      });
      return { invitationId, delivery: "sent" };
    } catch {
      return { invitationId, delivery: "failed" };
    }
  }
}

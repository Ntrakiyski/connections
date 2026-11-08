import type { IIdentityMutationStore } from "./storage/identity-mutations.ts";
import type { OrganizationRole } from "./storage/runtime-database.ts";
import type { WorkspaceRole } from "./storage/runtime-token-service.ts";

import { z } from "zod";
import { GovernanceMutation, commitGovernanceMutation } from "./company-governance.ts";

export interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
}
export interface CompanyPerson {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
}
export interface CompanyWorkspace {
  id: string;
  name: string;
  archived: boolean;
}
export interface CompanyWorkspaceGrant {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}
export interface CompanyOverview {
  members: CompanyPerson[];
  workspaces: CompanyWorkspace[];
  grants: CompanyWorkspaceGrant[];
  invitations: CompanyPendingInvitation[];
  audit: CompanyAuditEvent[];
}
export interface CompanyPendingInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  status: string;
  expiresAt: string;
}
export interface CompanyAuditEvent {
  id: string;
  actorId: string;
  subjectId: string | null;
  workspaceId: string | null;
  event: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  status: z.string(),
  expires_at: z.union([z.string(), z.number(), z.date()]).transform((date) => new Date(date).toISOString()),
});
const auditSchema = z.object({
  id: z.string(),
  actor_id: z.string(),
  subject_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  event: z.string(),
  details: z.string().nullable(),
  created_at: z.string(),
});
const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(["owner", "admin", "member"]),
});
const personSchema = z.object({
  user_id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["owner", "admin", "member"]),
});
const workspaceSchema = z.object({ id: z.string(), name: z.string(), deleted_at: z.string().nullable() });
const grantSchema = z.object({
  workspace_id: z.string(),
  user_id: z.string(),
  role: z.enum(["admin", "manager", "member"]),
});

/** Company governance views expose directory and grants, never provider-resource data. */
export class CompanyDirectoryService {
  private readonly store: IIdentityMutationStore;
  constructor(store: IIdentityMutationStore) {
    this.store = store;
  }

  async list(userId: string): Promise<CompanySummary[]> {
    const rows = await this.store.read({
      sql: "select o.id, o.name, o.slug, m.role from organizations o join organization_memberships m on m.organization_id=o.id join auth_user u on u.id=m.user_id where m.user_id=? and u.email_verified=true order by o.name, o.id",
      values: [userId],
    });
    return rows.map((row) => companySchema.parse(row));
  }

  async overview(userId: string, organizationId: string): Promise<CompanyOverview> {
    const plan = new GovernanceMutation(organizationId, userId);
    plan.companyAdmin();
    plan.add(
      "select m.user_id, u.name, u.email, m.role from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=? order by u.name, u.id",
      [organizationId],
    );
    plan.add("select id, name, deleted_at from workspaces where organization_id=? order by name, id", [organizationId]);
    plan.add(
      "select workspace_id, user_id, role from workspace_memberships where organization_id=? order by workspace_id, user_id",
      [organizationId],
    );
    plan.add(
      "select id, email, role, status, expires_at from organization_invitations where organization_id=? and status='pending' order by created_at, id",
      [organizationId],
    );
    plan.add(
      "select id, actor_id, subject_id, workspace_id, event, details, created_at from organization_audit_events where organization_id=? order by created_at desc, id desc limit 100",
      [organizationId],
    );
    const results = await commitGovernanceMutation(this.store, plan, organizationId);
    return {
      members: (results[1]?.rows ?? []).map((value) => {
        const row = personSchema.parse(value);
        return { userId: row.user_id, name: row.name, email: row.email, role: row.role };
      }),
      workspaces: (results[2]?.rows ?? []).map((value) => {
        const row = workspaceSchema.parse(value);
        return { id: row.id, name: row.name, archived: row.deleted_at !== null };
      }),
      grants: (results[3]?.rows ?? []).map((value) => {
        const row = grantSchema.parse(value);
        return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
      }),
      invitations: (results[4]?.rows ?? []).map((value) => {
        const row = invitationSchema.parse(value);
        return { id: row.id, email: row.email, role: row.role, status: row.status, expiresAt: row.expires_at };
      }),
      audit: (results[5]?.rows ?? []).map((value) => {
        const row = auditSchema.parse(value);
        return {
          id: row.id,
          actorId: row.actor_id,
          subjectId: row.subject_id,
          workspaceId: row.workspace_id,
          event: row.event,
          details: row.details ? z.record(z.string(), z.unknown()).parse(JSON.parse(row.details)) : null,
          createdAt: row.created_at,
        };
      }),
    };
  }
}

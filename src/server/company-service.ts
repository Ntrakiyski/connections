import type { IdentityStatement, IIdentityMutationStore } from "./storage/identity-mutations.ts";
import type { OrganizationRole } from "./storage/runtime-database.ts";
import type { WorkspaceRole } from "./storage/runtime-token-service.ts";

import { randomUUID } from "node:crypto";
import { z } from "zod";

export interface CompanyCreation {
  name: string;
  slug: string;
  workspaceName: string;
}

export interface CompanyProvisioningResult {
  organizationId: string;
  workspaceId: string;
}

export interface WorkspaceCreation {
  organizationId: string;
  name: string;
  initialAdminId: string;
}

export interface WorkspaceGrantChange {
  organizationId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface OrganizationRoleChange {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export class CompanyOperationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const nameSchema = z.string().trim().min(1).max(160);
const identityIdSchema = z.string().min(1).max(200);
const companyCreationSchema = z.object({
  name: nameSchema,
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  workspaceName: nameSchema,
});
const workspaceCreationSchema = z.object({
  organizationId: z.string().min(1),
  name: nameSchema,
  initialAdminId: z.string().min(1),
});
const grantSchema = z.object({
  organizationId: z.string().min(1),
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["admin", "manager", "member"]),
});
const directoryRoleSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]),
});

/** Governs company people and explicit grants; it does not authorize provider resources. */
export class CompanyService {
  private readonly store: IIdentityMutationStore;
  constructor(store: IIdentityMutationStore) {
    this.store = store;
  }

  async createCompany(actorId: string, input: CompanyCreation): Promise<CompanyProvisioningResult> {
    const data = companyCreationSchema.parse(input);
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const plan = new GovernanceMutation(organizationId, actorId);
    plan.assert("authorized", verifiedUser, [actorId]);
    plan.add("insert into organizations(id, name, slug, created_at) values(?,?,?,?)", [
      organizationId,
      data.name,
      data.slug,
      plan.now,
    ]);
    plan.add(
      "insert into organization_memberships(id, organization_id, user_id, role, created_at) values(?,?,?,'owner',?)",
      [randomUUID(), organizationId, actorId, plan.now],
    );
    plan.workspace(workspaceId, data.workspaceName, actorId);
    plan.audit("company.created", actorId, workspaceId);
    await this.commit(plan);
    return { organizationId, workspaceId };
  }

  async createWorkspace(actorId: string, input: WorkspaceCreation): Promise<{ workspaceId: string }> {
    const data = workspaceCreationSchema.parse(input);
    const workspaceId = randomUUID();
    const plan = new GovernanceMutation(data.organizationId, actorId);
    plan.companyAdmin();
    plan.assert("authorized", verifiedCompanyMember, [data.organizationId, data.initialAdminId]);
    plan.workspace(workspaceId, data.name, data.initialAdminId);
    plan.audit("workspace.created", data.initialAdminId, workspaceId);
    await this.commit(plan, data.organizationId);
    return { workspaceId };
  }

  async setOrganizationRole(actorId: string, input: OrganizationRoleChange): Promise<void> {
    const data = directoryRoleSchema.parse(input);
    const plan = new GovernanceMutation(data.organizationId, actorId);
    plan.companyAdmin();
    plan.assert("authorized", verifiedCompanyMember, [data.organizationId, data.userId]);
    plan.assert(
      "owner_preserved",
      `exists(select 1 from organization_memberships where organization_id=? and user_id=? and (role != 'owner' or ?='owner' or (select count(*) from organization_memberships where organization_id=? and role='owner') > 1))`,
      [data.organizationId, data.userId, data.role, data.organizationId],
    );
    plan.add("update organization_memberships set role=? where organization_id=? and user_id=?", [
      data.role,
      data.organizationId,
      data.userId,
    ]);
    plan.audit("company.member.role_changed", data.userId, undefined, { role: data.role });
    await this.commit(plan, data.organizationId);
  }

  async setWorkspaceGrant(actorId: string, input: WorkspaceGrantChange): Promise<void> {
    const data = grantSchema.parse(input);
    const plan = new GovernanceMutation(data.organizationId, actorId);
    plan.workspaceAdmin(data.workspaceId, true);
    plan.assert("authorized", verifiedCompanyMember, [data.organizationId, data.userId]);
    plan.preserveAdmin(data.workspaceId, data.userId, data.role);
    plan.add(
      "insert into workspace_memberships(workspace_id, organization_id, user_id, role, created_at, updated_at) values(?,?,?,?,?,?) on conflict(workspace_id,user_id) do update set role=excluded.role, updated_at=excluded.updated_at",
      [data.workspaceId, data.organizationId, data.userId, data.role, plan.now, plan.now],
    );
    plan.audit("workspace.member.granted", data.userId, data.workspaceId, { role: data.role });
    await this.commit(plan, data.organizationId);
  }

  async removeWorkspaceGrant(
    actorId: string,
    organizationId: string,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    identityIdSchema.parse(organizationId);
    identityIdSchema.parse(workspaceId);
    identityIdSchema.parse(userId);
    const plan = new GovernanceMutation(organizationId, actorId);
    plan.workspaceAdmin(workspaceId, false);
    plan.preserveAdmin(workspaceId, userId);
    plan.offboard(workspaceId, userId);
    plan.add("delete from workspace_memberships where workspace_id=? and user_id=?", [workspaceId, userId]);
    plan.audit("workspace.member.removed", userId, workspaceId);
    await this.commit(plan, organizationId);
  }

  async removeOrganizationMember(actorId: string, organizationId: string, userId: string): Promise<void> {
    identityIdSchema.parse(organizationId);
    identityIdSchema.parse(userId);
    const plan = new GovernanceMutation(organizationId, actorId);
    plan.companyAdmin();
    plan.assert(
      "owner_preserved",
      "not exists(select 1 from organization_memberships where organization_id=? and user_id=? and role='owner') or exists(select 1 from organization_memberships where organization_id=? and user_id!=? and role='owner')",
      [organizationId, userId, organizationId, userId],
    );
    plan.assert(
      "admin_preserved",
      "not exists(select 1 from workspace_memberships g where g.organization_id=? and g.user_id=? and g.role='admin' and not exists(select 1 from workspace_memberships other_grant join organization_memberships m on m.organization_id=other_grant.organization_id and m.user_id=other_grant.user_id where other_grant.workspace_id=g.workspace_id and other_grant.user_id!=g.user_id and other_grant.role='admin'))",
      [organizationId, userId],
    );
    plan.add(
      "update runtime_tokens set revoked_at=? where user_id=? and workspace_id in (select id from workspaces where organization_id=?) and revoked_at is null",
      [plan.now, userId, organizationId],
    );
    plan.add(
      "delete from connections where created_by=? and workspace_id in (select id from workspaces where organization_id=?)",
      [userId, organizationId],
    );
    plan.add(
      "delete from oauth_states where (user_id=? or user_id is null) and workspace_id in (select id from workspaces where organization_id=?)",
      [userId, organizationId],
    );
    plan.add(
      "update organization_invitations set status='canceled' where organization_id=? and inviter_id=? and status='pending'",
      [organizationId, userId],
    );
    plan.add("delete from workspace_memberships where organization_id=? and user_id=?", [organizationId, userId]);
    plan.add("delete from organization_memberships where organization_id=? and user_id=?", [organizationId, userId]);
    plan.audit("company.member.removed", userId);
    await this.commit(plan, organizationId);
  }

  private async commit(plan: GovernanceMutation, organizationId?: string): Promise<void> {
    try {
      await this.store.commit(plan.statements(), organizationId);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes("identity_forbidden"))
        throw new CompanyOperationError(
          "company_forbidden",
          "The current account cannot perform this company operation.",
          403,
        );
      if (error.message.includes("identity_last_owner"))
        throw new CompanyOperationError("last_company_owner", "A company must retain an owner.", 409);
      if (error.message.includes("identity_last_admin"))
        throw new CompanyOperationError("last_workspace_admin", "A workspace must retain an admin.", 409);
      throw error;
    }
  }
}

const verifiedUser = "exists(select 1 from auth_user where id=? and email_verified=true)";
const verifiedCompanyMember =
  "exists(select 1 from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=? and m.user_id=? and u.email_verified=true)";

type AssertionKind = "authorized" | "owner_preserved" | "admin_preserved" | "invitation_valid";

/** SQL guards evaluate inside the same atomic write unit as every dependent mutation. */
class GovernanceMutation {
  readonly now = new Date().toISOString();
  private readonly organizationId: string;
  private readonly actorId: string;
  private readonly writes: IdentityStatement[] = [];
  private readonly checks: string[] = [];
  constructor(organizationId: string, actorId: string) {
    this.organizationId = organizationId;
    this.actorId = actorId;
  }

  add(sql: string, values: IdentityStatement["values"]): void {
    this.writes.push({ sql, values });
  }

  assert(kind: AssertionKind, condition: string, values: IdentityStatement["values"]): void {
    const id = randomUUID();
    this.checks.push(id);
    this.add(`insert into identity_mutation_checks(id, ${kind}) select ?, case when (${condition}) then 1 else 0 end`, [
      id,
      ...values,
    ]);
  }

  companyAdmin(): void {
    this.assert(
      "authorized",
      "exists(select 1 from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=? and m.user_id=? and m.role in ('owner','admin') and u.email_verified=true)",
      [this.organizationId, this.actorId],
    );
  }

  workspaceAdmin(workspaceId: string, requireActive: boolean): void {
    this.assert(
      "authorized",
      `exists(select 1 from workspaces w join organization_memberships m on m.organization_id=w.organization_id join auth_user u on u.id=m.user_id where w.id=? and w.organization_id=? and m.user_id=? and u.email_verified=true ${requireActive ? "and w.deleted_at is null" : ""} and (m.role in ('owner','admin') or exists(select 1 from workspace_memberships g where g.workspace_id=w.id and g.user_id=m.user_id and g.role='admin')))`,
      [workspaceId, this.organizationId, this.actorId],
    );
  }

  preserveAdmin(workspaceId: string, userId: string, role = "removed"): void {
    this.assert(
      "admin_preserved",
      `not exists(select 1 from workspace_memberships where workspace_id=? and user_id=? and role='admin') or ?='admin' or exists(select 1 from workspace_memberships g join organization_memberships m on m.organization_id=g.organization_id and m.user_id=g.user_id where g.workspace_id=? and g.user_id!=? and g.role='admin')`,
      [workspaceId, userId, role, workspaceId, userId],
    );
  }

  workspace(workspaceId: string, name: string, initialAdminId: string): void {
    this.add(
      "insert into workspaces(id, organization_id, clerk_org_id, name, created_at, updated_at) values(?,?,?,?,?,?)",
      [workspaceId, this.organizationId, `connections-workspace:${workspaceId}`, name, this.now, this.now],
    );
    this.add(
      "insert into workspace_memberships(workspace_id, organization_id, user_id, role, created_at, updated_at) values(?,?,?,'admin',?,?)",
      [workspaceId, this.organizationId, initialAdminId, this.now, this.now],
    );
  }

  offboard(workspaceId: string, userId: string): void {
    this.add("update runtime_tokens set revoked_at=? where workspace_id=? and user_id=? and revoked_at is null", [
      this.now,
      workspaceId,
      userId,
    ]);
    this.add("delete from connections where workspace_id=? and created_by=?", [workspaceId, userId]);
    this.add("delete from oauth_states where workspace_id=? and (user_id=? or user_id is null)", [workspaceId, userId]);
  }

  audit(event: string, subjectId?: string, workspaceId?: string, details?: Record<string, unknown>): void {
    this.add(
      "insert into organization_audit_events(id, organization_id, actor_id, subject_id, workspace_id, event, details, created_at) values(?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        this.organizationId,
        this.actorId,
        subjectId ?? null,
        workspaceId ?? null,
        event,
        details ? JSON.stringify(details) : null,
        this.now,
      ],
    );
  }

  statements(): IdentityStatement[] {
    return [
      ...this.writes,
      ...this.checks.map((id) => ({ sql: "delete from identity_mutation_checks where id=?", values: [id] })),
    ];
  }
}

import type {
  IdentityStatement,
  IdentityMutationResult,
  IIdentityMutationStore,
} from "./storage/identity-mutations.ts";

import { randomUUID } from "node:crypto";

export class CompanyOperationError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409;
  constructor(code: string, message: string, status: 400 | 403 | 404 | 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function commitGovernanceMutation(
  store: IIdentityMutationStore,
  plan: GovernanceMutation,
  organizationId?: string,
): Promise<IdentityMutationResult[]> {
  try {
    return await store.commit(plan.statements(), organizationId);
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
    if (error.message.includes("identity_invitation_invalid"))
      throw new CompanyOperationError("invitation_invalid", "This invitation is no longer available.", 409);
    throw error;
  }
}

export const verifiedUser = "exists(select 1 from auth_user where id=? and email_verified=true)";
export const verifiedCompanyMember =
  "exists(select 1 from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=? and m.user_id=? and u.email_verified=true)";

type AssertionKind = "authorized" | "owner_preserved" | "admin_preserved" | "invitation_valid";

/** SQL guards evaluate inside the same atomic write unit as every dependent mutation. */
export class GovernanceMutation {
  readonly now: string = new Date().toISOString();
  private readonly organizationId: string;
  private readonly actorId: string;
  private readonly writes: IdentityStatement[] = [];
  private readonly checks: string[] = [];
  constructor(organizationId: string, actorId: string) {
    this.organizationId = organizationId;
    this.actorId = actorId;
  }

  add(sql: string, values: IdentityStatement["values"]): number {
    this.writes.push({ sql, values });
    return this.writes.length - 1;
  }

  assert(kind: AssertionKind, condition: string, values: IdentityStatement["values"]): void {
    const id = randomUUID();
    this.checks.push(id);
    this.add(`insert into identity_mutation_checks(id, ${kind}) select ?, case when (${condition}) then 1 else 0 end`, [
      id,
      ...values,
    ]);
  }

  companyAdmin(userId: string = this.actorId): void {
    this.assert(
      "authorized",
      "exists(select 1 from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=? and m.user_id=? and m.role in ('owner','admin') and u.email_verified=true)",
      [this.organizationId, userId],
    );
  }

  workspaceAdmin(workspaceId: string, requireActive: boolean, userId: string = this.actorId): void {
    this.assert(
      "authorized",
      `exists(select 1 from workspaces w join organization_memberships m on m.organization_id=w.organization_id join auth_user u on u.id=m.user_id where w.id=? and w.organization_id=? and m.user_id=? and u.email_verified=true ${requireActive ? "and w.deleted_at is null" : ""} and (m.role in ('owner','admin') or exists(select 1 from workspace_memberships g where g.workspace_id=w.id and g.user_id=m.user_id and g.role='admin')))`,
      [workspaceId, this.organizationId, userId],
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
    if (workspaceId)
      this.add(
        "insert into audit_events(id, workspace_id, user_id, event, resource_type, resource_id, details, created_at) values(?,?,?,?,?,?,?,?)",
        [
          randomUUID(),
          workspaceId,
          this.actorId,
          event,
          "workspace_member",
          subjectId ?? null,
          JSON.stringify({ ...details, subjectId: subjectId ?? null }),
          this.now,
        ],
      );
  }

  statements(): IdentityStatement[] {
    return [
      ...this.writes,
      ...(this.checks.length
        ? [
            {
              sql: `delete from identity_mutation_checks where id in (${this.checks.map(() => "?").join(",")})`,
              values: this.checks,
            },
          ]
        : []),
    ];
  }
}

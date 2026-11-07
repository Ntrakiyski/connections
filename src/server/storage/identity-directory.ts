import type { OrganizationRole } from "./runtime-database.ts";
import type { WorkspaceRole } from "./runtime-token-service.ts";

import { z } from "zod";

export interface IdentityWorkspace {
  organizationId: string;
  organizationName: string;
  organizationRole: OrganizationRole;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  archived: boolean;
}

/** Live directory facts; company roles never imply a workspace resource grant. */
export interface IIdentityDirectory {
  getOrganizationRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>;
  listWorkspaces(userId: string): Promise<IdentityWorkspace[]>;
}

export interface IdentityQuery {
  (sql: string, values: string[]): Promise<unknown[]>;
}

const organizationRole = z.enum(["owner", "admin", "member"]);
const workspaceRow = z.object({
  organization_id: z.string(),
  organization_name: z.string(),
  organization_role: organizationRole,
  workspace_id: z.string(),
  workspace_name: z.string(),
  role: z.enum(["admin", "manager", "member"]),
  deleted_at: z.string().nullable(),
});

/** Shared query contract for PostgreSQL, SQLite and D1. Values are always bound. */
export class SqlIdentityDirectory implements IIdentityDirectory {
  private readonly query: IdentityQuery;

  constructor(query: IdentityQuery) {
    this.query = query;
  }

  async getOrganizationRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined> {
    const rows = await this.query(
      "select role from organization_memberships where organization_id = ? and user_id = ?",
      [organizationId, userId],
    );
    return rows.length ? z.object({ role: organizationRole }).parse(rows[0]).role : undefined;
  }

  async listWorkspaces(userId: string): Promise<IdentityWorkspace[]> {
    const rows = await this.query(
      `select o.id as organization_id, o.name as organization_name, om.role as organization_role,
        w.id as workspace_id, w.name as workspace_name, wm.role, w.deleted_at
       from organization_memberships om
       join organizations o on o.id = om.organization_id
       join workspaces w on w.organization_id = o.id
       join workspace_memberships wm on wm.workspace_id = w.id
         and wm.organization_id = o.id and wm.user_id = om.user_id
       where om.user_id = ? order by o.name, w.name, w.id`,
      [userId],
    );
    return rows.map((value) => {
      const row = workspaceRow.parse(value);
      return {
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        organizationRole: row.organization_role,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        role: row.role,
        archived: row.deleted_at !== null,
      };
    });
  }
}

import type { ConnectionActor } from "../../connection-service.ts";
import type { IdentityStatement, IdentityMutationResult, IIdentityMutationStore } from "./identity-mutations.ts";

import { ConnectionError } from "../../connection-service.ts";
import { CompanyOperationError, GovernanceMutation, commitGovernanceMutation } from "../company-governance.ts";

export interface ConnectionMutation {
  workspaceId: string;
  service: string;
  connectionName: string;
  actor?: ConnectionActor;
  allowCreate?: boolean;
  requireProvider?: boolean;
  statement: IdentityStatement;
}

/** Locks governance and credential changes together. Stale request roles never authorize a mapped workspace write. */
export async function commitConnectionMutation(
  store: IIdentityMutationStore,
  input: ConnectionMutation,
): Promise<IdentityMutationResult> {
  const rows = await store.read({
    sql: "select organization_id from workspaces where id=?",
    values: [input.workspaceId],
  });
  const parent = rows[0]?.organization_id;
  const organizationId = typeof parent === "string" ? parent : undefined;
  const plan = new GovernanceMutation(organizationId ?? "", input.actor?.userId ?? "");
  if (input.actor) {
    const { userId, canManageWorkspace } = input.actor;
    plan.assert(
      "authorized",
      `exists(select 1 from workspaces w where w.id=? and w.deleted_at is null and (w.organization_id is null or exists(select 1 from organization_memberships m join workspace_memberships g on g.organization_id=m.organization_id and g.user_id=m.user_id where m.organization_id=w.organization_id and m.user_id=? and g.workspace_id=w.id)))`,
      [input.workspaceId, userId],
    );
    plan.assert(
      "authorized",
      `exists(select 1 from workspaces w where w.id=? and ((w.organization_id is null and ?=1) or exists(select 1 from workspace_memberships g where g.workspace_id=w.id and g.organization_id=w.organization_id and g.user_id=? and g.role in ('admin','manager')))) or exists(select 1 from connections where workspace_id=? and service=? and connection_name=? and created_by=?) or (?=1 and not exists(select 1 from connections where workspace_id=? and service=? and connection_name=?))`,
      [
        input.workspaceId,
        canManageWorkspace ? 1 : 0,
        userId,
        input.workspaceId,
        input.service,
        input.connectionName,
        userId,
        input.allowCreate ? 1 : 0,
        input.workspaceId,
        input.service,
        input.connectionName,
      ],
    );
    if (input.requireProvider)
      plan.assert(
        "authorized",
        "exists(select 1 from workspaces w where w.id=? and (w.organization_id is null or exists(select 1 from workspace_providers where workspace_id=w.id and service=?)))",
        [input.workspaceId, input.service],
      );
  }
  const index = plan.add(input.statement.sql, input.statement.values);
  try {
    const results = await commitGovernanceMutation(store, plan, organizationId);
    const result = results[index];
    if (!result) throw new Error("Credential mutation result is missing.");
    return result;
  } catch (error) {
    if (error instanceof CompanyOperationError)
      throw new ConnectionError(
        "connection_not_found",
        `${input.service} connection not found: ${input.connectionName}.`,
      );
    throw error;
  }
}

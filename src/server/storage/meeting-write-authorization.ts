import type { IdentityStatement } from "./identity-mutations.ts";
import type { MeetingWriteAuthorization } from "./runtime-database.ts";

/** Checked in the write transaction/batch after body parsing, so delayed uploads cannot outrun removal. */
export function meetingWriteGuard(
  workspaceId: string,
  userId: string,
  authorization: MeetingWriteAuthorization,
  id: string,
  currentTimeSQL: string,
): IdentityStatement {
  return {
    sql: `insert into identity_mutation_checks(id,authorized) select ?,case when exists(
    select 1 from meetings_oauth_bindings b
    join workspaces w on w.id=b.workspace_id and w.organization_id=b.organization_id
    join workspace_memberships wm on wm.workspace_id=w.id and wm.organization_id=w.organization_id and wm.user_id=b.user_id
    join organization_memberships om on om.organization_id=w.organization_id and om.user_id=b.user_id
    join auth_user u on u.id=b.user_id
    join auth_session s on s.id=b.session_id and s.user_id=b.user_id
    join auth_oauth_access_token t on t.reference_id=b.id and t.user_id=b.user_id and t.session_id=s.id
    where b.id=? and b.user_id=? and b.workspace_id=? and b.organization_id=? and b.revoked_at is null
      and b.expires_at>${currentTimeSQL} and w.deleted_at is null and u.email_verified=true
      and s.expires_at>${currentTimeSQL} and t.id=? and t.revoked is null
      and t.expires_at>${currentTimeSQL} and t.client_id='meetings-desktop-v1'
      and t.scopes like '%"meetings:write"%'
  ) then 1 else 0 end`,
    values: [id, authorization.referenceId, userId, workspaceId, authorization.organizationId, authorization.tokenId],
  };
}

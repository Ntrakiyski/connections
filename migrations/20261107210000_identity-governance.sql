-- Application-owned transactional guards, grant recipes and governance audit.
-- Guards are inserted and removed in the same transaction/batch; a failed
-- assertion aborts the entire mutation, including membership and cleanup writes.
create table identity_mutation_checks (
  id text primary key,
  authorized integer not null default 1 constraint identity_forbidden check(authorized = 1),
  owner_preserved integer not null default 1 constraint identity_last_owner check(owner_preserved = 1),
  admin_preserved integer not null default 1 constraint identity_last_admin check(admin_preserved = 1),
  invitation_valid integer not null default 1 constraint identity_invitation_invalid check(invitation_valid = 1)
);
create unique index organization_invitations_parent_idx on organization_invitations(id, organization_id);
-- Grant recipes retain their intended workspace IDs after purge, so stale invitations
-- fail acceptance instead of silently becoming company-only invitations.
create table workspace_invitation_grants (
  invitation_id text not null,
  organization_id text not null,
  workspace_id text not null,
  role text not null check(role in ('admin', 'manager', 'member')),
  primary key(invitation_id, workspace_id),
  foreign key(invitation_id, organization_id) references organization_invitations(id, organization_id) on delete cascade
);
create table invitation_acceptances (
  invitation_id text primary key references organization_invitations(id) on delete cascade,
  user_id text not null,
  accepted_at text not null
);
create table organization_audit_events (
  id text primary key,
  organization_id text not null,
  actor_id text not null,
  subject_id text,
  workspace_id text,
  event text not null,
  details text,
  created_at text not null
);
create index organization_audit_events_scope_idx on organization_audit_events(organization_id, created_at);
alter table oauth_states add column user_id text;
create index oauth_states_owner_idx on oauth_states(workspace_id, user_id);

-- Human identity and governance remain behind Hono, regardless of hosted defaults.
revoke all on identity_mutation_checks, workspace_invitation_grants, invitation_acceptances, organization_audit_events from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on identity_mutation_checks, workspace_invitation_grants, invitation_acceptances, organization_audit_events from %I', role_name);
    end if;
  end loop;
end $$;

-- Atomic application governance. A failed guard rolls back the entire D1 batch
-- or SQLite transaction. No shared mutable actor context is used.
create table identity_mutation_checks (
  id text primary key,
  authorized integer not null default 1 constraint identity_forbidden check(authorized = 1),
  owner_preserved integer not null default 1 constraint identity_last_owner check(owner_preserved = 1),
  admin_preserved integer not null default 1 constraint identity_last_admin check(admin_preserved = 1),
  invitation_valid integer not null default 1 constraint identity_invitation_invalid check(invitation_valid = 1)
);
create unique index organization_invitations_parent_idx on organization_invitations(id, organization_id);
create table workspace_invitation_grants (
  invitation_id text not null,
  organization_id text not null,
  workspace_id text not null,
  role text not null check(role in ('admin', 'manager', 'member')),
  primary key(invitation_id, workspace_id),
  foreign key(invitation_id, organization_id) references organization_invitations(id, organization_id) on delete cascade,
  foreign key(workspace_id, organization_id) references workspaces(id, organization_id) on delete cascade
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

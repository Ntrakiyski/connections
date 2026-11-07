-- Reviewed schema for better-auth 1.7.18 with src/server/auth-schema.ts mappings.
-- Expansion only: legacy identity verification and backfill belong to issue #9.
create table auth_user (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified integer not null default 0,
  image text,
  created_at date not null,
  updated_at date not null
);
create table auth_session (
  id text primary key,
  expires_at date not null,
  token text not null unique,
  created_at date not null,
  updated_at date not null,
  ip_address text,
  user_agent text,
  user_id text not null references auth_user(id) on delete cascade,
  active_organization_id text
);
create index auth_session_user_idx on auth_session(user_id);
create table auth_account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references auth_user(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at date,
  refresh_token_expires_at date,
  scope text,
  password text,
  created_at date not null,
  updated_at date not null,
  unique(provider_id, account_id)
);
create index auth_account_user_idx on auth_account(user_id);
create table auth_verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at date not null,
  created_at date not null,
  updated_at date not null
);
create index auth_verification_identifier_idx on auth_verification(identifier);
create table organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  logo text,
  created_at date not null,
  metadata text
);
create table organization_memberships (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  role text not null default 'member' check(role in ('owner', 'admin', 'member')),
  created_at date not null,
  unique(organization_id, user_id)
);
create index organization_memberships_user_idx on organization_memberships(user_id);
create table organization_invitations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email text not null,
  role text check(role in ('owner', 'admin', 'member')),
  status text not null default 'pending',
  expires_at date not null,
  created_at date not null,
  inviter_id text not null references auth_user(id) on delete cascade
);
create index organization_invitations_org_idx on organization_invitations(organization_id);
create index organization_invitations_email_idx on organization_invitations(email);

-- NULL is exclusively the pre-import Clerk compatibility boundary. Never infer
-- a verified identity or directory role from a workspace resource owner.
alter table workspaces add column organization_id text references organizations(id);
create unique index workspaces_parent_idx on workspaces(id, organization_id);
create index workspaces_organization_idx on workspaces(organization_id);

-- No tables reference workspace_memberships. Rebuild only this grant table;
-- rebuilding workspaces would cascade-delete its child resource controls in D1.
create table workspace_memberships_expanded (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check(role in ('member', 'manager', 'admin')),
  created_at text not null,
  updated_at text not null,
  organization_id text,
  primary key (workspace_id, user_id),
  foreign key(workspace_id, organization_id) references workspaces(id, organization_id)
    on delete cascade deferrable initially deferred,
  foreign key(organization_id, user_id) references organization_memberships(organization_id, user_id)
    on delete cascade
);
insert into workspace_memberships_expanded(workspace_id,user_id,role,created_at,updated_at)
  select workspace_id,user_id,role,created_at,updated_at from workspace_memberships;
drop table workspace_memberships;
alter table workspace_memberships_expanded rename to workspace_memberships;
create index workspace_memberships_org_user_idx on workspace_memberships(organization_id,user_id);

create trigger workspace_grant_parent_insert before insert on workspace_memberships
when new.organization_id is null and
  (select organization_id from workspaces where id = new.workspace_id) is not null
begin
  select raise(abort, 'workspace grant requires parent organization membership');
end;
create trigger workspace_grant_parent_update before update on workspace_memberships
when new.organization_id is null and
  (select organization_id from workspaces where id = new.workspace_id) is not null
begin
  select raise(abort, 'workspace grant requires parent organization membership');
end;
create trigger workspace_parent_update before update of organization_id on workspaces
when (old.organization_id is not null and new.organization_id is not old.organization_id)
  or (new.organization_id is not null and exists(
    select 1 from workspace_memberships where workspace_id = old.id and organization_id is null
  ))
begin
  select raise(abort, 'backfill grants before binding workspace; company parent is immutable');
end;


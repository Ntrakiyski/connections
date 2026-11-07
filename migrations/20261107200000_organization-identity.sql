-- Reviewed schema for better-auth 1.7.18 with src/server/auth-schema.ts mappings.
-- Expansion only: legacy identity verification and backfill belong to issue #9.
create table auth_user (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table auth_session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
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
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(provider_id, account_id)
);
create index auth_account_user_idx on auth_account(user_id);
create table auth_verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index auth_verification_identifier_idx on auth_verification(identifier);
create table organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  logo text,
  created_at timestamptz not null,
  metadata text
);
create table organization_memberships (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  role text not null default 'member' check(role in ('owner', 'admin', 'member')),
  created_at timestamptz not null,
  unique(organization_id, user_id)
);
create index organization_memberships_user_idx on organization_memberships(user_id);
create table organization_invitations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email text not null,
  role text check(role in ('owner', 'admin', 'member')),
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null,
  inviter_id text not null references auth_user(id) on delete cascade
);
create index organization_invitations_org_idx on organization_invitations(organization_id);
create index organization_invitations_email_idx on organization_invitations(email);

-- NULL is exclusively the pre-import Clerk compatibility boundary. Never infer
-- a verified identity or directory role from a workspace resource owner.
alter table workspaces add column organization_id text references organizations(id);
create unique index workspaces_parent_idx on workspaces(id, organization_id);
create index workspaces_organization_idx on workspaces(organization_id);

alter table workspace_memberships add column organization_id text;
alter table workspace_memberships add constraint workspace_grant_parent_fk
  foreign key(workspace_id, organization_id) references workspaces(id, organization_id)
  on delete cascade deferrable initially deferred;
alter table workspace_memberships add constraint workspace_grant_directory_fk
  foreign key(organization_id, user_id) references organization_memberships(organization_id, user_id)
  on delete cascade;
create index workspace_memberships_org_user_idx on workspace_memberships(organization_id,user_id);

create function check_workspace_grant_parent() returns trigger language plpgsql as $$
begin
  -- Lock the parent while deciding the compatibility boundary so a concurrent
  -- importer cannot bind it between a NULL grant check and commit.
  if new.organization_id is null and (
    select organization_id from workspaces where id = new.workspace_id for share
  ) is not null then
    raise exception 'workspace grant requires parent organization membership' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger workspace_grant_parent before insert or update on workspace_memberships
  for each row execute function check_workspace_grant_parent();

create function check_workspace_parent_update() returns trigger language plpgsql as $$
begin
  if (old.organization_id is not null and new.organization_id is distinct from old.organization_id)
    or (new.organization_id is not null and exists(
      select 1 from workspace_memberships where workspace_id = old.id and organization_id is null
    )) then
    raise exception 'backfill grants before binding workspace; company parent is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger workspace_parent_update before update of organization_id on workspaces
  for each row execute function check_workspace_parent_update();

-- Hosted PostgREST roles must have no access even when default privileges grant it.
-- Local PostgreSQL may not define the InsForge roles.
do $$
declare
  table_name text;
  api_role text;
begin
  foreach table_name in array array[
    'auth_user','auth_session','auth_account','auth_verification',
    'organizations','organization_memberships','organization_invitations'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('revoke all on table %I from public', table_name);
    foreach api_role in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table %I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end;
$$;

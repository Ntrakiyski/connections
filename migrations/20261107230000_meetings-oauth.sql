-- Pinned @better-auth/oauth-provider@1.7.18 server-only schema.
create table auth_oauth_client (
  id text primary key,
  client_id text not null unique,
  client_secret text,
  client_discovery_id text,
  disabled boolean default false,
  skip_consent boolean,
  enable_end_session boolean,
  subject_type text,
  scopes text,
  client_credentials_scopes text,
  user_id text references auth_user(id),
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  uri text,
  icon text,
  contacts text,
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  redirect_uris text not null,
  post_logout_redirect_uris text,
  backchannel_logout_uri text,
  backchannel_logout_session_required boolean,
  token_endpoint_auth_method text,
  application_type text,
  jwks text,
  jwks_uri text,
  grant_types text,
  response_types text,
  require_pkce boolean,
  dpop_bound_access_tokens boolean default false,
  reference_id text,
  metadata jsonb
);
create table auth_oauth_resource (
  id text primary key,
  identifier text not null unique,
  name text not null,
  access_token_ttl integer,
  refresh_token_ttl integer,
  signing_algorithm text,
  signing_key_id text,
  allowed_scopes text,
  custom_claims jsonb,
  dpop_bound_access_tokens_required boolean default false,
  disabled boolean default false,
  created_at timestamptz,
  updated_at timestamptz,
  policy_version integer,
  metadata jsonb
);
create table auth_oauth_client_resource (
  id text primary key,
  client_id text not null references auth_oauth_client(client_id) on delete cascade,
  resource_id text not null references auth_oauth_resource(identifier) on delete cascade,
  metadata jsonb,
  created_at timestamptz
);
create table auth_oauth_refresh_token (
  id text primary key,
  token text not null unique,
  client_id text not null references auth_oauth_client(client_id),
  session_id text references auth_session(id) on delete set null,
  user_id text not null references auth_user(id),
  reference_id text,
  authorization_code_id text,
  resources text,
  requested_user_info_claims text,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  revoked timestamptz,
  rotated_at timestamptz,
  rotation_replay_response text,
  rotation_replay_expires_at timestamptz,
  auth_time timestamptz,
  confirmation jsonb,
  scopes text not null
);
create table auth_oauth_access_token (
  id text primary key,
  token text not null unique,
  client_id text not null references auth_oauth_client(client_id),
  session_id text references auth_session(id) on delete set null,
  user_id text references auth_user(id),
  reference_id text,
  authorization_code_id text,
  resources text,
  requested_user_info_claims text,
  refresh_id text references auth_oauth_refresh_token(id),
  expires_at timestamptz not null,
  created_at timestamptz not null,
  revoked timestamptz,
  confirmation jsonb,
  scopes text not null
);
create table auth_oauth_consent (
  id text primary key,
  client_id text not null references auth_oauth_client(client_id),
  user_id text references auth_user(id),
  reference_id text,
  resources text,
  requested_user_info_claims text,
  scopes text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table auth_oauth_client_assertion (
  id text primary key,
  expires_at timestamptz not null
);
create unique index auth_oauth_client_resource_pair on auth_oauth_client_resource(client_id,resource_id);
create table meetings_oauth_bindings (
  id text primary key,
  flow_hash text not null unique,
  authorization_code_hash text unique,
  code_redeemed_at timestamptz,
  user_id text references auth_user(id) on delete cascade,
  session_id text references auth_session(id) on delete set null,
  organization_id text references organizations(id) on delete cascade,
  workspace_id text references workspaces(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check ((workspace_id is null and organization_id is null) or (workspace_id is not null and organization_id is not null and user_id is not null))
);
create index meetings_oauth_binding_access on meetings_oauth_bindings(workspace_id,user_id);
create function revoke_meetings_oauth_workspace_grant() returns trigger language plpgsql as $$
begin
  update meetings_oauth_bindings set revoked_at=coalesce(revoked_at,clock_timestamp()) where workspace_id=old.workspace_id and user_id=old.user_id;
  return old;
end $$;
create trigger meetings_oauth_grant_removed after delete on workspace_memberships for each row execute function revoke_meetings_oauth_workspace_grant();
create function revoke_meetings_oauth_archive() returns trigger language plpgsql as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update meetings_oauth_bindings set revoked_at=coalesce(revoked_at,clock_timestamp()) where workspace_id=new.id;
  end if;
  return new;
end $$;
create trigger meetings_oauth_workspace_archived after update of deleted_at on workspaces for each row execute function revoke_meetings_oauth_archive();
alter table auth_oauth_client enable row level security;
revoke all on auth_oauth_client from public;
alter table auth_oauth_resource enable row level security;
revoke all on auth_oauth_resource from public;
alter table auth_oauth_client_resource enable row level security;
revoke all on auth_oauth_client_resource from public;
alter table auth_oauth_refresh_token enable row level security;
revoke all on auth_oauth_refresh_token from public;
alter table auth_oauth_access_token enable row level security;
revoke all on auth_oauth_access_token from public;
alter table auth_oauth_consent enable row level security;
revoke all on auth_oauth_consent from public;
alter table auth_oauth_client_assertion enable row level security;
revoke all on auth_oauth_client_assertion from public;
alter table meetings_oauth_bindings enable row level security;
revoke all on meetings_oauth_bindings from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on auth_oauth_client,auth_oauth_resource,auth_oauth_client_resource,auth_oauth_refresh_token,auth_oauth_access_token,auth_oauth_consent,auth_oauth_client_assertion,meetings_oauth_bindings from %I',role_name);
    end if;
  end loop;
end $$;

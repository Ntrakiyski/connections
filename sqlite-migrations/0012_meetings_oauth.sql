-- Pinned @better-auth/oauth-provider@1.7.18 server-only schema.
create table auth_oauth_client (
  id text primary key,
  client_id text not null unique,
  client_secret text,
  client_discovery_id text,
  disabled integer default 0,
  skip_consent integer,
  enable_end_session integer,
  subject_type text,
  scopes text,
  client_credentials_scopes text,
  user_id text references auth_user(id),
  created_at text,
  updated_at text,
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
  backchannel_logout_session_required integer,
  token_endpoint_auth_method text,
  application_type text,
  jwks text,
  jwks_uri text,
  grant_types text,
  response_types text,
  require_pkce integer,
  dpop_bound_access_tokens integer default 0,
  reference_id text,
  metadata text
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
  custom_claims text,
  dpop_bound_access_tokens_required integer default 0,
  disabled integer default 0,
  created_at text,
  updated_at text,
  policy_version integer,
  metadata text
);
create table auth_oauth_client_resource (
  id text primary key,
  client_id text not null references auth_oauth_client(client_id) on delete cascade,
  resource_id text not null references auth_oauth_resource(identifier) on delete cascade,
  metadata text,
  created_at text
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
  expires_at text not null,
  created_at text not null,
  revoked text,
  rotated_at text,
  rotation_replay_response text,
  rotation_replay_expires_at text,
  auth_time text,
  confirmation text,
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
  expires_at text not null,
  created_at text not null,
  revoked text,
  confirmation text,
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
  created_at text not null,
  updated_at text not null
);
create table auth_oauth_client_assertion (
  id text primary key,
  expires_at text not null
);
create unique index auth_oauth_client_resource_pair on auth_oauth_client_resource(client_id,resource_id);
create table meetings_oauth_bindings (
  id text primary key,
  flow_hash text not null unique,
  authorization_code_hash text unique,
  code_redeemed_at text,
  user_id text references auth_user(id) on delete cascade,
  session_id text references auth_session(id) on delete set null,
  organization_id text references organizations(id) on delete cascade,
  workspace_id text references workspaces(id) on delete cascade,
  expires_at text not null,
  revoked_at text,
  check ((workspace_id is null and organization_id is null) or (workspace_id is not null and organization_id is not null and user_id is not null))
);
create index meetings_oauth_binding_access on meetings_oauth_bindings(workspace_id,user_id);
create trigger meetings_oauth_grant_removed after delete on workspace_memberships begin
  update meetings_oauth_bindings set revoked_at=coalesce(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) where workspace_id=old.workspace_id and user_id=old.user_id;
end;
create trigger meetings_oauth_workspace_archived after update of deleted_at on workspaces when old.deleted_at is null and new.deleted_at is not null begin
  update meetings_oauth_bindings set revoked_at=coalesce(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) where workspace_id=new.id;
end;

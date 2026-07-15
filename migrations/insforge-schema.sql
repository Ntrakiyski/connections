-- Connections PostgreSQL Schema (adapted from SQLite migrations)
-- Run against Insforge PostgreSQL

-- Workspaces
create table if not exists workspaces (
  id text primary key,
  clerk_org_id text not null unique,
  name text not null,
  created_at text not null,
  updated_at text not null
);

-- Workspace memberships
create table if not exists workspace_memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check(role in ('member', 'manager', 'admin')),
  created_at text not null,
  updated_at text not null,
  primary key (workspace_id, user_id)
);

-- Connections (workspace-scoped)
create table if not exists connections (
  workspace_id text not null default 'default',
  service text not null,
  connection_name text not null default 'default',
  label text not null default '',
  value text not null,
  created_by text not null default '',
  updated_at text not null,
  primary key (workspace_id, service, connection_name)
);
create index if not exists connections_workspace_service_idx on connections (workspace_id, service);

-- OAuth client configs (workspace-scoped)
create table if not exists oauth_client_configs (
  workspace_id text not null default 'default',
  service text not null,
  value text not null,
  created_by text not null default '',
  updated_at text not null,
  primary key (workspace_id, service)
);

-- OAuth states (workspace-scoped)
create table if not exists oauth_states (
  workspace_id text not null default 'default',
  state text not null,
  value text not null,
  created_at text not null,
  primary key (workspace_id, state)
);

-- Runtime tokens (workspace-scoped)
create table if not exists runtime_tokens (
  id text not null,
  workspace_id text not null default 'default',
  user_id text not null default '',
  name text not null,
  token_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text,
  primary key (workspace_id, id)
);
create index if not exists runtime_tokens_workspace_user_idx on runtime_tokens (workspace_id, user_id);

-- Runs (workspace-scoped)
create table if not exists runs (
  id text not null,
  workspace_id text not null default 'default',
  user_id text not null default '',
  service text,
  action_id text not null,
  started_at text not null,
  completed_at text not null,
  ok integer not null,
  value text not null,
  primary key (workspace_id, id)
);
create index if not exists runs_workspace_started_at_idx on runs (workspace_id, started_at desc, id desc);
create index if not exists runs_workspace_service_idx on runs (workspace_id, service, started_at desc, id desc);

-- Audit events
create table if not exists audit_events (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  event text not null,
  resource_type text not null,
  resource_id text,
  details text,
  created_at text not null
);
create index if not exists audit_events_workspace_idx on audit_events (workspace_id, created_at desc);

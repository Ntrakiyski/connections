-- Workspaces map Clerk Organizations to Connections workspace IDs.
create table if not exists workspaces (
  id text primary key,
  clerk_org_id text not null unique,
  name text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists workspace_memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check(role in ('member', 'manager', 'admin')),
  created_at text not null,
  updated_at text not null,
  primary key (workspace_id, user_id)
);

-- Existing local runtime data belongs to the default local workspace.
alter table connections add column workspace_id text not null default 'default';
alter table connections add column created_by text not null default '';
alter table connections add column label text not null default '';
alter table oauth_client_configs add column workspace_id text not null default 'default';
alter table oauth_client_configs add column created_by text not null default '';
alter table oauth_states add column workspace_id text not null default 'default';
alter table runtime_tokens add column workspace_id text not null default 'default';
alter table runtime_tokens add column user_id text not null default '';
alter table runs add column workspace_id text not null default 'default';
alter table runs add column user_id text not null default '';

create table connections_new (
  workspace_id text not null,
  service text not null,
  connection_name text not null default 'default',
  label text not null default '',
  value text not null,
  created_by text not null,
  updated_at text not null,
  primary key (workspace_id, service, connection_name)
);
insert into connections_new select workspace_id, service, connection_name, label, value, created_by, updated_at from connections;
drop table connections;
alter table connections_new rename to connections;

create table oauth_client_configs_new (
  workspace_id text not null,
  service text not null,
  value text not null,
  created_by text not null,
  updated_at text not null,
  primary key (workspace_id, service)
);
insert into oauth_client_configs_new select workspace_id, service, value, created_by, updated_at from oauth_client_configs;
drop table oauth_client_configs;
alter table oauth_client_configs_new rename to oauth_client_configs;

create table oauth_states_new (
  workspace_id text not null,
  state text not null,
  value text not null,
  created_at text not null,
  primary key (workspace_id, state)
);
insert into oauth_states_new select workspace_id, state, value, created_at from oauth_states;
drop table oauth_states;
alter table oauth_states_new rename to oauth_states;

create table runtime_tokens_new (
  id text not null,
  workspace_id text not null,
  user_id text not null,
  name text not null,
  token_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text,
  primary key (workspace_id, id)
);
insert into runtime_tokens_new select id, workspace_id, user_id, name, token_hash, created_at, last_used_at, revoked_at from runtime_tokens;
drop table runtime_tokens;
alter table runtime_tokens_new rename to runtime_tokens;

create table runs_new (
  id text not null,
  workspace_id text not null,
  user_id text not null,
  service text,
  action_id text not null,
  started_at text not null,
  completed_at text not null,
  ok integer not null,
  value text not null,
  primary key (workspace_id, id)
);
insert into runs_new select id, workspace_id, user_id, service, action_id, started_at, completed_at, ok, value from runs;
drop table runs;
alter table runs_new rename to runs;

create index if not exists connections_workspace_service_idx on connections (workspace_id, service);
create index if not exists runtime_tokens_workspace_user_idx on runtime_tokens (workspace_id, user_id);
create index if not exists runs_workspace_started_at_idx on runs (workspace_id, started_at desc, id desc);
create index if not exists runs_workspace_service_idx on runs (workspace_id, service, started_at desc, id desc);

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

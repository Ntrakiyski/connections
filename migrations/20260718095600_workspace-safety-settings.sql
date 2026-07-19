create table if not exists workspace_safety_settings (
  workspace_id text primary key references workspaces(id) on delete cascade,
  value jsonb not null,
  updated_by text not null,
  updated_at text not null
);

create table if not exists workspace_provider_safety_settings (
  workspace_id text not null references workspaces(id) on delete cascade,
  service text not null,
  value jsonb not null,
  updated_by text not null,
  updated_at text not null,
  primary key (workspace_id, service)
);

create table if not exists workspace_idempotency_records (
  workspace_id text not null references workspaces(id) on delete cascade,
  action_id text not null,
  connection_name text not null,
  idempotency_key text not null,
  input_hash text not null,
  execution_id text not null,
  result jsonb not null,
  created_at text not null,
  primary key (workspace_id, action_id, connection_name, idempotency_key)
);

create index if not exists workspace_idempotency_records_created_idx
  on workspace_idempotency_records (workspace_id, created_at desc);

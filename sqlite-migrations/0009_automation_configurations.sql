create table if not exists automation_configurations (
  automation_id text primary key references automations(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  encrypted_input text not null,
  updated_by text not null,
  updated_at text not null
);

create index if not exists automation_configurations_workspace_idx on automation_configurations (workspace_id);

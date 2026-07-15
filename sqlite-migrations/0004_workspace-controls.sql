create table if not exists workspace_providers (
  workspace_id text not null references workspaces(id) on delete cascade,
  service text not null,
  enabled_by text not null,
  enabled_at text not null,
  primary key (workspace_id, service)
);

create table if not exists workspace_action_policies (
  workspace_id text not null references workspaces(id) on delete cascade,
  action_id text not null,
  require_approval integer not null check(require_approval in (0, 1)),
  updated_by text not null,
  updated_at text not null,
  primary key (workspace_id, action_id)
);

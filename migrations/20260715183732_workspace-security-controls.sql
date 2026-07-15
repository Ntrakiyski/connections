-- Workspace controls are PostgreSQL-only and are applied through the InsForge CLI.
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
  require_approval boolean not null,
  updated_by text not null,
  updated_at text not null,
  primary key (workspace_id, action_id)
);

create index if not exists workspace_action_policies_workspace_idx
  on workspace_action_policies (workspace_id, action_id);

-- Existing production workspaces have one membership each. Preserve that owner
-- for legacy credentials and OAuth application configurations before member-only
-- access rules are enforced. Workspaces with multiple members remain manager-only
-- until a manager explicitly reconnects the credential.
with sole_members as (
  select workspace_id, min(user_id) as user_id
  from workspace_memberships
  group by workspace_id
  having count(*) = 1
)
update connections
set created_by = sole_members.user_id
from sole_members
where connections.workspace_id = sole_members.workspace_id
  and connections.created_by = '';

with sole_members as (
  select workspace_id, min(user_id) as user_id
  from workspace_memberships
  group by workspace_id
  having count(*) = 1
)
update oauth_client_configs
set created_by = sole_members.user_id
from sole_members
where oauth_client_configs.workspace_id = sole_members.workspace_id
  and oauth_client_configs.created_by = '';

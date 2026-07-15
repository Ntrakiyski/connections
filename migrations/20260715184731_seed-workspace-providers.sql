-- Keep existing workspaces operational when provider enablement becomes explicit.
insert into workspace_providers (workspace_id, service, enabled_by, enabled_at)
select workspace_id, service, created_by, updated_at
from connections
where created_by <> ''
on conflict (workspace_id, service) do nothing;

insert into workspace_providers (workspace_id, service, enabled_by, enabled_at)
select workspace_id, service, created_by, updated_at
from oauth_client_configs
where created_by <> ''
on conflict (workspace_id, service) do nothing;

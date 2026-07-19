-- Connections reaches PostgreSQL only through its server-side project_admin connection.
-- InsForge's PostgREST roles must not access application tables directly.
revoke all privileges on table
  public.audit_events,
  public.connections,
  public.oauth_client_configs,
  public.oauth_states,
  public.runs,
  public.runtime_tokens,
  public.workspace_idempotency_records,
  public.workspace_memberships,
  public.workspace_provider_safety_settings,
  public.workspace_safety_settings,
  public.workspaces
from anon, authenticated;

alter table public.audit_events enable row level security;
alter table public.connections enable row level security;
alter table public.oauth_client_configs enable row level security;
alter table public.oauth_states enable row level security;
alter table public.runs enable row level security;
alter table public.runtime_tokens enable row level security;
alter table public.workspace_idempotency_records enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_provider_safety_settings enable row level security;
alter table public.workspace_safety_settings enable row level security;
alter table public.workspaces enable row level security;

alter default privileges for role project_admin in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role project_admin in schema public
  revoke all on sequences from anon, authenticated;

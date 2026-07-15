-- Archive Connections-owned workspace data for the 14-day recovery window.
-- Clerk continues to own the Organization itself, its profile, and membership UI.
alter table workspaces add column if not exists deleted_at text;
alter table workspaces add column if not exists purge_at text;

create index if not exists workspaces_purge_at_idx
  on workspaces (purge_at)
  where purge_at is not null;

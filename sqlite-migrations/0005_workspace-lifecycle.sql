alter table workspaces add column deleted_at text;
alter table workspaces add column purge_at text;

create index if not exists workspaces_purge_at_idx
  on workspaces (purge_at);

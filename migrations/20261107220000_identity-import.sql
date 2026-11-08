-- Server-only import ledger; no auth factors or provider credentials are copied.
create table identity_import_runs (
  source_instance text primary key,
  source_fingerprint text not null,
  manifest_fingerprint text not null,
  plan_fingerprint text not null,
  report text not null,
  applied_at text not null,
  verification text not null default 'pending' check(verification in ('pending','verified')),
  verified_at text
);
create table identity_source_mappings (
  source_instance text not null references identity_import_runs(source_instance),
  kind text not null check(kind in ('user','company','workspace')),
  source_id text not null,
  target_id text not null,
  primary key(source_instance, kind, source_id),
  unique(kind, target_id)
);
create table identity_import_invitation_recovery (
  source_instance text not null references identity_import_runs(source_instance),
  source_invitation_id text not null,
  organization_id text not null references organizations(id),
  email text not null,
  source_role text not null,
  expires_at text not null,
  primary key(source_instance, source_invitation_id)
);
alter table identity_import_runs enable row level security;
alter table identity_source_mappings enable row level security;
alter table identity_import_invitation_recovery enable row level security;
revoke all on identity_import_runs, identity_source_mappings, identity_import_invitation_recovery from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on identity_import_runs, identity_source_mappings, identity_import_invitation_recovery from %I', role_name);
    end if;
  end loop;
end $$;

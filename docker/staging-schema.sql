-- Fresh isolated staging databases only. PostgreSQL entrypoint executes this once.
-- The baseline and checked application migrations are copied from this commit.
\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create schema system;
create function system.update_updated_at() returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end $$;
\ir /connections-schema/baseline.sql
\ir /connections-schema/migrations/20260715183732_workspace-security-controls.sql
\ir /connections-schema/migrations/20260715221000_workspace-lifecycle.sql
\ir /connections-schema/migrations/20260717090000_meetily-meetings.sql
\ir /connections-schema/migrations/20260718095600_workspace-safety-settings.sql
\ir /connections-schema/migrations/20260719130000_meetily-summary-only.sql
\ir /connections-schema/migrations/20260719130001_add-meetily-raw-transcript.sql
\ir /connections-schema/migrations/20260719133905_lock-down-server-tables.sql
\ir /connections-schema/migrations/20260720103941_tenant-meetily-meetings.sql
\ir /connections-schema/migrations/20261107200000_organization-identity.sql
\ir /connections-schema/migrations/20261107210000_identity-governance.sql
\ir /connections-schema/migrations/20261107220000_identity-import.sql
\ir /connections-schema/migrations/20261107230000_meetings-oauth.sql
create table connections_staging_schema_ready (id integer primary key check(id=1), ready boolean not null, initialized_at timestamptz not null default now());
insert into connections_staging_schema_ready(id,ready) values(1,true);

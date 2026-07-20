create table if not exists automations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  lifecycle text not null,
  draft_version_id text,
  live_version_id text,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists automation_versions (
  id text primary key,
  automation_id text not null references automations(id) on delete cascade,
  version integer not null,
  state text not null,
  definition text not null,
  created_by text not null,
  created_at text not null,
  published_at text,
  unique (automation_id, version)
);

create table if not exists automation_approval_grants (
  automation_version_id text primary key references automation_versions(id) on delete cascade,
  action_id text not null,
  connection_name text not null,
  approved_by text not null,
  approved_at text not null,
  action_policy_updated_at text not null
);

create table if not exists automation_schedules (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  automation_version_id text not null references automation_versions(id) on delete restrict,
  state text not null,
  next_run_at text,
  time_zone text not null,
  scheduled_for text not null,
  repeat integer not null,
  cadence text,
  end_at text,
  encrypted_input text not null,
  created_by text not null,
  created_at text not null,
  updated_at text not null,
  claimed_at text,
  blocked_reason text
);

create index if not exists automation_schedules_due_idx on automation_schedules (state, next_run_at);

create table if not exists automation_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  automation_version_id text not null references automation_versions(id) on delete restrict,
  schedule_id text not null references automation_schedules(id) on delete cascade,
  occurrence_at text not null,
  status text not null,
  started_at text not null,
  completed_at text,
  error_code text,
  error_message text,
  draft_id text,
  unique (schedule_id, occurrence_at)
);

create table if not exists automation_step_runs (
  id text primary key,
  automation_run_id text not null references automation_runs(id) on delete cascade,
  step_id text not null,
  step_order integer not null,
  status text not null,
  started_at text not null,
  completed_at text,
  error_code text,
  error_message text
);

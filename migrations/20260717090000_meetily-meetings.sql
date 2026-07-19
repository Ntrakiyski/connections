create table if not exists meetily_meetings (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  title text not null,
  transcript text not null,
  transcript_segments jsonb not null default '[]'::jsonb,
  summary text,
  action_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetily_meetings_created_at_idx
  on meetily_meetings (created_at desc);

alter table meetily_meetings enable row level security;
revoke all on meetily_meetings from anon, authenticated;

create trigger meetily_meetings_updated_at
  before update on meetily_meetings
  for each row
  execute function system.update_updated_at();

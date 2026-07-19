alter table public.meetily_meetings
  add column if not exists raw_transcript text,
  add column if not exists raw_transcript_segments jsonb;

update public.meetily_meetings
set raw_transcript = transcript,
    raw_transcript_segments = transcript_segments
where raw_transcript is null;

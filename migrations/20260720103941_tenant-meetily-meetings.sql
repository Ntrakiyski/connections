ALTER TABLE public.meetily_meetings
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

-- Legacy shared-key rows have no tenant owner and must not survive this boundary.
-- Keep tenant rows on retries so a partially applied migration is resumable.
DELETE FROM public.meetily_meetings WHERE workspace_id IS NULL;

DO $$
BEGIN
  ALTER TABLE public.meetily_meetings
    ADD CONSTRAINT meetily_meetings_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.meetily_meetings
    ADD CONSTRAINT meetily_meetings_state_check CHECK (state IN ('live', 'final'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.meetily_meetings
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;

BEGIN;
DO $$
DECLARE
  tenant_unique_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO tenant_unique_definition
  FROM pg_constraint
  WHERE conrelid = 'public.meetily_meetings'::regclass
    AND conname = 'meetily_meetings_workspace_external_key';

  IF tenant_unique_definition IS NULL THEN
    IF to_regclass('public.meetily_meetings_workspace_external_key') IS NOT NULL THEN
      RAISE EXCEPTION 'meetily_meetings_workspace_external_key exists but is not a constraint';
    END IF;
    ALTER TABLE public.meetily_meetings
      ADD CONSTRAINT meetily_meetings_workspace_external_key UNIQUE (workspace_id, external_id);
    SELECT pg_get_constraintdef(oid)
    INTO tenant_unique_definition
    FROM pg_constraint
    WHERE conrelid = 'public.meetily_meetings'::regclass
      AND conname = 'meetily_meetings_workspace_external_key';
  END IF;

  IF tenant_unique_definition <> 'UNIQUE (workspace_id, external_id)' THEN
    RAISE EXCEPTION 'meetily_meetings_workspace_external_key has unexpected definition: %', tenant_unique_definition;
  END IF;
END $$;
ALTER TABLE public.meetily_meetings DROP CONSTRAINT IF EXISTS meetily_meetings_external_id_key;
COMMIT;

CREATE INDEX IF NOT EXISTS meetily_meetings_workspace_created_idx
  ON public.meetily_meetings(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meetily_meetings_workspace_creator_idx
  ON public.meetily_meetings(workspace_id, created_by);

ALTER TABLE public.meetily_meetings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meetily_meetings FROM anon, authenticated;

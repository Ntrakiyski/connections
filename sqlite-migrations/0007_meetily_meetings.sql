CREATE TABLE meetily_meetings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live','final')),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  transcript TEXT NOT NULL,
  transcript_segments TEXT NOT NULL DEFAULT '[]',
  raw_transcript TEXT,
  raw_transcript_segments TEXT,
  summary TEXT,
  started_at TEXT,
  ended_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, external_id)
);
CREATE INDEX idx_meetily_meetings_workspace_date ON meetily_meetings(workspace_id, started_at DESC);
CREATE INDEX idx_meetily_meetings_workspace_creator ON meetily_meetings(workspace_id, created_by);

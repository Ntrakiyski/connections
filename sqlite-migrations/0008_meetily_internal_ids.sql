ALTER TABLE meetily_meetings ADD COLUMN id TEXT;
UPDATE meetily_meetings SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX meetily_meetings_id_key ON meetily_meetings(id);

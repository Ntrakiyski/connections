import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { IMeetingStore, MeetingRecord, MeetingWrite, MeetingWriteResult } from "./runtime-database.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";

type Row = Record<string, unknown>;
const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapRow(row: Row): MeetingRecord {
  const json = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value) return [];
    return JSON.parse(value) as unknown[];
  };
  const optional = (value: unknown): string | undefined =>
    value instanceof Date ? value.toISOString() : typeof value === "string" && value ? value : undefined;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    externalId: String(row.external_id),
    createdBy: String(row.created_by),
    state: row.state === "final" ? "final" : "live",
    revision: Number(row.revision),
    title: String(row.title),
    transcript: String(row.transcript),
    transcriptSegments: json(row.transcript_segments),
    rawTranscript: optional(row.raw_transcript),
    rawTranscriptSegments: row.raw_transcript_segments ? json(row.raw_transcript_segments) : undefined,
    summary: optional(row.summary),
    startedAt: optional(row.started_at),
    endedAt: optional(row.ended_at),
    finalizedAt: optional(row.finalized_at),
    createdAt: optional(row.created_at) ?? "",
    updatedAt: optional(row.updated_at) ?? "",
  };
}

function values(workspaceId: string, input: MeetingWrite, now: string): unknown[] {
  return [
    crypto.randomUUID(),
    workspaceId,
    input.externalId,
    input.createdBy,
    input.state,
    input.revision,
    input.title,
    input.transcript,
    JSON.stringify(input.transcriptSegments),
    input.rawTranscript ?? null,
    input.rawTranscriptSegments ? JSON.stringify(input.rawTranscriptSegments) : null,
    input.summary ?? null,
    input.startedAt ?? null,
    input.endedAt ?? null,
    input.state === "final" ? now : null,
    now,
    now,
  ];
}

const insertSql = `insert or ignore into meetily_meetings
 (id, workspace_id, external_id, created_by, state, revision, title, transcript, transcript_segments,
  raw_transcript, raw_transcript_segments, summary, started_at, ended_at, finalized_at, created_at, updated_at)
 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const updateSql = `update meetily_meetings set
  state=?, revision=?, title=?, transcript=?, transcript_segments=?, raw_transcript=coalesce(?,raw_transcript),
  raw_transcript_segments=coalesce(?,raw_transcript_segments), summary=coalesce(?,summary),
  started_at=coalesce(?,started_at), ended_at=coalesce(?,ended_at),
  finalized_at=case when ?='final' then coalesce(finalized_at, ?) else finalized_at end, updated_at=?
  where workspace_id=? and external_id=? and created_by=? and revision<?
    and not (state='final' and ?='live')`;

const createAuditSql = `insert into audit_events
 (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at)
 select ?, workspace_id, created_by, 'meeting.created', 'meeting', id, null, created_at
 from meetily_meetings where workspace_id=? and external_id=? and created_by=?
 on conflict(id) do nothing`;

const finalizeAuditSql = `insert into audit_events
 (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at)
 select ?, workspace_id, created_by, 'meeting.finalized', 'meeting', id, null, coalesce(finalized_at, updated_at)
 from meetily_meetings where workspace_id=? and external_id=? and created_by=? and state='final'
 on conflict(id) do nothing`;

function updateValues(workspaceId: string, input: MeetingWrite, now: string): unknown[] {
  return [
    input.state,
    input.revision,
    input.title,
    input.transcript,
    JSON.stringify(input.transcriptSegments),
    input.rawTranscript ?? null,
    input.rawTranscriptSegments ? JSON.stringify(input.rawTranscriptSegments) : null,
    input.summary ?? null,
    input.startedAt ?? null,
    input.endedAt ?? null,
    input.state,
    now,
    now,
    workspaceId,
    input.externalId,
    input.createdBy,
    input.revision,
    input.state,
  ];
}

async function auditIds(workspaceId: string, externalId: string): Promise<[string, string]> {
  return await Promise.all([
    deterministicAuditId(`${workspaceId}:${externalId}:meeting.created`),
    deterministicAuditId(`${workspaceId}:${externalId}:meeting.finalized`),
  ]);
}

async function deterministicAuditId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SqliteMeetingStore implements IMeetingStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  async list(workspaceId: string): Promise<MeetingRecord[]> {
    return this.db
      .prepare("select * from meetily_meetings where workspace_id = ? order by coalesce(started_at, created_at) desc")
      .all(workspaceId)
      .map((r) => mapRow(r as Row));
  }
  async get(workspaceId: string, externalId: string): Promise<MeetingRecord | undefined> {
    const r = this.db
      .prepare("select * from meetily_meetings where workspace_id = ? and external_id = ?")
      .get(workspaceId, externalId);
    return r ? mapRow(r as Row) : undefined;
  }
  async getById(workspaceId: string, id: string): Promise<MeetingRecord | undefined> {
    const r = this.db.prepare("select * from meetily_meetings where workspace_id = ? and id = ?").get(workspaceId, id);
    return r ? mapRow(r as Row) : undefined;
  }
  async put(workspaceId: string, input: MeetingWrite): Promise<MeetingWriteResult> {
    const now = new Date().toISOString();
    const [createAuditId, finalizeAuditId] = await auditIds(workspaceId, input.externalId);
    this.db.exec("begin immediate");
    try {
      const inserted = this.db.prepare(insertSql).run(...(values(workspaceId, input, now) as never[]));
      const updated = Number(inserted.changes)
        ? undefined
        : this.db.prepare(updateSql).run(...(updateValues(workspaceId, input, now) as never[]));
      const meeting = await this.get(workspaceId, input.externalId);
      if (!meeting) throw new Error("Meeting upsert did not return a row.");
      if (meeting.createdBy !== input.createdBy) throw new Error("meeting_creator_forbidden");
      const auditValues = [workspaceId, input.externalId, input.createdBy] as const;
      this.db.prepare(createAuditSql).run(createAuditId, ...auditValues);
      this.db.prepare(finalizeAuditSql).run(finalizeAuditId, ...auditValues);
      this.db.exec("commit");
      return {
        status: Number(inserted.changes) ? "created" : Number(updated?.changes) ? "updated" : "ignored",
        meeting,
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
}

export class PostgresMeetingStore implements IMeetingStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async list(workspaceId: string): Promise<MeetingRecord[]> {
    const r = await this.pool.query(
      "select * from meetily_meetings where workspace_id=$1 order by coalesce(started_at,created_at) desc",
      [workspaceId],
    );
    return r.rows.map(mapRow);
  }
  async get(workspaceId: string, externalId: string): Promise<MeetingRecord | undefined> {
    const r = await this.pool.query("select * from meetily_meetings where workspace_id=$1 and external_id=$2", [
      workspaceId,
      externalId,
    ]);
    return r.rows[0] ? mapRow(r.rows[0]) : undefined;
  }
  async getById(workspaceId: string, id: string): Promise<MeetingRecord | undefined> {
    if (!canonicalUuidPattern.test(id)) return undefined;
    const r = await this.pool.query("select * from meetily_meetings where workspace_id=$1 and id=$2", [
      workspaceId,
      id,
    ]);
    return r.rows[0] ? mapRow(r.rows[0]) : undefined;
  }
  async put(workspaceId: string, input: MeetingWrite): Promise<MeetingWriteResult> {
    const now = new Date().toISOString();
    const parameters = values(workspaceId, input, now);
    const [createAuditId, finalizeAuditId] = await auditIds(workspaceId, input.externalId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `insert into meetily_meetings
       (id, workspace_id, external_id, created_by, state, revision, title, transcript, transcript_segments,
        raw_transcript, raw_transcript_segments, summary, started_at, ended_at, finalized_at, created_at, updated_at)
       values (${parameters.map((_, index) => `$${index + 1}`).join(",")})
       on conflict (workspace_id, external_id) do update set
         state = excluded.state,
         revision = excluded.revision,
         title = excluded.title,
         transcript = excluded.transcript,
         transcript_segments = excluded.transcript_segments,
         raw_transcript = coalesce(excluded.raw_transcript, meetily_meetings.raw_transcript),
         raw_transcript_segments = coalesce(excluded.raw_transcript_segments, meetily_meetings.raw_transcript_segments),
         summary = coalesce(excluded.summary, meetily_meetings.summary),
         started_at = coalesce(excluded.started_at, meetily_meetings.started_at),
         ended_at = coalesce(excluded.ended_at, meetily_meetings.ended_at),
         finalized_at = case when excluded.state = 'final' then coalesce(meetily_meetings.finalized_at, excluded.finalized_at) else meetily_meetings.finalized_at end,
         updated_at = excluded.updated_at
       where meetily_meetings.created_by = excluded.created_by
         and excluded.revision > meetily_meetings.revision
         and not (meetily_meetings.state = 'final' and excluded.state = 'live')
       returning *, (xmax = 0) as inserted`,
        parameters,
      );
      const row = result.rows[0] as (Row & { inserted?: boolean }) | undefined;
      const meeting = row ? mapRow(row) : await getPostgresMeeting(client, workspaceId, input.externalId);
      if (!meeting) throw new Error("Meeting upsert did not return a row.");
      if (meeting.createdBy !== input.createdBy) throw new Error("meeting_creator_forbidden");
      await insertPostgresAudit(client, createAuditId, "meeting.created", workspaceId, input);
      await insertPostgresAudit(client, finalizeAuditId, "meeting.finalized", workspaceId, input);
      await client.query("COMMIT");
      return { status: row ? (row.inserted ? "created" : "updated") : "ignored", meeting };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function getPostgresMeeting(
  client: PoolClient,
  workspaceId: string,
  externalId: string,
): Promise<MeetingRecord | undefined> {
  const result = await client.query("select * from meetily_meetings where workspace_id=$1 and external_id=$2", [
    workspaceId,
    externalId,
  ]);
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

async function insertPostgresAudit(
  client: PoolClient,
  id: string,
  event: "meeting.created" | "meeting.finalized",
  workspaceId: string,
  input: MeetingWrite,
): Promise<void> {
  await client.query(
    `insert into audit_events (id, workspace_id, user_id, event, resource_type, resource_id, details, created_at)
     select $1, workspace_id, created_by, $2, 'meeting', id, null,
       ${event === "meeting.created" ? "created_at" : "coalesce(finalized_at, updated_at)"}
     from meetily_meetings where workspace_id=$3 and external_id=$4 and created_by=$5
       ${event === "meeting.finalized" ? "and state='final'" : ""}
     on conflict(id) do nothing`,
    [id, event, workspaceId, input.externalId, input.createdBy],
  );
}

export class D1MeetingStore implements IMeetingStore {
  private readonly db: D1DatabaseBinding;
  constructor(db: D1DatabaseBinding) {
    this.db = db;
  }
  async list(workspaceId: string): Promise<MeetingRecord[]> {
    const r = await this.db
      .prepare("select * from meetily_meetings where workspace_id=? order by coalesce(started_at,created_at) desc")
      .bind(workspaceId)
      .all<Row>();
    return r.results.map(mapRow);
  }
  async get(workspaceId: string, externalId: string): Promise<MeetingRecord | undefined> {
    const r = await this.db
      .prepare("select * from meetily_meetings where workspace_id=? and external_id=?")
      .bind(workspaceId, externalId)
      .first<Row>();
    return r ? mapRow(r) : undefined;
  }
  async getById(workspaceId: string, id: string): Promise<MeetingRecord | undefined> {
    const r = await this.db
      .prepare("select * from meetily_meetings where workspace_id=? and id=?")
      .bind(workspaceId, id)
      .first<Row>();
    return r ? mapRow(r) : undefined;
  }
  async put(workspaceId: string, input: MeetingWrite): Promise<MeetingWriteResult> {
    const now = new Date().toISOString();
    const [createAuditId, finalizeAuditId] = await auditIds(workspaceId, input.externalId);
    const auditValues = [workspaceId, input.externalId, input.createdBy] as const;
    const [inserted, updated] = await this.db.batch([
      this.db.prepare(insertSql).bind(...(values(workspaceId, input, now) as never[])),
      this.db.prepare(updateSql).bind(...(updateValues(workspaceId, input, now) as never[])),
      this.db.prepare(createAuditSql).bind(createAuditId, ...auditValues),
      this.db.prepare(finalizeAuditSql).bind(finalizeAuditId, ...auditValues),
    ]);
    const meeting = await this.get(workspaceId, input.externalId);
    if (!meeting) throw new Error("Meeting upsert did not return a row.");
    if (meeting.createdBy !== input.createdBy) throw new Error("meeting_creator_forbidden");
    return { status: inserted?.meta.changes ? "created" : updated?.meta.changes ? "updated" : "ignored", meeting };
  }
}

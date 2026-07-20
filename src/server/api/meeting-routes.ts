import type { IMeetingStore, MeetingSyncState } from "../storage/runtime-database.ts";
import type { JsonRequestBody } from "./http-utils.ts";
import type { Hono } from "hono";

import { HttpRequestError } from "./http-utils.ts";
import { getWorkspaceContext } from "./workspace-helpers.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function registerMeetingRoutes(app: Hono, meetings: IMeetingStore): void {
  app.get("/api/meetings", async (context) => {
    const workspace = getWorkspaceContext(context);
    return context.json({ meetings: await meetings.list(workspace.workspaceId) });
  });
  app.get("/api/meetings/:id", async (context) => {
    const workspace = getWorkspaceContext(context);
    const meeting = await meetings.getById(workspace.workspaceId, context.req.param("id"));
    if (!meeting) throw new HttpRequestError("meeting_not_found", "Meeting not found.", 404);
    return context.json({ meeting });
  });
  app.put("/api/meetings/:externalId", async (context) => {
    const length = Number(context.req.header("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) throw new HttpRequestError("payload_too_large", "Meeting payload is too large.", 413);
    const body = await readBoundedMeetingBody(context.req.raw);
    const workspace = getWorkspaceContext(context);
    const state = readState(body.state);
    const revision = readRevision(body.revision);
    const title = readString(body.title, "title");
    const transcript = readTranscript(body.transcript, state);
    const transcriptSegments = readArray(body.transcriptSegments, "transcriptSegments");
    let result;
    try {
      result = await meetings.put(workspace.workspaceId, {
        externalId: context.req.param("externalId"),
        createdBy: workspace.userId,
        state,
        revision,
        title,
        transcript,
        transcriptSegments,
        rawTranscript: optionalString(body.rawTranscript),
        rawTranscriptSegments: optionalArray(body.rawTranscriptSegments),
        summary: optionalString(body.summary),
        startedAt: optionalDate(body.startedAt),
        endedAt: optionalDate(body.endedAt),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "meeting_creator_forbidden") {
        throw new HttpRequestError("meeting_creator_forbidden", "Only the meeting creator can update it.", 403);
      }
      throw error;
    }
    return context.json({ status: result.status, meeting: result.meeting }, result.status === "created" ? 201 : 200);
  });
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new HttpRequestError("invalid_meeting", `${field} is required.`, 400);
  return value;
}
function readTranscript(value: unknown, state: MeetingSyncState): string {
  if (typeof value !== "string" || (state === "live" && !value.trim())) {
    throw new HttpRequestError("invalid_meeting", "transcript is required while a meeting is live.", 400);
  }
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new HttpRequestError("invalid_meeting", `${field} must be an array.`, 400);
  return value;
}
function optionalArray(value: unknown): unknown[] | undefined {
  return value === undefined || value === null ? undefined : readArray(value, "rawTranscriptSegments");
}
function readState(value: unknown): MeetingSyncState {
  if (value !== "live" && value !== "final")
    throw new HttpRequestError("invalid_meeting", "state must be live or final.", 400);
  return value;
}
function readRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new HttpRequestError("invalid_meeting", "revision must be a positive integer.", 400);
  return Number(value);
}
function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new HttpRequestError("invalid_meeting", "Meeting timestamps must be ISO dates.", 400);
  return value;
}

async function readBoundedMeetingBody(request: Request): Promise<JsonRequestBody> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpRequestError("payload_too_large", "Meeting payload is too large.", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as JsonRequestBody;
  } catch {
    throw new HttpRequestError("invalid_json", "Request body must be valid JSON.");
  }
}

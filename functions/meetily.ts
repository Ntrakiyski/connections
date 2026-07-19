const maxBodyBytes = 2 * 1024 * 1024;
// ponytail: one project-wide key; add workspace-scoped tokens before sharing Meetily across Connections workspaces.

interface TranscriptSegment {
  text?: unknown;
  timestamp?: unknown;
  audio_start_time?: unknown;
  audio_end_time?: unknown;
  duration?: unknown;
}

interface MeetingPayload {
  externalId?: unknown;
  title?: unknown;
  transcript?: unknown;
  transcriptSegments?: unknown;
  summary?: unknown;
  actionItems?: unknown;
}

export default async function (request: Request): Promise<Response> {
  const expectedKey = Deno.env.get("MEETILY_API_KEY");
  const suppliedKey = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expectedKey || !suppliedKey || suppliedKey !== expectedKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const apiKey = Deno.env.get("API_KEY");
  if (!baseUrl || !apiKey) return json({ error: "Meetily service is not configured" }, 500);

  if (request.method === "GET") return readMeetings(request, baseUrl, apiKey);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBodyBytes) return json({ error: "Payload too large" }, 413);

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > maxBodyBytes) {
    return json({ error: "Payload too large" }, 413);
  }

  let payload: MeetingPayload;
  try {
    payload = JSON.parse(bodyText) as MeetingPayload;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const externalId = nonEmptyString(payload.externalId);
  const title = nonEmptyString(payload.title);
  const segments = Array.isArray(payload.transcriptSegments)
    ? payload.transcriptSegments.filter(isTranscriptSegment)
    : [];
  const transcript = nonEmptyString(payload.transcript) ?? segments.map((segment) => segment.text).join("\n");
  if (!externalId || !title || !transcript) {
    return json({ error: "externalId, title, and transcript are required" }, 400);
  }

  const response = await fetch(`${baseUrl}/api/database/records/meetily_meetings?on_conflict=external_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        external_id: externalId,
        title,
        transcript,
        transcript_segments: segments,
        summary: optionalString(payload.summary),
        action_items: Array.isArray(payload.actionItems) ? payload.actionItems : [],
      },
    ]),
  });

  if (!response.ok) {
    console.error("Meetily upsert failed", response.status, await response.text());
    return json({ error: "Failed to store meeting" }, 502);
  }

  const [meeting] = (await response.json()) as Array<{ id: string; external_id: string }>;
  return json({ ok: true, meetingId: meeting?.id, externalId: meeting?.external_id });
}

async function readMeetings(request: Request, baseUrl: string, apiKey: string): Promise<Response> {
  const input = new URL(request.url).searchParams;
  const operation = input.get("operation") ?? "list";
  const query = new URLSearchParams();
  query.set("order", "created_at.desc");
  query.set("limit", String(Math.min(Math.max(Number(input.get("limit")) || 20, 1), 100)));

  if (operation === "get") {
    const externalId = nonEmptyString(input.get("externalId"));
    if (!externalId) return json({ error: "externalId is required" }, 400);
    query.set("external_id", `eq.${externalId}`);
    query.set("limit", "1");
  } else if (operation === "latest") {
    query.set("limit", "1");
  } else if (operation === "search") {
    const search = nonEmptyString(input.get("q"));
    if (!search) return json({ error: "q is required" }, 400);
    query.set("transcript", `ilike.*${search}*`);
  } else if (operation !== "list") {
    return json({ error: "Unknown operation" }, 400);
  }

  if (operation === "list") {
    query.set("select", "id,external_id,title,summary,action_items,created_at,updated_at");
  }

  const response = await fetch(`${baseUrl}/api/database/records/meetily_meetings?${query}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("Meetily read failed", response.status, await response.text());
    return json({ error: "Failed to read meetings" }, 502);
  }
  return json({ meetings: await response.json() });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment & { text: string } {
  return Boolean(value && typeof value === "object" && nonEmptyString((value as TranscriptSegment).text));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

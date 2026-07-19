# Meetily Provider Idea

## Goal

Expose completed Meetily meeting transcripts to agents through Connections as a provider.

The agent should not need direct access to the Meetily macOS app or its local SQLite database. Instead, Meetily should publish completed meeting data to a database on the VPS, and the Connections provider should read from that VPS database.

## Preferred Architecture

```text
Meetily on Mac
  -> sends completed meeting transcript after meeting ends
  -> VPS ingest API
  -> VPS database
  -> Connections Meetily provider
  -> MCP agent tools
```

This avoids having Connections reach into the Mac's local filesystem and avoids putting Meetily's live SQLite database on a network mount.

## Why Not Direct SQLite Access From VPS

Meetily's local SQLite database lives on the Mac. The Connections app runs on the VPS.

Tailscale helps the machines talk to each other, but it does not make a local Mac file safely readable by the VPS. Mounting a live SQLite database over the network is risky because SQLite expects local filesystem locking semantics.

Direct local SQLite access only makes sense if Connections also runs on the Mac.

## Why Not Webhook-Only

A generic webhook inbox is useful for receiving events, but the Meetily use case is richer than "receive arbitrary JSON."

The agent needs structured tools:

- list meetings
- get the latest meeting
- fetch a transcript
- search transcripts
- retrieve summaries
- retrieve action items

So the better abstraction is a first-class `meetily` provider backed by a durable transcript database.

## Data Flow

Meetily upserts transcript snapshots while the meeting is active. After stop, it preserves the original transcript, automatically publishes the LLM-corrected transcript as the default, and retains both versions under the same meeting ID.

Example ingest payload:

```json
{
  "externalId": "meetily-meeting-id",
  "title": "Weekly product sync",
  "startedAt": "2026-07-19T10:00:00Z",
  "endedAt": "2026-07-19T10:45:00Z",
  "participants": ["Alice", "Bob"],
  "transcript": "Full transcript text...",
  "rawTranscript": "Original speech-recognition text...",
  "transcriptSegments": [],
  "rawTranscriptSegments": [],
  "summary": "Meeting summary...",
  "actionItems": [
    {
      "text": "Send revised proposal",
      "owner": "Alice",
      "dueDate": null
    }
  ]
}
```

The ingest endpoint should upsert by `externalId`, so repeated sends do not create duplicate meetings.

## Storage

Use Postgres on the VPS if available. SQLite is acceptable for a small v1, but Postgres is better for later search and multi-client access.

Suggested tables:

- `meetily_meetings`
- `meetily_participants`
- `meetily_action_items`

Minimum v1 can be one table:

```sql
create table meetily_meetings (
  id text primary key,
  external_id text not null unique,
  title text,
  started_at text,
  ended_at text,
  participants_json text not null default '[]',
  transcript text not null,
  summary text,
  action_items_json text not null default '[]',
  source_payload_json text not null,
  created_at text not null,
  updated_at text not null
);
```

## Ingest API

Create a small VPS endpoint:

```text
POST /api/meetily/ingest
Authorization: Bearer <shared-secret>
Content-Type: application/json
```

Rules:

- accept JSON only
- cap payload size
- require `externalId`
- require at least one of `transcript` or `summary`
- upsert by `externalId`
- store raw payload for recovery/debugging
- keep the endpoint private and token-protected

## Connections Provider

Provider name:

```text
meetily
```

Recommended auth:

- `custom_credential` or `api_key`
- credential points to the VPS transcript database/API, not the Mac

Recommended actions:

- `meetily.list_meetings`
- `meetily.get_meeting`
- `meetily.get_latest_meeting`
- `meetily.get_transcript`
- `meetily.search_transcripts`
- `meetily.get_summary`
- `meetily.get_action_items`

The provider should expose curated read tools, not raw SQL.

## Agent Experience

Example requests the agent should support:

- "Get the latest Meetily meeting and summarize the action items."
- "Find meetings where we discussed pricing."
- "Show me the transcript from yesterday's product sync."
- "What did I commit to in my last client meeting?"

## Later Enhancements

- full-text search with Postgres `tsvector`
- embeddings for semantic transcript search
- per-meeting tags
- speaker-aware transcript segments
- automatic follow-up task creation through other Connections providers
- retention settings
- private redaction rules before storing transcripts

## Current Recommendation

Build this in two stages:

1. Meetily sends completed meeting JSON to a VPS ingest endpoint.
2. Connections adds a `meetily` provider that reads from the VPS transcript store.

This gives agents stable access to completed meetings without depending on the Mac being online and without touching Meetily's live local SQLite database.

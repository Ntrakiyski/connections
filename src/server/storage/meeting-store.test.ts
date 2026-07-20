import { describe, expect, it, vi } from "vitest";
import { PostgresMeetingStore } from "./meeting-store.ts";

describe("PostgresMeetingStore", () => {
  it("returns undefined for a malformed internal ID without querying PostgreSQL", async () => {
    const query = vi.fn().mockRejectedValue(new Error("invalid input syntax for type uuid"));
    const store = new PostgresMeetingStore({ query } as never);

    await expect(store.getById("workspace-a", "not-a-uuid")).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("scopes internal-ID lookups to the workspace", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "1f3c60ae-6b06-4a7b-9e48-6e7f67522a29",
          workspace_id: "workspace-a",
          external_id: "external-a",
          created_by: "user-a",
          state: "live",
          revision: 1,
          title: "Meeting",
          transcript: "text",
          transcript_segments: [],
          created_at: "2026-07-20T00:00:00.000Z",
          updated_at: "2026-07-20T00:00:00.000Z",
        },
      ],
    });
    const store = new PostgresMeetingStore({ query } as never);

    await expect(store.getById("workspace-a", "1f3c60ae-6b06-4a7b-9e48-6e7f67522a29")).resolves.toMatchObject({
      externalId: "external-a",
    });
    expect(query).toHaveBeenCalledWith("select * from meetily_meetings where workspace_id=$1 and id=$2", [
      "workspace-a",
      "1f3c60ae-6b06-4a7b-9e48-6e7f67522a29",
    ]);
  });

  it("rolls back the meeting transaction when an audit insert fails", async () => {
    let pendingMeeting = false;
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === "BEGIN") return { rows: [] };
        if (sql.startsWith("insert into meetily_meetings")) {
          pendingMeeting = true;
          return { rows: [{ ...meetingRow(), inserted: true }] };
        }
        if (sql.startsWith("insert into audit_events")) throw new Error("audit unavailable");
        if (sql === "ROLLBACK") {
          pendingMeeting = false;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const store = new PostgresMeetingStore(pool as never);

    await expect(store.put("workspace-a", createMeetingWrite())).rejects.toThrow("audit unavailable");

    expect(pendingMeeting).toBe(false);
    expect(queries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

function meetingRow(): Record<string, unknown> {
  return {
    id: "1f3c60ae-6b06-4a7b-9e48-6e7f67522a29",
    workspace_id: "workspace-a",
    external_id: "meeting-1",
    created_by: "user-a",
    state: "live",
    revision: 1,
    title: "Meeting",
    transcript: "text",
    transcript_segments: [],
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  };
}

function createMeetingWrite() {
  return {
    externalId: "meeting-1",
    createdBy: "user-a",
    state: "live" as const,
    revision: 1,
    title: "Meeting",
    transcript: "text",
    transcriptSegments: [],
  };
}

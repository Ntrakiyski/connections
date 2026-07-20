import type { IMeetingStore } from "../storage/runtime-database.ts";

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresMeetingStore, SqliteMeetingStore } from "../storage/meeting-store.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { HttpRequestError } from "./http-utils.ts";
import { registerMeetingRoutes } from "./meeting-routes.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("meeting routes", () => {
  it("accepts a blank transcript only when final", async () => {
    const { app } = await createApp();

    const live = await app.request("/api/meetings/live", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "live", revision: 1, title: "Live", transcript: "", transcriptSegments: [] }),
    });
    const final = await app.request("/api/meetings/final", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "final", revision: 1, title: "Final", transcript: "", transcriptSegments: [] }),
    });

    expect(live.status).toBe(400);
    expect(final.status).toBe(201);
  });

  it("gets a meeting by its internal database ID rather than its external sync ID", async () => {
    const { app } = await createApp();
    const created = await app.request("/api/meetings/external-sync-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "live", revision: 1, title: "Live", transcript: "text", transcriptSegments: [] }),
    });
    const meeting = (await created.json()) as { meeting: { id: string } };

    expect((await app.request(`/api/meetings/${meeting.meeting.id}`)).status).toBe(200);
    expect((await app.request("/api/meetings/external-sync-id")).status).toBe(404);
  });

  it("returns 404 for a malformed PostgreSQL internal ID", async () => {
    const query = vi.fn().mockRejectedValue(new Error("invalid input syntax for type uuid"));
    const app = createRouteApp(new PostgresMeetingStore({ query } as never));

    const response = await app.request("/api/meetings/not-a-uuid");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "meeting_not_found" } });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns an error without retaining a meeting when its audit transaction fails", async () => {
    const sqlite = createRawDatabase();
    const meetings = new SqliteMeetingStore(sqlite);
    sqlite.exec(`
      create trigger fail_meeting_audit before insert on audit_events
      when new.event like 'meeting.%'
      begin select raise(abort, 'audit unavailable'); end;
    `);
    const app = createRouteApp(meetings);

    const response = await app.request("/api/meetings/audit-failure", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "final", revision: 1, title: "Final", transcript: "text", transcriptSegments: [] }),
    });

    expect(response.status).toBe(500);
    await expect(meetings.get("workspace-a", "audit-failure")).resolves.toBeUndefined();
    expect(sqlite.prepare("select count(*) as count from audit_events").get()).toMatchObject({ count: 0 });
    sqlite.close();
  });

  it("rejects malformed JSON", async () => {
    const { app } = await createApp();

    const response = await app.request("/api/meetings/malformed", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_json" } });
  });

  it("rejects a raw chunked body over 4 MiB before JSON parsing", async () => {
    const { app } = await createApp();
    const bytes = new TextEncoder().encode(" ".repeat(4 * 1024 * 1024 + 1));
    const request = new Request("http://localhost/api/meetings/oversized", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request);

    expect(request.headers.has("content-length")).toBe(false);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("returns 403 when another creator updates an existing external ID", async () => {
    let userId = "user-a";
    const { app } = await createApp(() => userId);
    const body = (revision: number) =>
      JSON.stringify({ state: "live", revision, title: "Live", transcript: "text", transcriptSegments: [] });

    expect(
      (
        await app.request("/api/meetings/owned", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: body(1),
        })
      ).status,
    ).toBe(201);
    userId = "user-b";
    const response = await app.request("/api/meetings/owned", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: body(2),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "meeting_creator_forbidden" } });
  });

  it("derives the tenant and ignores stale live delivery after finalization", async () => {
    const database = new SqliteRuntimeDatabase(":memory:");
    databases.push(database);
    for (const id of ["workspace-a", "workspace-b"]) {
      await database.workspaceStore.create({
        id,
        clerkOrgId: `org-${id}`,
        name: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    let workspaceId = "workspace-a";
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("workspace", { workspaceId, userId: "user-a", role: "member" });
      await next();
    });
    registerMeetingRoutes(app, database.meetingStore);

    const final = await app.request("/api/meetings/shared-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "final",
        revision: 2,
        title: "Final",
        transcript: "complete",
        transcriptSegments: [],
      }),
    });
    expect(final.status).toBe(201);
    expect(await database.workspaceControlStore.listAuditEvents("workspace-a", 10)).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ event: "meeting.finalized" }),
        expect.objectContaining({ event: "meeting.created" }),
      ]),
    );

    const lateLive = await app.request("/api/meetings/shared-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "live",
        revision: 3,
        title: "Late",
        transcript: "stale",
        transcriptSegments: [],
      }),
    });
    expect(await lateLive.json()).toMatchObject({ status: "ignored", meeting: { state: "final", title: "Final" } });
    const audits = await database.workspaceControlStore.listAuditEvents("workspace-a", 10);
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.id)).toEqual([
      expect.stringMatching(/^[\da-f-]{36}$/),
      expect.stringMatching(/^[\da-f-]{36}$/),
    ]);

    workspaceId = "workspace-b";
    expect(await (await app.request("/api/meetings")).json()).toEqual({ meetings: [] });
    const otherTenant = await app.request("/api/meetings/shared-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "live", revision: 1, title: "Other", transcript: "other", transcriptSegments: [] }),
    });
    expect(otherTenant.status).toBe(201);
  });
});

async function createApp(
  getUserId: () => string = () => "user-a",
): Promise<{ app: Hono; database: SqliteRuntimeDatabase }> {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  await database.workspaceStore.create({
    id: "workspace-a",
    clerkOrgId: "org-workspace-a",
    name: "workspace-a",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("workspace", { workspaceId: "workspace-a", userId: getUserId(), role: "member" });
    await next();
  });
  registerMeetingRoutes(app, database.meetingStore);
  app.onError((error, context) =>
    error instanceof HttpRequestError
      ? context.json({ error: { code: error.code, message: error.message } }, error.status)
      : context.json({ error: { code: "internal" } }, 500),
  );
  return { app, database };
}

function createRawDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_runtime.sql",
    "0002_run-service.sql",
    "0003_workspaces.sql",
    "0007_meetily_meetings.sql",
    "0008_meetily_internal_ids.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../../../sqlite-migrations/${migration}`, import.meta.url), "utf8"));
  }
  sqlite
    .prepare("insert into workspaces (id, clerk_org_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)")
    .run("workspace-a", "org-a", "Workspace A", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
  return sqlite;
}

function createRouteApp(meetings: IMeetingStore): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("workspace", { workspaceId: "workspace-a", userId: "user-a", role: "member" });
    await next();
  });
  registerMeetingRoutes(app, meetings);
  app.onError((error, context) =>
    error instanceof HttpRequestError
      ? context.json({ error: { code: error.code, message: error.message } }, error.status)
      : context.json({ error: { code: "internal" } }, 500),
  );
  return app;
}

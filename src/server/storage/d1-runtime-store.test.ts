import type { D1DatabaseBinding, D1PreparedStatementBinding } from "../cloudflare/cloudflare-bindings.ts";

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { D1RuntimeDatabase } from "./d1-runtime-store.ts";
import { RuntimeTokenService } from "./runtime-token-service.ts";

const githubProfile = {
  accountId: "github:octocat",
  displayName: "octocat",
  grantedScopes: [],
};

describe("D1RuntimeDatabase", () => {
  it("keeps scoped connections isolated between workspaces", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database());
    const first = database.createScopedStores("workspace-a");
    const second = database.createScopedStores("workspace-b");

    await first.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "workspace-a-token",
      values: { apiKey: "workspace-a-token" },
      profile: githubProfile,
      metadata: {},
    });

    await expect(second.connectionStore.get("github", "default")).resolves.toBeUndefined();
    await expect(first.connectionStore.get("github", "default")).resolves.toMatchObject({
      apiKey: "workspace-a-token",
    });
  });

  it("stores connections and OAuth client configs through the secret codec", async () => {
    const d1 = new SqliteD1Database();
    const database = new D1RuntimeDatabase(d1, {
      secretCodec: new AesGcmSecretCodec("local-test-key"),
    });

    await database.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: { login: "octocat" },
    });
    await database.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: { tenant: "default" },
      secretExtra: {},
    });

    expect(d1.value("connections", "service", "github")).not.toContain("github-token");
    expect(d1.value("oauth_client_configs", "service", "gmail")).not.toContain("client-secret");
    await expect(database.connectionStore.get("github", "default")).resolves.toMatchObject({
      authType: "api_key",
      apiKey: "github-token",
      metadata: { login: "octocat" },
    });
    await expect(database.oauthClientConfigStore.get("gmail")).resolves.toMatchObject({
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: { tenant: "default" },
    });
    await expect(database.connectionStore.list()).resolves.toMatchObject([
      { service: "github", connectionName: "default" },
    ]);
    await expect(database.oauthClientConfigStore.list()).resolves.toMatchObject([{ service: "gmail" }]);

    await database.connectionStore.delete("github", "default");
    await database.oauthClientConfigStore.delete("gmail");
    await expect(database.connectionStore.get("github", "default")).resolves.toBeUndefined();
    await expect(database.oauthClientConfigStore.get("gmail")).resolves.toBeUndefined();
  });

  it("takes OAuth state once", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database());

    await database.oauthStateStore.set({
      service: "gmail",
      state: "state-1",
      createdAt: "2026-06-30T00:00:00.000Z",
    });

    await expect(database.oauthStateStore.take("state-1")).resolves.toMatchObject({
      service: "gmail",
      state: "state-1",
    });
    await expect(database.oauthStateStore.take("state-1")).resolves.toBeUndefined();
  });

  it("stores runtime token hashes and supports verification and revocation", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database());
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);

    const created = await tokens.createToken("default", "local-dev", "Claude Desktop");
    expect(created.token).toMatch(/^oct_/);
    expect(created.record.tokenHash).not.toBe(created.token);

    await expect(tokens.verifyToken(created.token)).resolves.toEqual({
      workspaceId: "default",
      userId: "local-dev",
      tokenId: created.record.id,
    });
    const [listed] = await tokens.listTokens();
    expect(listed).toMatchObject({
      id: created.record.id,
      name: "Claude Desktop",
    });
    expect(listed?.lastUsedAt).toBeTruthy();

    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(true);
    await expect(tokens.listTokens()).resolves.toEqual([]);
    await expect(tokens.verifyToken(created.token)).resolves.toBeUndefined();
    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(false);
  });

  it("keeps only the configured number of recent runs", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database(), { runLimit: 2 });

    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await database.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    await expect(database.runLogStore.list()).resolves.toMatchObject({
      items: [{ id: "run-3" }, { id: "run-2" }],
    });
  });

  it("paginates recent runs with a cursor", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database(), { runLimit: 4 });

    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await database.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    const first = await database.runLogStore.list({ limit: 2 });
    expect(first.items.map((run) => run.id)).toEqual(["run-3", "run-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await database.runLogStore.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["run-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("filters recent runs by service before paginating", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database(), { runLimit: 5 });

    await database.runLogStore.add(createRun("gmail-1", "2026-06-30T00:00:00.000Z", "mail.search_threads", "gmail"));
    await database.runLogStore.add(createRun("hackernews-1", "2026-06-30T00:00:01.000Z", "news.get_top_stories"));
    await database.runLogStore.add(createRun("gmail-2", "2026-06-30T00:00:02.000Z", "mail.list_threads", "gmail"));

    const first = await database.runLogStore.list({ service: "gmail", limit: 1 });
    expect(first.items.map((run) => run.id)).toEqual(["gmail-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await database.runLogStore.list({ service: "gmail", limit: 1, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["gmail-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("keeps a concurrent final meeting ahead of a stale lower live update", async () => {
    const d1 = new SqliteD1Database();
    const database = new D1RuntimeDatabase(d1);
    await database.workspaceStore.create({
      id: "workspace-a",
      clerkOrgId: "org-a",
      name: "Workspace A",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const live = createMeetingWrite();

    await database.meetingStore.put("workspace-a", live);
    d1.finalizeOnNextMeetingUpdate();
    await expect(
      database.meetingStore.put("workspace-a", { ...live, revision: 2, title: "late live" }),
    ).resolves.toMatchObject({
      status: "ignored",
      meeting: { state: "final", revision: 3, title: "final" },
    });
  });

  it("looks up a meeting by its internal database ID", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database());
    await database.workspaceStore.create({
      id: "workspace-a",
      clerkOrgId: "org-a",
      name: "Workspace A",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const created = await database.meetingStore.put("workspace-a", createMeetingWrite());

    await expect(database.meetingStore.getById("workspace-a", created.meeting.id)).resolves.toMatchObject({
      externalId: "meeting-1",
    });
    await expect(database.meetingStore.getById("workspace-b", created.meeting.id)).resolves.toBeUndefined();
  });

  it("rolls back a meeting when its transactional audit insert fails", async () => {
    const d1 = new SqliteD1Database();
    const database = new D1RuntimeDatabase(d1);
    await database.workspaceStore.create({
      id: "workspace-a",
      clerkOrgId: "org-a",
      name: "Workspace A",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    d1.failNextMeetingAudit();

    await expect(database.meetingStore.put("workspace-a", createMeetingWrite())).rejects.toThrow("audit unavailable");
    await expect(database.meetingStore.get("workspace-a", "meeting-1")).resolves.toBeUndefined();
    await expect(database.workspaceControlStore.listAuditEvents("workspace-a", 10)).resolves.toEqual([]);
  });

  it("forbids concurrent meeting creators", async () => {
    const database = new D1RuntimeDatabase(new SqliteD1Database());
    await database.workspaceStore.create({
      id: "workspace-a",
      clerkOrgId: "org-a",
      name: "Workspace A",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const write = createMeetingWrite();
    const results = await Promise.allSettled([
      database.meetingStore.put("workspace-a", write),
      database.meetingStore.put("workspace-a", { ...write, createdBy: "user-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: "meeting_creator_forbidden" }),
    });
  });

  it("keeps the first finalization timestamp across newer final revisions", async () => {
    const d1 = new SqliteD1Database();
    const database = new D1RuntimeDatabase(d1);
    await database.workspaceStore.create({
      id: "workspace-a",
      clerkOrgId: "org-a",
      name: "Workspace A",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const final = { ...createMeetingWrite(), state: "final" as const };
    await database.meetingStore.put("workspace-a", final);
    d1.setMeetingFinalizedAt("2026-07-20T10:00:00.000Z");

    await expect(database.meetingStore.put("workspace-a", { ...final, revision: 2 })).resolves.toMatchObject({
      status: "updated",
      meeting: { finalizedAt: "2026-07-20T10:00:00.000Z" },
    });
  });
});

function createRun(id: string, startedAt: string, actionId = "hackernews.get_top_stories", service = "hackernews") {
  return {
    id,
    workspaceId: "default",
    userId: "local-dev",
    service,
    actionId,
    caller: "http" as const,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    ok: true,
  };
}

function createMeetingWrite() {
  return {
    externalId: "meeting-1",
    createdBy: "user-a",
    state: "live" as const,
    revision: 1,
    title: "live",
    transcript: "hello",
    transcriptSegments: [],
  };
}

class SqliteD1Database implements D1DatabaseBinding {
  private readonly database = new DatabaseSync(":memory:");
  private finalizeNextMeetingUpdate = false;
  private failMeetingAudit = false;

  constructor() {
    this.database.exec(readFileSync(new URL("../../../sqlite-migrations/0001_runtime.sql", import.meta.url), "utf8"));
    this.database.exec(
      readFileSync(new URL("../../../sqlite-migrations/0002_run-service.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../sqlite-migrations/0003_workspaces.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../sqlite-migrations/0007_meetily_meetings.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../sqlite-migrations/0008_meetily_internal_ids.sql", import.meta.url), "utf8"),
    );
  }

  finalizeOnNextMeetingUpdate(): void {
    this.finalizeNextMeetingUpdate = true;
  }

  failNextMeetingAudit(): void {
    this.failMeetingAudit = true;
  }

  async batch(
    statements: D1PreparedStatementBinding[],
  ): Promise<Array<{ success: boolean; meta: { changes?: number } }>> {
    this.database.exec("begin");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("commit");
      return results;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  failMeetingAuditIfArmed(query: string): void {
    if (!this.failMeetingAudit || !query.startsWith("insert into audit_events")) return;
    this.failMeetingAudit = false;
    throw new Error("audit unavailable");
  }

  setMeetingFinalizedAt(finalizedAt: string): void {
    this.database
      .prepare("update meetily_meetings set finalized_at=? where workspace_id=? and external_id=?")
      .run(finalizedAt, "workspace-a", "meeting-1");
  }

  finalizeMeetingUpdateIfArmed(query: string): void {
    if (!this.finalizeNextMeetingUpdate || !query.startsWith("update meetily_meetings")) return;
    this.finalizeNextMeetingUpdate = false;
    this.database
      .prepare(
        "update meetily_meetings set state='final', revision=3, title='final' where workspace_id=? and external_id=?",
      )
      .run("workspace-a", "meeting-1");
  }

  prepare(query: string): D1PreparedStatementBinding {
    return new SqliteD1PreparedStatement(this.database, query, [], this);
  }

  value(table: "connections" | "oauth_client_configs", keyColumn: "service", key: string): string {
    const row = this.database.prepare(`select value from ${table} where ${keyColumn} = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? "";
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatementBinding {
  private readonly database: DatabaseSync;
  private readonly query: string;
  private readonly values: unknown[];
  private readonly owner: SqliteD1Database;

  constructor(database: DatabaseSync, query: string, values: unknown[] = [], owner: SqliteD1Database) {
    this.database = database;
    this.query = query;
    this.values = values;
    this.owner = owner;
  }

  bind(...values: unknown[]): D1PreparedStatementBinding {
    return new SqliteD1PreparedStatement(this.database, this.query, values, this.owner);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...toSqlValues(this.values)) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.query).all(...toSqlValues(this.values)) as T[] };
  }

  async run(): Promise<{ success: boolean; meta: { changes?: number } }> {
    this.owner.finalizeMeetingUpdateIfArmed(this.query);
    this.owner.failMeetingAuditIfArmed(this.query);
    const result = this.database.prepare(this.query).run(...toSqlValues(this.values));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function toSqlValues(values: unknown[]): Array<string | number | bigint | null | Uint8Array> {
  return values.map((value) => (value === undefined ? null : (value as string | number | bigint | null | Uint8Array)));
}

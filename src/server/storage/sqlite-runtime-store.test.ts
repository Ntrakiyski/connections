import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { SqliteMeetingStore } from "./meeting-store.ts";
import { RuntimeTokenService } from "./runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "./sqlite-runtime-store.ts";

const tempDirs: string[] = [];
const githubProfile = {
  accountId: "github:octocat",
  displayName: "octocat",
  grantedScopes: [],
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SqliteRuntimeDatabase", () => {
  it("keeps scoped connections isolated between workspaces", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath);
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
    database.close();
  });

  it("archives and permanently purges expired workspace data", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath);
    await database.workspaceStore.create({
      id: "workspace-archive",
      clerkOrgId: "org_archive",
      name: "Archive Me",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    const scoped = database.createScopedStores("workspace-archive");
    await scoped.connectionStore.set("github", "finance", {
      authType: "api_key",
      apiKey: "finance-token",
      values: { apiKey: "finance-token" },
      profile: githubProfile,
      metadata: {},
    });

    await expect(
      database.workspaceLifecycleStore.archive(
        "workspace-archive",
        "2026-07-15T01:00:00.000Z",
        "2026-07-15T01:00:00.000Z",
      ),
    ).resolves.toBe(true);
    await expect(database.workspaceStore.getById("workspace-archive")).resolves.toMatchObject({
      deletedAt: "2026-07-15T01:00:00.000Z",
      purgeAt: "2026-07-15T01:00:00.000Z",
    });

    await expect(database.workspaceLifecycleStore.purgeExpired("2026-07-15T01:00:01.000Z")).resolves.toEqual([
      "workspace-archive",
    ]);
    await expect(database.workspaceStore.getById("workspace-archive")).resolves.toBeUndefined();
    await expect(scoped.connectionStore.get("github", "finance")).resolves.toBeUndefined();
    database.close();
  });

  it("persists local runtime state across database instances", async () => {
    const databasePath = await createDatabasePath();
    const first = new SqliteRuntimeDatabase(databasePath, { runLimit: 2 });

    await first.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: { login: "octocat" },
    });
    await first.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: { tenant: "default" },
      secretExtra: {},
    });
    await first.oauthStateStore.set({
      service: "gmail",
      state: "state-1",
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    await first.runLogStore.add({
      id: "run-1",
      workspaceId: "default",
      userId: "local-dev",
      service: "hackernews",
      actionId: "hackernews.get_top_stories",
      caller: "http",
      startedAt: "2026-06-30T00:00:00.000Z",
      completedAt: "2026-06-30T00:00:01.000Z",
      durationMs: 1000,
      ok: true,
    });
    first.close();

    const second = new SqliteRuntimeDatabase(databasePath, { runLimit: 2 });
    await expect(second.connectionStore.get("github", "default")).resolves.toMatchObject({
      authType: "api_key",
      apiKey: "github-token",
      metadata: { login: "octocat" },
    });
    await expect(second.oauthClientConfigStore.get("gmail")).resolves.toMatchObject({
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: { tenant: "default" },
    });
    await expect(second.oauthStateStore.take("state-1")).resolves.toMatchObject({
      service: "gmail",
      state: "state-1",
    });
    await expect(second.oauthStateStore.take("state-1")).resolves.toBeUndefined();
    await expect(second.runLogStore.list()).resolves.toMatchObject({
      items: [
        {
          id: "run-1",
          workspaceId: "default",
          userId: "local-dev",
          service: "hackernews",
          actionId: "hackernews.get_top_stories",
          caller: "http",
          startedAt: "2026-06-30T00:00:00.000Z",
          completedAt: "2026-06-30T00:00:01.000Z",
          durationMs: 1000,
          ok: true,
        },
      ],
    });
    second.close();
  });

  it("keeps only the configured number of recent runs", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath, { runLimit: 2 });

    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await database.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    await expect(database.runLogStore.list()).resolves.toMatchObject({
      items: [{ id: "run-3" }, { id: "run-2" }],
    });
    database.close();
  });

  it("paginates recent runs with a cursor", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath, { runLimit: 4 });

    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await database.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    const first = await database.runLogStore.list({ limit: 2 });
    expect(first.items.map((run) => run.id)).toEqual(["run-3", "run-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await database.runLogStore.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["run-1"]);
    expect(second.nextCursor).toBeUndefined();
    database.close();
  });

  it("filters recent runs by service before paginating", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath, { runLimit: 5 });

    await database.runLogStore.add(createRun("gmail-1", "2026-06-30T00:00:00.000Z", "mail.search_threads", "gmail"));
    await database.runLogStore.add(createRun("hackernews-1", "2026-06-30T00:00:01.000Z", "news.get_top_stories"));
    await database.runLogStore.add(createRun("gmail-2", "2026-06-30T00:00:02.000Z", "mail.list_threads", "gmail"));

    const first = await database.runLogStore.list({ service: "gmail", limit: 1 });
    expect(first.items.map((run) => run.id)).toEqual(["gmail-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await database.runLogStore.list({ service: "gmail", limit: 1, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["gmail-1"]);
    expect(second.nextCursor).toBeUndefined();
    database.close();
  });

  it("applies pending runtime migrations to existing local databases", async () => {
    const databasePath = await createDatabasePath();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(readFileSync(new URL("../../../sqlite-migrations/0001_runtime.sql", import.meta.url), "utf8"));
    legacy
      .prepare(
        `
        insert into runs (id, action_id, started_at, completed_at, ok, value)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "legacy-gmail",
        "gmail.search_threads",
        "2026-06-30T00:00:00.000Z",
        "2026-06-30T00:00:01.000Z",
        1,
        JSON.stringify({
          id: "legacy-gmail",
          actionId: "gmail.search_threads",
          caller: "http",
          startedAt: "2026-06-30T00:00:00.000Z",
          completedAt: "2026-06-30T00:00:01.000Z",
          durationMs: 1000,
          ok: true,
        }),
      );
    legacy.close();

    const migrated = new SqliteRuntimeDatabase(databasePath, { runLimit: 5 });
    await expect(migrated.runLogStore.list({ service: "gmail" })).resolves.toMatchObject({
      items: [{ id: "legacy-gmail", service: "gmail" }],
    });
    migrated.close();
  });

  it("encrypts stored credentials when a secret codec is configured", async () => {
    const databasePath = await createDatabasePath();
    const first = new SqliteRuntimeDatabase(databasePath, {
      secretCodec: new AesGcmSecretCodec("local-test-key"),
    });

    await first.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: {},
    });
    first.close();

    await expectDatabaseDirectoryNotToContain(databasePath, "github-token");

    const second = new SqliteRuntimeDatabase(databasePath, {
      secretCodec: new AesGcmSecretCodec("local-test-key"),
    });
    await expect(second.connectionStore.get("github", "default")).resolves.toMatchObject({
      authType: "api_key",
      apiKey: "github-token",
    });
    second.close();
  });

  it("persists encrypted automation input and claims each scheduled occurrence once", async () => {
    const databasePath = await createDatabasePath();
    const codec = new AesGcmSecretCodec("automation-test-key");
    const database = new SqliteRuntimeDatabase(databasePath, { secretCodec: codec });
    await database.workspaceStore.create({
      id: "workspace-automation",
      clerkOrgId: "org_automation",
      name: "Automation workspace",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    });
    const definition = {
      name: "Scheduled Gmail draft",
      description: "Creates a Gmail draft at the chosen time.",
      slug: "scheduled-gmail-draft",
      connectionName: "client-gmail",
      actionId: "gmail.create_email_draft" as const,
      steps: [
        { id: "compose" as const, name: "Compose email", kind: "input" as const },
        { id: "schedule" as const, name: "Schedule draft", kind: "schedule" as const },
        { id: "create-draft" as const, name: "Create Gmail draft", kind: "action" as const },
      ] as const,
    };
    await database.automationStore.createDraft(
      {
        id: "automation-1",
        workspaceId: "workspace-automation",
        lifecycle: "draft",
        draftVersionId: "version-1",
        createdBy: "user-1",
        createdAt: "2026-07-20T08:00:00.000Z",
        updatedAt: "2026-07-20T08:00:00.000Z",
      },
      {
        id: "version-1",
        automationId: "automation-1",
        version: 1,
        state: "draft",
        definition,
        createdBy: "user-1",
        createdAt: "2026-07-20T08:00:00.000Z",
      },
    );
    await database.automationStore.publish(
      "workspace-automation",
      "automation-1",
      "version-1",
      {
        automationVersionId: "version-1",
        actionId: "gmail.create_email_draft",
        connectionName: "client-gmail",
        approvedBy: "user-1",
        approvedAt: "2026-07-20T08:01:00.000Z",
        actionPolicyUpdatedAt: "2026-07-20T08:01:00.000Z",
      },
      "2026-07-20T08:01:00.000Z",
    );
    await database.automationStore.createSchedule({
      id: "schedule-1",
      workspaceId: "workspace-automation",
      automationId: "automation-1",
      automationVersionId: "version-1",
      state: "active",
      nextRunAt: "2026-07-20T09:00:00.000Z",
      timeZone: "Europe/Sofia",
      scheduledFor: "2026-07-20T12:00",
      repeat: false,
      input: {
        to: "recipient@example.com",
        subject: "Private subject",
        body: "secret scheduled email body",
        scheduledFor: "2026-07-20T12:00",
        timeZone: "Europe/Sofia",
        repeat: false,
      },
      createdBy: "user-1",
      createdAt: "2026-07-20T08:01:00.000Z",
      updatedAt: "2026-07-20T08:01:00.000Z",
    });

    const claimed = await database.automationStore.claimDueSchedules("2026-07-20T09:00:00.000Z", 10);
    expect(claimed).toMatchObject([
      { id: "schedule-1", state: "running", input: { body: "secret scheduled email body" } },
    ]);
    await expect(database.automationStore.claimDueSchedules("2026-07-20T09:01:00.000Z", 10)).resolves.toEqual([]);
    database.close();

    await expectDatabaseDirectoryNotToContain(databasePath, "secret scheduled email body");
    const reopened = new SqliteRuntimeDatabase(databasePath, { secretCodec: codec });
    await expect(reopened.automationStore.getSchedule("workspace-automation", "schedule-1")).resolves.toMatchObject({
      input: { subject: "Private subject", body: "secret scheduled email body" },
      state: "running",
    });
    reopened.close();
  });

  it("stores runtime token hashes and supports verification and revocation", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath);
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);

    const created = await tokens.createToken("default", "local-dev", "Claude Desktop");
    expect(created.token).toMatch(/^oct_/);
    expect(created.record.name).toBe("Claude Desktop");
    expect(created.record.tokenHash).not.toBe(created.token);
    await expectDatabaseDirectoryNotToContain(databasePath, created.token);

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
    expect(JSON.stringify(listed)).not.toContain(created.token);

    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(true);
    await expect(tokens.listTokens()).resolves.toEqual([]);
    await expect(tokens.verifyToken(created.token)).resolves.toBeUndefined();
    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(false);
    database.close();
  });

  it("resets runtime data", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath);
    await database.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: {},
    });
    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));

    database.resetRuntimeData();

    await expect(database.connectionStore.get("github", "default")).resolves.toBeUndefined();
    await expect(database.runLogStore.list()).resolves.toEqual({ items: [] });
    database.close();
  });

  it("keeps meetings tenant scoped and rejects stale or non-creator updates", async () => {
    const database = new SqliteRuntimeDatabase(await createDatabasePath());
    for (const id of ["workspace-a", "workspace-b"]) {
      await database.workspaceStore.create({
        id,
        clerkOrgId: `org-${id}`,
        name: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const live = {
      externalId: "same-id",
      createdBy: "user-a",
      state: "live" as const,
      revision: 1,
      title: "Sync",
      transcript: "hello",
      transcriptSegments: [],
    };
    await expect(database.meetingStore.put("workspace-a", live)).resolves.toMatchObject({ status: "created" });
    await expect(database.meetingStore.get("workspace-b", "same-id")).resolves.toBeUndefined();
    await expect(database.meetingStore.put("workspace-b", live)).resolves.toMatchObject({ status: "created" });
    await expect(
      database.meetingStore.put("workspace-a", { ...live, state: "final", revision: 2, summary: "done" }),
    ).resolves.toMatchObject({ status: "updated", meeting: { state: "final", summary: "done" } });
    await expect(database.meetingStore.put("workspace-a", { ...live, revision: 3 })).resolves.toMatchObject({
      status: "ignored",
      meeting: { state: "final" },
    });
    await expect(
      database.meetingStore.put("workspace-a", { ...live, createdBy: "user-b", revision: 4 }),
    ).rejects.toThrow("meeting_creator_forbidden");
    database.close();
  });

  it("keeps a concurrent final meeting ahead of a stale lower live update", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_runtime.sql",
      "0002_run-service.sql",
      "0003_workspaces.sql",
      "0007_meetily_meetings.sql",
      "0008_meetily_internal_ids.sql",
    ]) {
      database.exec(readFileSync(new URL(`../../../sqlite-migrations/${migration}`, import.meta.url), "utf8"));
    }
    database
      .prepare("insert into workspaces (id, clerk_org_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("workspace-a", "org-a", "Workspace A", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
    const store = new SqliteMeetingStore(new LateFinalSqliteDatabase(database) as unknown as DatabaseSync);
    const live = createMeetingWrite();

    await store.put("workspace-a", live);
    await expect(store.put("workspace-a", { ...live, revision: 2, title: "late live" })).resolves.toMatchObject({
      status: "ignored",
      meeting: { state: "final", revision: 3, title: "final" },
    });
    database.close();
  });

  it("forbids concurrent meeting creators", async () => {
    const database = new SqliteRuntimeDatabase(await createDatabasePath());
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
    database.close();
  });

  it("keeps the first finalization timestamp across newer final revisions", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_runtime.sql",
      "0002_run-service.sql",
      "0003_workspaces.sql",
      "0007_meetily_meetings.sql",
      "0008_meetily_internal_ids.sql",
    ]) {
      database.exec(readFileSync(new URL(`../../../sqlite-migrations/${migration}`, import.meta.url), "utf8"));
    }
    database
      .prepare("insert into workspaces (id, clerk_org_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("workspace-a", "org-a", "Workspace A", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
    const store = new SqliteMeetingStore(database);
    const final = { ...createMeetingWrite(), state: "final" as const };
    await store.put("workspace-a", final);
    database
      .prepare("update meetily_meetings set finalized_at=? where workspace_id=? and external_id=?")
      .run("2026-07-20T10:00:00.000Z", "workspace-a", "meeting-1");

    await expect(store.put("workspace-a", { ...final, revision: 2 })).resolves.toMatchObject({
      status: "updated",
      meeting: { finalizedAt: "2026-07-20T10:00:00.000Z" },
    });
    database.close();
  });

  it("creates and verifies tenant uniqueness before atomically retiring global uniqueness", () => {
    const migration = readFileSync(
      new URL("../../../migrations/20260720103941_tenant-meetily-meetings.sql", import.meta.url),
      "utf8",
    );
    const transactionStart = migration.indexOf("BEGIN;");
    const tenantUnique = migration.indexOf(
      "ADD CONSTRAINT meetily_meetings_workspace_external_key UNIQUE (workspace_id, external_id)",
    );
    const verification = migration.lastIndexOf("pg_get_constraintdef");
    const globalUniqueDrop = migration.indexOf("DROP CONSTRAINT IF EXISTS meetily_meetings_external_id_key");
    const transactionCommit = migration.indexOf("COMMIT;");

    expect(transactionStart).toBeGreaterThan(-1);
    expect(tenantUnique).toBeGreaterThan(transactionStart);
    expect(verification).toBeGreaterThan(tenantUnique);
    expect(globalUniqueDrop).toBeGreaterThan(verification);
    expect(transactionCommit).toBeGreaterThan(globalUniqueDrop);
    expect(migration).not.toContain("duplicate_object OR duplicate_table");
  });

  it("rotates stored secret encryption without resetting other runtime data", async () => {
    const databasePath = await createDatabasePath();
    const database = new SqliteRuntimeDatabase(databasePath, {
      secretCodec: new AesGcmSecretCodec("old-key"),
    });
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const token = await tokens.createToken("default", "local-dev", "Claude Desktop");
    await database.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: {},
    });
    await database.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: {},
      secretExtra: {},
    });
    await database.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await database.rotateSecretCodec(new AesGcmSecretCodec("new-key"));
    database.close();

    const withOldKey = new SqliteRuntimeDatabase(databasePath, {
      secretCodec: new AesGcmSecretCodec("old-key"),
    });
    await expect(withOldKey.connectionStore.get("github", "default")).rejects.toThrow();
    withOldKey.close();

    const withNewKey = new SqliteRuntimeDatabase(databasePath, {
      secretCodec: new AesGcmSecretCodec("new-key"),
    });
    await expect(withNewKey.connectionStore.get("github", "default")).resolves.toMatchObject({
      authType: "api_key",
      apiKey: "github-token",
    });
    await expect(withNewKey.oauthClientConfigStore.get("gmail")).resolves.toMatchObject({
      clientSecret: "client-secret",
    });
    await expect(withNewKey.runtimeTokenStore.list()).resolves.toMatchObject([{ id: token.record.id }]);
    await expect(withNewKey.runLogStore.list()).resolves.toMatchObject({ items: [{ id: "run-1" }] });
    withNewKey.close();
  });
});

async function createDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oomol-connect-"));
  tempDirs.push(dir);
  return join(dir, "connect.sqlite");
}

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

class LateFinalSqliteDatabase {
  private armed = true;
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(query: string): ReturnType<DatabaseSync["prepare"]> {
    const statement = this.database.prepare(query);
    if (!query.startsWith("update meetily_meetings")) return statement;
    return {
      ...statement,
      run: (...values: Parameters<typeof statement.run>) => {
        if (this.armed) {
          this.armed = false;
          this.database
            .prepare(
              "update meetily_meetings set state='final', revision=3, title='final' where workspace_id=? and external_id=?",
            )
            .run("workspace-a", "meeting-1");
        }
        return statement.run(...values);
      },
    } as ReturnType<DatabaseSync["prepare"]>;
  }
}

async function expectDatabaseDirectoryNotToContain(databasePath: string, needle: string): Promise<void> {
  const dir = dirname(databasePath);
  const entries = await readdir(dir);
  for (const entry of entries) {
    const bytes = await readFile(join(dir, entry), "utf8");
    expect(bytes).not.toContain(needle);
  }
}

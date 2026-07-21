import type { RuntimeActionDefinition } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionRunner } from "../actions/action-runner.ts";
import type { WorkspaceControlService } from "../workspace-control-service.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { AutomationService } from "./automation-service.ts";

const tempDirs: string[] = [];
const actor = { workspaceId: "workspace-automation", userId: "manager-1", role: "manager" as const };
const definition = {
  name: "Scheduled Gmail draft",
  description: "Create a Gmail draft later.",
  slug: "scheduled-gmail-draft",
  connectionName: "team-gmail",
  actionId: "gmail.create_email_draft" as const,
  steps: [
    { id: "compose" as const, name: "Compose email", kind: "input" as const },
    { id: "schedule" as const, name: "Schedule draft", kind: "schedule" as const },
    { id: "create-draft" as const, name: "Create Gmail draft", kind: "action" as const },
  ] as const,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("AutomationService", () => {
  it("tests the draft through Gmail without scheduling it, then publishes and schedules the automation", async () => {
    const database = new SqliteRuntimeDatabase(await createDatabasePath());
    await database.workspaceStore.create({
      id: actor.workspaceId,
      clerkOrgId: "org-automation",
      name: "Automation workspace",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    });
    const actionRun = vi.fn(async () => ({
      executionId: "action-run-1",
      result: { ok: true as const, output: { draftId: "draft-1", messageId: "message-1" } },
    }));
    const service = new AutomationService({
      store: database.automationStore,
      actions: { run: actionRun } as unknown as ActionRunner,
      connections: {
        getConnectionSummary: async () => ({ configured: true }),
      } as unknown as ConnectionService,
      controls: {
        assertProviderEnabled: async () => undefined,
        getActionPolicy: async () => ({ updatedAt: "policy-1", requireApproval: true }),
        audit: async () => undefined,
      } as unknown as WorkspaceControlService,
      gmailDraftAction: { id: "gmail.create_email_draft" } as RuntimeActionDefinition,
    });

    const publishOnly = await service.build(actor, { ...definition, slug: "publish-only-gmail-draft" });
    await service.publish(actor, publishOnly.automation.id, true);
    await expect(service.get(actor, publishOnly.automation.id)).resolves.toMatchObject({ schedules: [] });

    const built = await service.build(actor, definition);
    await expect(
      service.saveConfiguration(actor, built.automation.id, {
        to: "recipient@example.com",
        subject: "Saved subject",
        body: "Saved private body",
        scheduledFor: "2026-07-20T12:00",
        timeZone: "Europe/Sofia",
        repeat: false,
      }),
    ).resolves.toMatchObject({
      configuration: {
        input: { subject: "Saved subject", body: "Saved private body" },
        updatedBy: actor.userId,
      },
    });
    expect(actionRun).not.toHaveBeenCalled();
    await expect(
      service.test(
        actor,
        built.automation.id,
        { to: "recipient@example.com", subject: "Subject", body: "Private body" },
        false,
      ),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      service.test(
        actor,
        built.automation.id,
        { to: "recipient@example.com", subject: "Subject", body: "Private body" },
        true,
      ),
    ).resolves.toMatchObject({ ok: true, draftId: "draft-1" });
    expect(actionRun).toHaveBeenCalledWith({
      actionId: "gmail.create_email_draft",
      connectionName: "team-gmail",
      input: { to: "recipient@example.com", subject: "Subject", body: "Private body" },
      caller: "automation",
    });
    await expect(service.listRuns(actor, built.automation.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "success", draftId: "draft-1" })]),
    );
    const scheduled = await service.publishAndSchedule(
      actor,
      built.automation.id,
      {
        to: "recipient@example.com",
        subject: "Subject",
        body: "Private body",
        scheduledFor: "2026-07-20T12:00",
        timeZone: "Europe/Sofia",
        repeat: false,
      },
      true,
    );
    expect(scheduled.state).toBe("active");
    expect(scheduled.nextRunAt).toBe("2026-07-20T09:00:00.000Z");

    await service.processDue("2026-07-20T09:00:00.000Z");

    const after = await service.get(actor, built.automation.id);
    expect(after.schedules).toHaveLength(2);
    expect(after.schedules).toEqual(expect.arrayContaining([expect.objectContaining({ state: "completed" })]));
    expect(actionRun).toHaveBeenLastCalledWith({
      actionId: "gmail.create_email_draft",
      connectionName: "team-gmail",
      input: { to: "recipient@example.com", subject: "Subject", body: "Private body" },
      caller: "automation",
    });
    await expect(service.listRuns(actor, built.automation.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "success", draftId: "draft-1" })]),
    );
    database.close();
  });
});

async function createDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oomol-automation-"));
  tempDirs.push(dir);
  return join(dir, "connect.sqlite");
}

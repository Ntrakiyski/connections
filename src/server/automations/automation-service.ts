import type { RuntimeActionDefinition } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionRunner } from "../actions/action-runner.ts";
import type { WorkspaceControlService } from "../workspace-control-service.ts";
import type {
  AutomationDetail,
  AutomationConfiguration,
  AutomationRun,
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationStepRun,
  AutomationStore,
  AutomationTestInput,
  AutomationVersionRecord,
  GmailDraftAutomationDefinition,
} from "./automation-store.ts";

import { Temporal } from "@js-temporal/polyfill";

export class AutomationError extends Error {
  readonly code:
    | "automation_not_found"
    | "draft_not_found"
    | "not_live"
    | "invalid_input"
    | "gmail_connection_unavailable"
    | "approval_required"
    | "execution_failed";

  constructor(code: AutomationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface AutomationActor {
  workspaceId: string;
  userId: string;
  role: "member" | "manager" | "admin";
}

export interface AutomationServices {
  store: AutomationStore;
  actions: ActionRunner;
  connections: ConnectionService;
  controls: WorkspaceControlService;
  gmailDraftAction?: RuntimeActionDefinition;
  createWorkspaceService?(schedule: AutomationSchedule): Promise<AutomationService | undefined>;
}

export class AutomationService {
  private readonly services: AutomationServices;

  constructor(services: AutomationServices) {
    this.services = services;
  }

  async build(actor: AutomationActor, definition: GmailDraftAutomationDefinition): Promise<AutomationDetail> {
    assertManager(actor);
    await this.validateDefinition(definition);
    const now = new Date().toISOString();
    const automationId = crypto.randomUUID();
    const version: AutomationVersionRecord = {
      id: crypto.randomUUID(),
      automationId,
      version: 1,
      state: "draft",
      definition,
      createdBy: actor.userId,
      createdAt: now,
    };
    await this.services.store.createDraft(
      {
        id: automationId,
        workspaceId: actor.workspaceId,
        lifecycle: "draft",
        draftVersionId: version.id,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      },
      version,
    );
    await this.services.controls.audit("automation.created", "automation", automationId);
    return (await this.services.store.get(actor.workspaceId, automationId))!;
  }

  async edit(
    actor: AutomationActor,
    automationId: string,
    definition: GmailDraftAutomationDefinition,
  ): Promise<AutomationDetail> {
    assertManager(actor);
    await this.validateDefinition(definition);
    const existing = await this.requireAutomation(actor.workspaceId, automationId);
    const version: AutomationVersionRecord = {
      id: crypto.randomUUID(),
      automationId,
      version: (existing.draft?.version ?? existing.live?.version ?? 0) + 1,
      state: "draft",
      definition,
      createdBy: actor.userId,
      createdAt: new Date().toISOString(),
    };
    const detail = await this.services.store.replaceDraft(actor.workspaceId, automationId, version);
    if (!detail) throw new AutomationError("automation_not_found", "Automation was not found.");
    await this.services.controls.audit("automation.draft_updated", "automation", automationId);
    return detail;
  }

  async test(
    actor: AutomationActor,
    automationId: string,
    input: AutomationTestInput,
    confirmed: boolean,
  ): Promise<Record<string, unknown>> {
    assertManager(actor);
    if (!confirmed)
      throw new AutomationError("approval_required", "Testing requires approval to create one Gmail draft.");
    const detail = await this.requireAutomation(actor.workspaceId, automationId);
    const version = detail.draft;
    if (!version) throw new AutomationError("draft_not_found", "Automation has no draft to test.");
    await this.validateDefinition(version.definition);
    validateTestInput(input);
    await this.currentPolicy(version.definition);
    const now = new Date().toISOString();
    const schedule: AutomationSchedule = {
      id: crypto.randomUUID(),
      workspaceId: actor.workspaceId,
      automationId,
      automationVersionId: version.id,
      state: "completed",
      timeZone: "UTC",
      scheduledFor: now,
      repeat: false,
      input: { ...input, scheduledFor: now, timeZone: "UTC", repeat: false },
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    // Completed test schedules anchor test runs without creating a future occurrence.
    await this.services.store.createSchedule(schedule);
    const run = await this.executeRun(schedule, version.definition, now);
    if (!run || run.status !== "success") {
      throw new AutomationError("execution_failed", run?.errorMessage ?? "Gmail draft creation failed.");
    }
    await this.services.controls.audit("automation.test_executed", "automation", automationId);
    return {
      ok: true,
      actionId: version.definition.actionId,
      connectionName: version.definition.connectionName,
      draftId: run.draftId,
    };
  }

  async publish(actor: AutomationActor, automationId: string, confirmed: boolean): Promise<AutomationDetail> {
    assertManager(actor);
    if (!confirmed) throw new AutomationError("approval_required", "Publishing requires explicit approval.");
    const detail = await this.requireAutomation(actor.workspaceId, automationId);
    const draft = detail.draft;
    if (!draft) throw new AutomationError("draft_not_found", "Automation has no draft to publish.");
    await this.validateDefinition(draft.definition);
    const policy = await this.currentPolicy(draft.definition);
    const publishedAt = new Date().toISOString();
    const next = await this.services.store.publish(
      actor.workspaceId,
      automationId,
      draft.id,
      {
        automationVersionId: draft.id,
        actionId: draft.definition.actionId,
        connectionName: draft.definition.connectionName,
        approvedBy: actor.userId,
        approvedAt: publishedAt,
        actionPolicyUpdatedAt: policy.updatedAt,
      },
      publishedAt,
    );
    if (!next) throw new AutomationError("automation_not_found", "Automation was not found.");
    await this.services.controls.audit("automation.published", "automation", automationId);
    return next;
  }

  async saveConfiguration(
    actor: AutomationActor,
    automationId: string,
    input: AutomationScheduleInput,
  ): Promise<AutomationDetail> {
    await this.requireAutomation(actor.workspaceId, automationId);
    validateScheduleInput(input);
    const updatedAt = new Date().toISOString();
    const configuration: AutomationConfiguration = {
      workspaceId: actor.workspaceId,
      automationId,
      input,
      updatedBy: actor.userId,
      updatedAt,
    };
    await this.services.store.saveConfiguration(configuration);
    await this.services.controls.audit("automation.configuration_saved", "automation", automationId);
    return await this.requireAutomation(actor.workspaceId, automationId);
  }

  async schedule(
    actor: AutomationActor,
    automationId: string,
    input: AutomationScheduleInput,
  ): Promise<AutomationSchedule> {
    const detail = await this.requireAutomation(actor.workspaceId, automationId);
    const live = detail.live;
    if (!live || detail.automation.lifecycle !== "live") {
      throw new AutomationError("not_live", "Only a live automation can create schedules.");
    }
    await this.validateDefinition(live.definition);
    validateScheduleInput(input);
    const nextRunAt = calculateNextRun(input, new Date().toISOString());
    const now = new Date().toISOString();
    const schedule: AutomationSchedule = {
      id: crypto.randomUUID(),
      workspaceId: actor.workspaceId,
      automationId,
      automationVersionId: live.id,
      state: "active",
      nextRunAt,
      timeZone: input.timeZone,
      scheduledFor: input.scheduledFor,
      repeat: input.repeat,
      cadence: input.cadence,
      endAt: input.endAt,
      input,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.services.store.createSchedule(schedule);
    await this.services.controls.audit("automation.schedule_created", "automation_schedule", schedule.id);
    return schedule;
  }

  async stopSchedule(actor: AutomationActor, scheduleId: string): Promise<boolean> {
    const stopped = await this.services.store.stopSchedule(actor.workspaceId, scheduleId, new Date().toISOString());
    if (stopped) await this.services.controls.audit("automation.schedule_stopped", "automation_schedule", scheduleId);
    return stopped;
  }

  async disable(actor: AutomationActor, automationId: string): Promise<boolean> {
    assertManager(actor);
    const disabled = await this.services.store.disable(actor.workspaceId, automationId, new Date().toISOString());
    if (disabled) await this.services.controls.audit("automation.disabled", "automation", automationId);
    return disabled;
  }

  async get(actor: AutomationActor, automationId: string): Promise<AutomationDetail> {
    return await this.requireAutomation(actor.workspaceId, automationId);
  }

  list(actor: AutomationActor): Promise<AutomationDetail[]> {
    return this.services.store.list(actor.workspaceId);
  }

  listRuns(actor: AutomationActor, automationId: string): Promise<AutomationRun[]> {
    return this.services.store.listRuns(actor.workspaceId, automationId);
  }

  async processDue(now: string = new Date().toISOString()): Promise<void> {
    const schedules = await this.services.store.claimDueSchedules(now, 20);
    for (const schedule of schedules) {
      const workspaceService = this.services.createWorkspaceService
        ? await this.services.createWorkspaceService(schedule)
        : this;
      if (!workspaceService) {
        await this.block(schedule, "workspace_access_revoked", "The schedule owner no longer has workspace access.");
        continue;
      }
      await workspaceService.executeSchedule(schedule, now);
    }
  }

  private async executeSchedule(schedule: AutomationSchedule, now: string): Promise<void> {
    const detail = await this.services.store.get(schedule.workspaceId, schedule.automationId);
    const live = detail?.live;
    if (!detail || !live || detail.automation.lifecycle !== "live" || live.id !== schedule.automationVersionId) {
      return await this.block(schedule, "automation_not_live", "The scheduled automation is no longer live.");
    }
    const approval = await this.services.store.getApproval(live.id);
    if (
      !approval ||
      approval.actionId !== live.definition.actionId ||
      approval.connectionName !== live.definition.connectionName
    ) {
      return await this.block(schedule, "approval_required", "The live automation approval is no longer valid.");
    }
    try {
      const policy = await this.currentPolicy(live.definition);
      if (policy.updatedAt !== approval.actionPolicyUpdatedAt) {
        return await this.block(
          schedule,
          "approval_policy_changed",
          "The Gmail action policy changed after this automation was published.",
        );
      }
    } catch (error) {
      return await this.block(
        schedule,
        "action_policy_unavailable",
        error instanceof Error ? error.message : "The Gmail action policy is unavailable.",
      );
    }
    try {
      await this.validateDefinition(live.definition);
    } catch (error) {
      return await this.block(
        schedule,
        "gmail_connection_unavailable",
        error instanceof Error ? error.message : "Gmail unavailable.",
      );
    }

    if (isMissedRecurringOccurrence(schedule, now)) {
      await this.recordSkippedOccurrence(schedule, now);
      return;
    }

    await this.executeRun(schedule, live.definition, now);
  }

  private async executeRun(
    schedule: AutomationSchedule,
    definition: GmailDraftAutomationDefinition,
    now: string,
  ): Promise<AutomationRun | undefined> {
    const run: AutomationRun = {
      id: crypto.randomUUID(),
      workspaceId: schedule.workspaceId,
      automationId: schedule.automationId,
      automationVersionId: schedule.automationVersionId,
      scheduleId: schedule.id,
      occurrenceAt: schedule.nextRunAt ?? now,
      status: "running",
      startedAt: now,
    };
    const steps = createStepRuns(run.id, now);
    if (!(await this.services.store.createRun(run, steps))) {
      schedule.nextRunAt = nextScheduleRun(schedule, now);
      schedule.state = schedule.nextRunAt ? "active" : "completed";
      schedule.claimedAt = undefined;
      schedule.updatedAt = now;
      await this.services.store.saveSchedule(schedule);
      return undefined;
    }
    let action: Awaited<ReturnType<ActionRunner["run"]>>;
    try {
      action = await this.services.actions.run({
        actionId: definition.actionId,
        connectionName: definition.connectionName,
        input: { to: schedule.input.to, subject: schedule.input.subject, body: schedule.input.body },
        caller: "automation",
      });
    } catch (error) {
      action = {
        executionId: "",
        result: {
          ok: false,
          error: {
            code: "execution_failed",
            message: error instanceof Error ? error.message : "Gmail draft creation failed.",
          },
        },
      };
    }
    const completedAt = new Date().toISOString();
    if (!action?.result.ok) {
      run.status = "failed";
      run.completedAt = completedAt;
      run.errorCode = action?.result.error?.code ?? "execution_failed";
      run.errorMessage = action?.result.error?.message ?? "Gmail draft creation failed.";
      steps[2] = {
        ...steps[2]!,
        status: "failed",
        completedAt,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
      };
    } else {
      run.status = "success";
      run.completedAt = completedAt;
      const output = action.result.output as Record<string, unknown> | undefined;
      run.draftId = typeof output?.draftId === "string" ? output.draftId : undefined;
      steps[2] = { ...steps[2]!, status: "success", completedAt };
    }
    steps[0] = { ...steps[0]!, status: "success", completedAt };
    steps[1] = { ...steps[1]!, status: "success", completedAt };
    await this.services.store.completeRun(run, steps);
    schedule.nextRunAt = nextScheduleRun(schedule, completedAt);
    schedule.updatedAt = completedAt;
    schedule.state = schedule.nextRunAt ? "active" : "completed";
    schedule.claimedAt = undefined;
    await this.services.store.saveSchedule(schedule);
    return run;
  }

  private async validateDefinition(definition: GmailDraftAutomationDefinition): Promise<void> {
    if (definition.actionId !== "gmail.create_email_draft" || definition.steps.length !== 3) {
      throw new AutomationError("invalid_input", "The Gmail draft automation must use its three declared steps.");
    }
    if (this.services.gmailDraftAction?.id !== definition.actionId) {
      throw new AutomationError("invalid_input", "The Gmail draft action is unavailable in this runtime.");
    }
    await this.services.controls.assertProviderEnabled("gmail");
    const connection = await this.services.connections.getConnectionSummary("gmail", definition.connectionName);
    if (!connection?.configured) {
      throw new AutomationError("gmail_connection_unavailable", "The selected Gmail connection is unavailable.");
    }
  }

  private async currentPolicy(definition: GmailDraftAutomationDefinition) {
    const action = this.services.gmailDraftAction;
    if (!action || action.id !== definition.actionId) {
      throw new AutomationError("invalid_input", "The Gmail draft action is unavailable in this runtime.");
    }
    return await this.services.controls.getActionPolicy(action);
  }

  private async requireAutomation(workspaceId: string, automationId: string): Promise<AutomationDetail> {
    const detail = await this.services.store.get(workspaceId, automationId);
    if (!detail) throw new AutomationError("automation_not_found", "Automation was not found.");
    return detail;
  }

  private async block(schedule: AutomationSchedule, code: string, message: string): Promise<void> {
    schedule.state = "blocked";
    schedule.blockedReason = message;
    schedule.updatedAt = new Date().toISOString();
    schedule.claimedAt = undefined;
    await this.services.store.saveSchedule(schedule);
  }

  private async recordSkippedOccurrence(schedule: AutomationSchedule, now: string): Promise<void> {
    const occurrenceAt = schedule.nextRunAt!;
    const run: AutomationRun = {
      id: crypto.randomUUID(),
      workspaceId: schedule.workspaceId,
      automationId: schedule.automationId,
      automationVersionId: schedule.automationVersionId,
      scheduleId: schedule.id,
      occurrenceAt,
      status: "skipped",
      startedAt: now,
      completedAt: now,
      errorCode: "missed_occurrence",
      errorMessage: "Skipped after the scheduler was unavailable; recurring schedules are not replayed automatically.",
    };
    const steps = createStepRuns(run.id, now).map((step) => ({
      ...step,
      status: "skipped" as const,
      completedAt: now,
    }));
    if (await this.services.store.createRun(run, steps)) await this.services.store.completeRun(run, steps);
    schedule.nextRunAt = nextScheduleRun(schedule, now);
    schedule.state = schedule.nextRunAt ? "active" : "completed";
    schedule.claimedAt = undefined;
    schedule.updatedAt = now;
    await this.services.store.saveSchedule(schedule);
  }
}

function assertManager(actor: AutomationActor): void {
  if (actor.role === "member") throw new AutomationError("approval_required", "Manager access is required.");
}

function validateScheduleInput(input: AutomationScheduleInput): void {
  if (!input.to || !input.subject || !input.body || !input.scheduledFor || !input.timeZone) {
    throw new AutomationError("invalid_input", "Recipient, subject, body, date, and time zone are required.");
  }
  if (input.repeat && !input.cadence) throw new AutomationError("invalid_input", "A repeat cadence is required.");
  try {
    Temporal.ZonedDateTime.from(`${input.scheduledFor}[${input.timeZone}]`);
  } catch {
    throw new AutomationError("invalid_input", "The scheduled date, time, or time zone is invalid.");
  }
}

function validateTestInput(input: AutomationTestInput): void {
  if (!input.to || !input.subject || !input.body) {
    throw new AutomationError("invalid_input", "Recipient, subject, and body are required.");
  }
}

function calculateNextRun(input: AutomationScheduleInput, now: string): string {
  const selected = Temporal.ZonedDateTime.from(`${input.scheduledFor}[${input.timeZone}]`);
  const current = Temporal.Instant.from(now).toZonedDateTimeISO(input.timeZone);
  if (Temporal.ZonedDateTime.compare(selected, current) >= 0) return formatInstant(selected.toInstant());
  if (!input.repeat) return formatInstant(selected.toInstant());
  return formatInstant(advanceToFuture(selected, current, input.cadence!).toInstant());
}

function nextScheduleRun(schedule: AutomationSchedule, now: string): string | undefined {
  if (!schedule.repeat || !schedule.nextRunAt || !schedule.cadence) return undefined;
  const next = Temporal.Instant.from(schedule.nextRunAt)
    .toZonedDateTimeISO(schedule.timeZone)
    .add(schedule.cadence === "daily" ? { days: 1 } : { weeks: 1 });
  if (schedule.endAt && Temporal.Instant.compare(next.toInstant(), Temporal.Instant.from(schedule.endAt)) > 0)
    return undefined;
  const current = Temporal.Instant.from(now).toZonedDateTimeISO(schedule.timeZone);
  return formatInstant(advanceToFuture(next, current, schedule.cadence).toInstant());
}

function isMissedRecurringOccurrence(schedule: AutomationSchedule, now: string): boolean {
  if (!schedule.repeat || !schedule.nextRunAt) return false;
  return (
    Temporal.Instant.compare(
      Temporal.Instant.from(schedule.nextRunAt),
      Temporal.Instant.from(now).subtract({ minutes: 1 }),
    ) < 0
  );
}

function formatInstant(value: Temporal.Instant): string {
  return value.toString({ fractionalSecondDigits: 3 });
}

function advanceToFuture(
  value: Temporal.ZonedDateTime,
  current: Temporal.ZonedDateTime,
  cadence: AutomationScheduleInput["cadence"],
): Temporal.ZonedDateTime {
  let next = value;
  while (Temporal.ZonedDateTime.compare(next, current) < 0)
    next = next.add(cadence === "daily" ? { days: 1 } : { weeks: 1 });
  return next;
}

function createStepRuns(runId: string, now: string): AutomationStepRun[] {
  return [
    { id: crypto.randomUUID(), automationRunId: runId, stepId: "compose", order: 1, status: "running", startedAt: now },
    {
      id: crypto.randomUUID(),
      automationRunId: runId,
      stepId: "schedule",
      order: 2,
      status: "running",
      startedAt: now,
    },
    {
      id: crypto.randomUUID(),
      automationRunId: runId,
      stepId: "create-draft",
      order: 3,
      status: "running",
      startedAt: now,
    },
  ];
}

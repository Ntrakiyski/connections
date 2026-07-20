import type {
  AutomationApprovalGrant,
  AutomationDetail,
  AutomationRecord,
  AutomationRun,
  AutomationSchedule,
  AutomationStepRun,
  AutomationStore,
  AutomationVersionRecord,
  GmailDraftAutomationDefinition,
} from "../automations/automation-store.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";

import { DatabaseSync } from "node:sqlite";

export class SqliteAutomationStore implements AutomationStore {
  private readonly database: DatabaseSync;
  private readonly codec: ISecretCodec;

  constructor(database: DatabaseSync, codec: ISecretCodec) {
    this.database = database;
    this.codec = codec;
  }

  async createDraft(automation: AutomationRecord, version: AutomationVersionRecord): Promise<void> {
    this.database.exec("begin immediate");
    try {
      this.database
        .prepare(
          "insert into automations (id, workspace_id, lifecycle, draft_version_id, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          automation.id,
          automation.workspaceId,
          automation.lifecycle,
          version.id,
          automation.createdBy,
          automation.createdAt,
          automation.updatedAt,
        );
      this.insertVersion(version);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async get(workspaceId: string, automationId: string): Promise<AutomationDetail | undefined> {
    const row = this.database
      .prepare("select * from automations where workspace_id = ? and id = ?")
      .get(workspaceId, automationId);
    return row ? await this.detail(readAutomation(row)) : undefined;
  }

  async list(workspaceId: string): Promise<AutomationDetail[]> {
    const rows = this.database
      .prepare("select * from automations where workspace_id = ? order by updated_at desc, id desc")
      .all(workspaceId);
    return await Promise.all(rows.map(async (row) => await this.detail(readAutomation(row))));
  }

  async replaceDraft(
    workspaceId: string,
    automationId: string,
    version: AutomationVersionRecord,
  ): Promise<AutomationDetail | undefined> {
    this.database.exec("begin immediate");
    try {
      const result = this.database
        .prepare(
          "update automations set draft_version_id = ?, lifecycle = case when live_version_id is null then 'draft' else lifecycle end, updated_at = ? where id = ? and workspace_id = ?",
        )
        .run(version.id, version.createdAt, automationId, workspaceId);
      if (result.changes === 0) {
        this.database.exec("rollback");
        return undefined;
      }
      this.database
        .prepare("update automation_versions set state = 'superseded' where automation_id = ? and state = 'draft'")
        .run(automationId);
      this.insertVersion(version);
      this.database.exec("commit");
      return await this.get(workspaceId, automationId);
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async publish(
    workspaceId: string,
    automationId: string,
    versionId: string,
    approval: AutomationApprovalGrant,
    publishedAt: string,
  ): Promise<AutomationDetail | undefined> {
    this.database.exec("begin immediate");
    try {
      const exists = this.database
        .prepare("select id from automations where workspace_id = ? and id = ?")
        .get(workspaceId, automationId);
      if (!exists) {
        this.database.exec("rollback");
        return undefined;
      }
      this.database
        .prepare("update automation_versions set state = 'superseded' where automation_id = ? and state = 'live'")
        .run(automationId);
      this.database
        .prepare("update automation_versions set state = 'live', published_at = ? where id = ? and automation_id = ?")
        .run(publishedAt, versionId, automationId);
      this.database
        .prepare(
          "insert into automation_approval_grants (automation_version_id, action_id, connection_name, approved_by, approved_at, action_policy_updated_at) values (?, ?, ?, ?, ?, ?) on conflict(automation_version_id) do update set action_id = excluded.action_id, connection_name = excluded.connection_name, approved_by = excluded.approved_by, approved_at = excluded.approved_at, action_policy_updated_at = excluded.action_policy_updated_at",
        )
        .run(
          approval.automationVersionId,
          approval.actionId,
          approval.connectionName,
          approval.approvedBy,
          approval.approvedAt,
          approval.actionPolicyUpdatedAt,
        );
      this.database
        .prepare(
          "update automations set live_version_id = ?, draft_version_id = null, lifecycle = 'live', updated_at = ? where id = ?",
        )
        .run(versionId, publishedAt, automationId);
      this.database.exec("commit");
      return await this.get(workspaceId, automationId);
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async disable(workspaceId: string, automationId: string, updatedAt: string): Promise<boolean> {
    this.database.exec("begin immediate");
    try {
      const result = this.database
        .prepare("update automations set lifecycle = 'disabled', updated_at = ? where id = ? and workspace_id = ?")
        .run(updatedAt, automationId, workspaceId);
      this.database
        .prepare(
          "update automation_schedules set state = 'disabled', claimed_at = null, updated_at = ? where automation_id = ? and workspace_id = ? and state in ('active', 'running')",
        )
        .run(updatedAt, automationId, workspaceId);
      this.database.exec("commit");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async createSchedule(schedule: AutomationSchedule): Promise<void> {
    await this.saveSchedule(schedule);
  }

  async getSchedule(workspaceId: string, scheduleId: string): Promise<AutomationSchedule | undefined> {
    const row = this.database
      .prepare("select * from automation_schedules where workspace_id = ? and id = ?")
      .get(workspaceId, scheduleId);
    return row ? await this.readSchedule(row) : undefined;
  }

  async listSchedules(workspaceId: string, automationId: string): Promise<AutomationSchedule[]> {
    const rows = this.database
      .prepare(
        "select * from automation_schedules where workspace_id = ? and automation_id = ? order by created_at desc",
      )
      .all(workspaceId, automationId);
    return await Promise.all(rows.map(async (row) => await this.readSchedule(row)));
  }

  async stopSchedule(workspaceId: string, scheduleId: string, updatedAt: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          "update automation_schedules set state = 'disabled', updated_at = ? where workspace_id = ? and id = ? and state = 'active'",
        )
        .run(updatedAt, workspaceId, scheduleId).changes > 0
    );
  }

  async claimDueSchedules(now: string, limit: number): Promise<AutomationSchedule[]> {
    this.database.exec("begin immediate");
    try {
      const staleClaimAt = new Date(Date.parse(now) - 5 * 60_000).toISOString();
      const rows = this.database
        .prepare(
          "select * from automation_schedules where (state = 'active' and next_run_at <= ?) or (state = 'running' and claimed_at <= ?) order by next_run_at asc limit ?",
        )
        .all(now, staleClaimAt, limit);
      const update = this.database.prepare(
        "update automation_schedules set state = 'running', claimed_at = ?, updated_at = ? where id = ? and state in ('active', 'running')",
      );
      const claimed = rows.filter((row) => update.run(now, now, text(row, "id")).changes > 0);
      this.database.exec("commit");
      return await Promise.all(
        claimed.map(
          async (row) => await this.readSchedule({ ...row, state: "running", claimed_at: now, updated_at: now }),
        ),
      );
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async saveSchedule(schedule: AutomationSchedule): Promise<void> {
    const input = await this.codec.encode(JSON.stringify(schedule.input));
    this.database
      .prepare(`insert into automation_schedules (id, workspace_id, automation_id, automation_version_id, state, next_run_at, time_zone, scheduled_for, repeat, cadence, end_at, encrypted_input, created_by, created_at, updated_at, claimed_at, blocked_reason)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set state = excluded.state, next_run_at = excluded.next_run_at, end_at = excluded.end_at, encrypted_input = excluded.encrypted_input, updated_at = excluded.updated_at, claimed_at = excluded.claimed_at, blocked_reason = excluded.blocked_reason`)
      .run(
        schedule.id,
        schedule.workspaceId,
        schedule.automationId,
        schedule.automationVersionId,
        schedule.state,
        schedule.nextRunAt ?? null,
        schedule.timeZone,
        schedule.scheduledFor,
        schedule.repeat ? 1 : 0,
        schedule.cadence ?? null,
        schedule.endAt ?? null,
        input,
        schedule.createdBy,
        schedule.createdAt,
        schedule.updatedAt,
        schedule.claimedAt ?? null,
        schedule.blockedReason ?? null,
      );
  }

  async getApproval(versionId: string): Promise<AutomationApprovalGrant | undefined> {
    const row = this.database
      .prepare("select * from automation_approval_grants where automation_version_id = ?")
      .get(versionId);
    return row ? readApproval(row) : undefined;
  }

  async createRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<boolean> {
    this.database.exec("begin immediate");
    try {
      const result = this.database
        .prepare(
          "insert into automation_runs (id, workspace_id, automation_id, automation_version_id, schedule_id, occurrence_at, status, started_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(schedule_id, occurrence_at) do nothing",
        )
        .run(
          run.id,
          run.workspaceId,
          run.automationId,
          run.automationVersionId,
          run.scheduleId,
          run.occurrenceAt,
          run.status,
          run.startedAt,
        );
      if (result.changes === 0) {
        this.database.exec("rollback");
        return false;
      }
      const insert = this.database.prepare(
        "insert into automation_step_runs (id, automation_run_id, step_id, step_order, status, started_at, completed_at, error_code, error_message) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const step of steps)
        insert.run(
          step.id,
          step.automationRunId,
          step.stepId,
          step.order,
          step.status,
          step.startedAt,
          step.completedAt ?? null,
          step.errorCode ?? null,
          step.errorMessage ?? null,
        );
      this.database.exec("commit");
      return true;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async completeRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<void> {
    this.database.exec("begin immediate");
    try {
      this.database
        .prepare(
          "update automation_runs set status = ?, completed_at = ?, error_code = ?, error_message = ?, draft_id = ? where id = ?",
        )
        .run(
          run.status,
          run.completedAt ?? null,
          run.errorCode ?? null,
          run.errorMessage ?? null,
          run.draftId ?? null,
          run.id,
        );
      const update = this.database.prepare(
        "update automation_step_runs set status = ?, completed_at = ?, error_code = ?, error_message = ? where id = ?",
      );
      for (const step of steps)
        update.run(step.status, step.completedAt ?? null, step.errorCode ?? null, step.errorMessage ?? null, step.id);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async listRuns(workspaceId: string, automationId: string): Promise<AutomationRun[]> {
    return this.database
      .prepare("select * from automation_runs where workspace_id = ? and automation_id = ? order by started_at desc")
      .all(workspaceId, automationId)
      .map(readRun);
  }

  private async detail(automation: AutomationRecord): Promise<AutomationDetail> {
    const draft = automation.draftVersionId ? this.getVersion(automation.draftVersionId) : undefined;
    const live = automation.liveVersionId ? this.getVersion(automation.liveVersionId) : undefined;
    return {
      automation,
      draft: await draft,
      live: await live,
      schedules: await this.listSchedules(automation.workspaceId, automation.id),
      runs: await this.listRuns(automation.workspaceId, automation.id),
    };
  }

  private getVersion(id: string): AutomationVersionRecord | undefined {
    const row = this.database.prepare("select * from automation_versions where id = ?").get(id);
    return row ? readVersion(row) : undefined;
  }

  private insertVersion(version: AutomationVersionRecord): void {
    this.database
      .prepare(
        "insert into automation_versions (id, automation_id, version, state, definition, created_by, created_at, published_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        version.id,
        version.automationId,
        version.version,
        version.state,
        JSON.stringify(version.definition),
        version.createdBy,
        version.createdAt,
        version.publishedAt ?? null,
      );
  }

  private async readSchedule(row: Record<string, unknown>): Promise<AutomationSchedule> {
    return {
      id: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      automationId: text(row, "automation_id"),
      automationVersionId: text(row, "automation_version_id"),
      state: text(row, "state") as AutomationSchedule["state"],
      nextRunAt: optional(row, "next_run_at"),
      timeZone: text(row, "time_zone"),
      scheduledFor: text(row, "scheduled_for"),
      repeat: Boolean(row.repeat),
      cadence: optional(row, "cadence") as AutomationSchedule["cadence"],
      endAt: optional(row, "end_at"),
      input: JSON.parse(await this.codec.decode(text(row, "encrypted_input"))),
      createdBy: text(row, "created_by"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      claimedAt: optional(row, "claimed_at"),
      blockedReason: optional(row, "blocked_reason"),
    };
  }
}

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}
function optional(row: Record<string, unknown>, key: string): string | undefined {
  return text(row, key) || undefined;
}
function readAutomation(row: Record<string, unknown>): AutomationRecord {
  return {
    id: text(row, "id"),
    workspaceId: text(row, "workspace_id"),
    lifecycle: text(row, "lifecycle") as AutomationRecord["lifecycle"],
    draftVersionId: optional(row, "draft_version_id"),
    liveVersionId: optional(row, "live_version_id"),
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}
function readVersion(row: Record<string, unknown>): AutomationVersionRecord {
  return {
    id: text(row, "id"),
    automationId: text(row, "automation_id"),
    version: Number(row.version),
    state: text(row, "state") as AutomationVersionRecord["state"],
    definition: JSON.parse(text(row, "definition")) as GmailDraftAutomationDefinition,
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    publishedAt: optional(row, "published_at"),
  };
}
function readApproval(row: Record<string, unknown>): AutomationApprovalGrant {
  return {
    automationVersionId: text(row, "automation_version_id"),
    actionId: text(row, "action_id"),
    connectionName: text(row, "connection_name"),
    approvedBy: text(row, "approved_by"),
    approvedAt: text(row, "approved_at"),
    actionPolicyUpdatedAt: text(row, "action_policy_updated_at"),
  };
}
function readRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: text(row, "id"),
    workspaceId: text(row, "workspace_id"),
    automationId: text(row, "automation_id"),
    automationVersionId: text(row, "automation_version_id"),
    scheduleId: text(row, "schedule_id"),
    occurrenceAt: text(row, "occurrence_at"),
    status: text(row, "status") as AutomationRun["status"],
    startedAt: text(row, "started_at"),
    completedAt: optional(row, "completed_at"),
    errorCode: optional(row, "error_code"),
    errorMessage: optional(row, "error_message"),
    draftId: optional(row, "draft_id"),
  };
}

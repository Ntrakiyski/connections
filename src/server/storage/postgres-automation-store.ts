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
import type { Pool, PoolClient } from "pg";

export class PostgresAutomationStore implements AutomationStore {
  private readonly pool: Pool;
  private readonly codec: ISecretCodec;

  constructor(pool: Pool, codec: ISecretCodec) {
    this.pool = pool;
    this.codec = codec;
  }

  async createDraft(automation: AutomationRecord, version: AutomationVersionRecord): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `insert into automations (id, workspace_id, lifecycle, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          automation.id,
          automation.workspaceId,
          automation.lifecycle,
          automation.createdBy,
          automation.createdAt,
          automation.updatedAt,
        ],
      );
      await this.insertVersion(version, client);
      await client.query("update automations set draft_version_id = $1 where id = $2", [version.id, automation.id]);
    });
  }

  async get(workspaceId: string, automationId: string): Promise<AutomationDetail | undefined> {
    const automation = await this.getAutomation(workspaceId, automationId);
    if (!automation) return undefined;
    return await this.detail(automation);
  }

  async list(workspaceId: string): Promise<AutomationDetail[]> {
    const result = await this.pool.query(
      "select * from automations where workspace_id = $1 order by updated_at desc, id desc",
      [workspaceId],
    );
    return await Promise.all(result.rows.map(async (row) => await this.detail(readAutomation(row))));
  }

  async replaceDraft(
    workspaceId: string,
    automationId: string,
    version: AutomationVersionRecord,
  ): Promise<AutomationDetail | undefined> {
    const automation = await this.transaction(async (client) => {
      const update = await client.query(
        "update automations set draft_version_id = $1, lifecycle = case when live_version_id is null then 'draft' else lifecycle end, updated_at = $2 where id = $3 and workspace_id = $4 returning *",
        [version.id, version.createdAt, automationId, workspaceId],
      );
      if (update.rows.length === 0) {
        return undefined;
      }
      await client.query(
        "update automation_versions set state = 'superseded' where automation_id = $1 and state = 'draft'",
        [automationId],
      );
      await this.insertVersion(version, client);
      return readAutomation(update.rows[0]!);
    });
    return automation ? await this.detail(automation) : undefined;
  }

  async publish(
    workspaceId: string,
    automationId: string,
    versionId: string,
    approval: AutomationApprovalGrant,
    publishedAt: string,
  ): Promise<AutomationDetail | undefined> {
    const automation = await this.transaction(async (client) => {
      const current = await client.query("select * from automations where id = $1 and workspace_id = $2 for update", [
        automationId,
        workspaceId,
      ]);
      if (current.rows.length === 0) {
        return undefined;
      }
      await client.query(
        "update automation_versions set state = 'superseded' where automation_id = $1 and state = 'live'",
        [automationId],
      );
      await client.query(
        "update automation_versions set state = 'live', published_at = $1 where id = $2 and automation_id = $3",
        [publishedAt, versionId, automationId],
      );
      await client.query(
        `insert into automation_approval_grants (automation_version_id, action_id, connection_name, approved_by, approved_at, action_policy_updated_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (automation_version_id) do update set action_id = excluded.action_id, connection_name = excluded.connection_name, approved_by = excluded.approved_by, approved_at = excluded.approved_at, action_policy_updated_at = excluded.action_policy_updated_at`,
        [
          approval.automationVersionId,
          approval.actionId,
          approval.connectionName,
          approval.approvedBy,
          approval.approvedAt,
          approval.actionPolicyUpdatedAt,
        ],
      );
      const update = await client.query(
        "update automations set live_version_id = $1, draft_version_id = null, lifecycle = 'live', updated_at = $2 where id = $3 returning *",
        [versionId, publishedAt, automationId],
      );
      return readAutomation(update.rows[0]!);
    });
    return automation ? await this.detail(automation) : undefined;
  }

  async disable(workspaceId: string, automationId: string, updatedAt: string): Promise<boolean> {
    return await this.transaction(async (client) => {
      const update = await client.query(
        "update automations set lifecycle = 'disabled', updated_at = $1 where id = $2 and workspace_id = $3",
        [updatedAt, automationId, workspaceId],
      );
      await client.query(
        "update automation_schedules set state = 'disabled', claimed_at = null, updated_at = $1 where automation_id = $2 and workspace_id = $3 and state in ('active', 'running')",
        [updatedAt, automationId, workspaceId],
      );
      return (update.rowCount ?? 0) > 0;
    });
  }

  async createSchedule(schedule: AutomationSchedule): Promise<void> {
    await this.saveSchedule(schedule);
  }

  async getSchedule(workspaceId: string, scheduleId: string): Promise<AutomationSchedule | undefined> {
    const result = await this.pool.query("select * from automation_schedules where workspace_id = $1 and id = $2", [
      workspaceId,
      scheduleId,
    ]);
    return result.rows[0] ? await this.readSchedule(result.rows[0]) : undefined;
  }

  async listSchedules(workspaceId: string, automationId: string): Promise<AutomationSchedule[]> {
    const result = await this.pool.query(
      "select * from automation_schedules where workspace_id = $1 and automation_id = $2 order by created_at desc",
      [workspaceId, automationId],
    );
    return await Promise.all(result.rows.map(async (row) => await this.readSchedule(row)));
  }

  async stopSchedule(workspaceId: string, scheduleId: string, updatedAt: string): Promise<boolean> {
    const result = await this.pool.query(
      "update automation_schedules set state = 'disabled', updated_at = $1 where workspace_id = $2 and id = $3 and state = 'active'",
      [updatedAt, workspaceId, scheduleId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimDueSchedules(now: string, limit: number): Promise<AutomationSchedule[]> {
    const staleClaimAt = new Date(Date.parse(now) - 5 * 60_000).toISOString();
    const result = await this.pool.query(
      `with due as (
         select id from automation_schedules where (state = 'active' and next_run_at <= $1) or (state = 'running' and claimed_at <= $3)
         order by next_run_at asc limit $2 for update skip locked
       )
       update automation_schedules schedules set state = 'running', claimed_at = $1, updated_at = $1
       from due where schedules.id = due.id returning schedules.*`,
      [now, limit, staleClaimAt],
    );
    return await Promise.all(result.rows.map(async (row) => await this.readSchedule(row)));
  }

  async saveSchedule(schedule: AutomationSchedule): Promise<void> {
    const input = await this.codec.encode(JSON.stringify(schedule.input));
    await this.pool.query(
      `insert into automation_schedules (id, workspace_id, automation_id, automation_version_id, state, next_run_at, time_zone, scheduled_for, repeat, cadence, end_at, encrypted_input, created_by, created_at, updated_at, claimed_at, blocked_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict (id) do update set state = excluded.state, next_run_at = excluded.next_run_at, end_at = excluded.end_at, encrypted_input = excluded.encrypted_input, updated_at = excluded.updated_at, claimed_at = excluded.claimed_at, blocked_reason = excluded.blocked_reason`,
      [
        schedule.id,
        schedule.workspaceId,
        schedule.automationId,
        schedule.automationVersionId,
        schedule.state,
        schedule.nextRunAt ?? null,
        schedule.timeZone,
        schedule.scheduledFor,
        schedule.repeat,
        schedule.cadence ?? null,
        schedule.endAt ?? null,
        input,
        schedule.createdBy,
        schedule.createdAt,
        schedule.updatedAt,
        schedule.claimedAt ?? null,
        schedule.blockedReason ?? null,
      ],
    );
  }

  async getApproval(versionId: string): Promise<AutomationApprovalGrant | undefined> {
    const result = await this.pool.query("select * from automation_approval_grants where automation_version_id = $1", [
      versionId,
    ]);
    return result.rows[0] ? readApproval(result.rows[0]) : undefined;
  }

  async createRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<boolean> {
    return await this.transaction(async (client) => {
      const result = await client.query(
        `insert into automation_runs (id, workspace_id, automation_id, automation_version_id, schedule_id, occurrence_at, status, started_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (schedule_id, occurrence_at) do nothing`,
        [
          run.id,
          run.workspaceId,
          run.automationId,
          run.automationVersionId,
          run.scheduleId,
          run.occurrenceAt,
          run.status,
          run.startedAt,
        ],
      );
      if (result.rowCount === 0) {
        return false;
      }
      for (const step of steps) await this.insertStepRun(step, client);
      return true;
    });
  }

  async completeRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "update automation_runs set status = $1, completed_at = $2, error_code = $3, error_message = $4, draft_id = $5 where id = $6",
        [
          run.status,
          run.completedAt ?? null,
          run.errorCode ?? null,
          run.errorMessage ?? null,
          run.draftId ?? null,
          run.id,
        ],
      );
      for (const step of steps) {
        await client.query(
          "update automation_step_runs set status = $1, completed_at = $2, error_code = $3, error_message = $4 where id = $5",
          [step.status, step.completedAt ?? null, step.errorCode ?? null, step.errorMessage ?? null, step.id],
        );
      }
    });
  }

  async listRuns(workspaceId: string, automationId: string): Promise<AutomationRun[]> {
    const result = await this.pool.query(
      "select * from automation_runs where workspace_id = $1 and automation_id = $2 order by started_at desc",
      [workspaceId, automationId],
    );
    return result.rows.map(readRun);
  }

  private async detail(automation: AutomationRecord): Promise<AutomationDetail> {
    const [draft, live, schedules, runs] = await Promise.all([
      automation.draftVersionId ? this.getVersion(automation.draftVersionId) : undefined,
      automation.liveVersionId ? this.getVersion(automation.liveVersionId) : undefined,
      this.listSchedules(automation.workspaceId, automation.id),
      this.listRuns(automation.workspaceId, automation.id),
    ]);
    return { automation, draft: await draft, live: await live, schedules, runs };
  }

  private async getAutomation(workspaceId: string, id: string): Promise<AutomationRecord | undefined> {
    const result = await this.pool.query("select * from automations where workspace_id = $1 and id = $2", [
      workspaceId,
      id,
    ]);
    return result.rows[0] ? readAutomation(result.rows[0]) : undefined;
  }

  private async getVersion(id: string): Promise<AutomationVersionRecord | undefined> {
    const result = await this.pool.query("select * from automation_versions where id = $1", [id]);
    return result.rows[0] ? readVersion(result.rows[0]) : undefined;
  }

  private async insertVersion(version: AutomationVersionRecord, client: Pool | PoolClient = this.pool): Promise<void> {
    await client.query(
      "insert into automation_versions (id, automation_id, version, state, definition, created_by, created_at, published_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
      [
        version.id,
        version.automationId,
        version.version,
        version.state,
        JSON.stringify(version.definition),
        version.createdBy,
        version.createdAt,
        version.publishedAt ?? null,
      ],
    );
  }

  private async insertStepRun(step: AutomationStepRun, client: Pool | PoolClient = this.pool): Promise<void> {
    await client.query(
      "insert into automation_step_runs (id, automation_run_id, step_id, step_order, status, started_at, completed_at, error_code, error_message) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        step.id,
        step.automationRunId,
        step.stepId,
        step.order,
        step.status,
        step.startedAt,
        step.completedAt ?? null,
        step.errorCode ?? null,
        step.errorMessage ?? null,
      ],
    );
  }

  private async readSchedule(row: Record<string, unknown>): Promise<AutomationSchedule> {
    return {
      id: text(row.id),
      workspaceId: text(row.workspace_id),
      automationId: text(row.automation_id),
      automationVersionId: text(row.automation_version_id),
      state: text(row.state) as AutomationSchedule["state"],
      nextRunAt: optionalText(row.next_run_at),
      timeZone: text(row.time_zone),
      scheduledFor: text(row.scheduled_for),
      repeat: Boolean(row.repeat),
      cadence: optionalText(row.cadence) as AutomationSchedule["cadence"],
      endAt: optionalText(row.end_at),
      input: JSON.parse(await this.codec.decode(text(row.encrypted_input))),
      createdBy: text(row.created_by),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      claimedAt: optionalText(row.claimed_at),
      blockedReason: optionalText(row.blocked_reason),
    };
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}
function readAutomation(row: Record<string, unknown>): AutomationRecord {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    lifecycle: text(row.lifecycle) as AutomationRecord["lifecycle"],
    draftVersionId: optionalText(row.draft_version_id),
    liveVersionId: optionalText(row.live_version_id),
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}
function readVersion(row: Record<string, unknown>): AutomationVersionRecord {
  return {
    id: text(row.id),
    automationId: text(row.automation_id),
    version: Number(row.version),
    state: text(row.state) as AutomationVersionRecord["state"],
    definition: (typeof row.definition === "string"
      ? JSON.parse(row.definition)
      : row.definition) as GmailDraftAutomationDefinition,
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    publishedAt: optionalText(row.published_at),
  };
}
function readApproval(row: Record<string, unknown>): AutomationApprovalGrant {
  return {
    automationVersionId: text(row.automation_version_id),
    actionId: text(row.action_id),
    connectionName: text(row.connection_name),
    approvedBy: text(row.approved_by),
    approvedAt: text(row.approved_at),
    actionPolicyUpdatedAt: text(row.action_policy_updated_at),
  };
}
function readRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    automationId: text(row.automation_id),
    automationVersionId: text(row.automation_version_id),
    scheduleId: text(row.schedule_id),
    occurrenceAt: text(row.occurrence_at),
    status: text(row.status) as AutomationRun["status"],
    startedAt: text(row.started_at),
    completedAt: optionalText(row.completed_at),
    errorCode: optionalText(row.error_code),
    errorMessage: optionalText(row.error_message),
    draftId: optionalText(row.draft_id),
  };
}

export type AutomationLifecycle = "draft" | "live" | "disabled";
export type AutomationVersionState = "draft" | "live" | "superseded";
export type AutomationScheduleState = "active" | "running" | "disabled" | "blocked" | "completed";
export type AutomationRunStatus = "scheduled" | "running" | "success" | "failed" | "skipped";
export type AutomationCadence = "daily" | "weekly";

export interface GmailDraftAutomationDefinition {
  name: string;
  description: string;
  slug: string;
  connectionName: string;
  actionId: "gmail.create_email_draft";
  steps: readonly [
    { id: "compose"; name: "Compose email"; kind: "input" },
    { id: "schedule"; name: "Schedule draft"; kind: "schedule" },
    { id: "create-draft"; name: "Create Gmail draft"; kind: "action" },
  ];
}

export interface AutomationRecord {
  id: string;
  workspaceId: string;
  lifecycle: AutomationLifecycle;
  draftVersionId?: string;
  liveVersionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationVersionRecord {
  id: string;
  automationId: string;
  version: number;
  state: AutomationVersionState;
  definition: GmailDraftAutomationDefinition;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
}

export interface AutomationApprovalGrant {
  automationVersionId: string;
  actionId: string;
  connectionName: string;
  approvedBy: string;
  approvedAt: string;
  actionPolicyUpdatedAt: string;
}

export interface AutomationScheduleInput {
  to: string;
  subject: string;
  body: string;
  scheduledFor: string;
  timeZone: string;
  repeat: boolean;
  cadence?: AutomationCadence;
  endAt?: string;
}

export interface AutomationTestInput {
  to: string;
  subject: string;
  body: string;
}

export interface AutomationConfiguration {
  workspaceId: string;
  automationId: string;
  input: AutomationScheduleInput;
  updatedBy: string;
  updatedAt: string;
}

export interface AutomationSchedule {
  id: string;
  workspaceId: string;
  automationId: string;
  automationVersionId: string;
  state: AutomationScheduleState;
  nextRunAt?: string;
  timeZone: string;
  scheduledFor: string;
  repeat: boolean;
  cadence?: AutomationCadence;
  endAt?: string;
  input: AutomationScheduleInput;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  blockedReason?: string;
}

export interface AutomationRun {
  id: string;
  workspaceId: string;
  automationId: string;
  automationVersionId: string;
  scheduleId: string;
  occurrenceAt: string;
  status: AutomationRunStatus;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  draftId?: string;
}

export interface AutomationStepRun {
  id: string;
  automationRunId: string;
  stepId: string;
  order: number;
  status: AutomationRunStatus;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AutomationDetail {
  automation: AutomationRecord;
  draft?: AutomationVersionRecord;
  live?: AutomationVersionRecord;
  configuration?: AutomationConfiguration;
  schedules: AutomationSchedule[];
  runs: AutomationRun[];
}

export interface AutomationStore {
  createDraft(automation: AutomationRecord, version: AutomationVersionRecord): Promise<void>;
  get(workspaceId: string, automationId: string): Promise<AutomationDetail | undefined>;
  list(workspaceId: string): Promise<AutomationDetail[]>;
  replaceDraft(
    workspaceId: string,
    automationId: string,
    version: AutomationVersionRecord,
  ): Promise<AutomationDetail | undefined>;
  publish(
    workspaceId: string,
    automationId: string,
    versionId: string,
    approval: AutomationApprovalGrant,
    publishedAt: string,
  ): Promise<AutomationDetail | undefined>;
  disable(workspaceId: string, automationId: string, updatedAt: string): Promise<boolean>;
  saveConfiguration(configuration: AutomationConfiguration): Promise<void>;
  createSchedule(schedule: AutomationSchedule): Promise<void>;
  getSchedule(workspaceId: string, scheduleId: string): Promise<AutomationSchedule | undefined>;
  listSchedules(workspaceId: string, automationId: string): Promise<AutomationSchedule[]>;
  stopSchedule(workspaceId: string, scheduleId: string, updatedAt: string): Promise<boolean>;
  claimDueSchedules(now: string, limit: number): Promise<AutomationSchedule[]>;
  saveSchedule(schedule: AutomationSchedule): Promise<void>;
  getApproval(versionId: string): Promise<AutomationApprovalGrant | undefined>;
  createRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<boolean>;
  completeRun(run: AutomationRun, steps: AutomationStepRun[]): Promise<void>;
  listRuns(workspaceId: string, automationId: string): Promise<AutomationRun[]>;
}

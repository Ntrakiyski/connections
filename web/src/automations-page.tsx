import type { FormEvent, ReactNode } from "react";

import { AlertCircle, CalendarClock, CheckCircle2, ListChecks, Play, Power, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { apiGet, apiPost } from "./api";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Lifecycle = "draft" | "live" | "disabled";
type ScheduleState = "active" | "disabled" | "blocked" | "completed";
type Cadence = "daily" | "weekly";

interface AutomationDefinition {
  name: string;
  description: string;
  slug: string;
  connectionName: string;
  actionId: "gmail.create_email_draft";
  steps: readonly { id: string; name: string; kind: "input" | "schedule" | "action" }[];
}

interface AutomationSchedule {
  id: string;
  state: ScheduleState;
  nextRunAt?: string;
  timeZone: string;
  repeat: boolean;
  cadence?: Cadence;
  endAt?: string;
  createdAt: string;
  blockedReason?: string;
}

interface AutomationRun {
  id: string;
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  draftId?: string;
}

interface AutomationTestResult {
  ok: true;
  draftId?: string;
}

interface AutomationDetail {
  automation: {
    id: string;
    lifecycle: Lifecycle;
    createdBy: string;
    updatedAt: string;
  };
  draft?: { version: number; definition: AutomationDefinition };
  live?: { version: number; definition: AutomationDefinition };
  schedules: AutomationSchedule[];
  runs: AutomationRun[];
}

interface ScheduleForm {
  to: string;
  subject: string;
  body: string;
  scheduledFor: string;
  timeZone: string;
  repeat: boolean;
  cadence: Cadence;
  endAt: string;
}

export function AutomationsPage(props: { canManage: boolean }): ReactNode {
  const { automationId } = useParams();
  return automationId ? (
    <AutomationDetailPage automationId={automationId} canManage={props.canManage} />
  ) : (
    <AutomationLibrary />
  );
}

function AutomationLibrary(): ReactNode {
  const [automations, setAutomations] = useState<AutomationDetail[]>([]);
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState<"all" | Lifecycle>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      setAutomations(await apiGet<AutomationDetail[]>("/api/automations"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load automations.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const visible = useMemo(
    () =>
      automations.filter((detail) => {
        const definition = detail.draft?.definition ?? detail.live?.definition;
        return (
          definition &&
          (lifecycle === "all" || detail.automation.lifecycle === lifecycle) &&
          `${definition.name} ${definition.description} ${definition.connectionName}`
            .toLowerCase()
            .includes(query.toLowerCase())
        );
      }),
    [automations, lifecycle, query],
  );

  return (
    <div className="page-stack automations-page">
      <section className="page-heading flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2>Automations</h2>
          <p>Managed workspace products created through MCP and connected actions.</p>
        </div>
        <Button asChild variant="outline">
          <a href="/resources">Create with MCP</a>
        </Button>
      </section>

      <section className="page-toolbar flex flex-wrap gap-3" aria-label="Automation filters">
        <Input
          className="max-w-sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search automations"
        />
        <Select value={lifecycle} onValueChange={(value) => setLifecycle(value as "all" | Lifecycle)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Lifecycle: All</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" onClick={() => void reload()} aria-label="Refresh automations">
          <RefreshCw className={loading ? "spin" : ""} size={16} />
        </Button>
      </section>

      {error ? <InlineError message={error} /> : null}
      {visible.length === 0 && !loading ? (
        <EmptyState
          icon={<ListChecks size={20} />}
          title="No automations yet"
          description="Ask your connected MCP agent to build a Gmail draft automation from an authenticated Gmail action."
        />
      ) : (
        <section className="rounded-xl border bg-card" aria-label="Automation library">
          <div className="grid grid-cols-[minmax(16rem,2fr)_auto_auto_minmax(10rem,1fr)_auto] gap-4 border-b px-5 py-3 text-sm text-muted-foreground">
            <span>Automation</span>
            <span>Lifecycle</span>
            <span>Connection</span>
            <span>Next scheduled run</span>
            <span>Runs</span>
          </div>
          {visible.map((detail) => (
            <AutomationRow key={detail.automation.id} detail={detail} />
          ))}
        </section>
      )}
    </div>
  );
}

function AutomationRow(props: { detail: AutomationDetail }): ReactNode {
  const definition = props.detail.draft?.definition ?? props.detail.live?.definition;
  if (!definition) return null;
  const next = props.detail.schedules.find((schedule) => schedule.state === "active" && schedule.nextRunAt)?.nextRunAt;
  return (
    <Link
      className="grid grid-cols-[minmax(16rem,2fr)_auto_auto_minmax(10rem,1fr)_auto] items-center gap-4 border-b px-5 py-4 last:border-0 hover:bg-muted/40"
      to={`/automations/${props.detail.automation.id}`}
    >
      <span>
        <strong className="block">{definition.name}</strong>
        <small>{definition.description}</small>
      </span>
      <LifecycleBadge lifecycle={props.detail.automation.lifecycle} />
      <span className="text-sm">{definition.connectionName}</span>
      <span className="text-sm">{next ? displayDate(next) : "—"}</span>
      <span className="font-medium">{props.detail.runs.length}</span>
    </Link>
  );
}

function AutomationDetailPage(props: { automationId: string; canManage: boolean }): ReactNode {
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [view, setView] = useState<"client" | "technical">("client");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ScheduleForm>(() => defaultScheduleForm());

  const reload = async (): Promise<void> => {
    try {
      setDetail(await apiGet<AutomationDetail>(`/api/automations/${props.automationId}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load this automation.");
    }
  };
  useEffect(() => {
    void reload();
  }, [props.automationId]);

  const definition = detail?.live?.definition ?? detail?.draft?.definition;
  const runTest = async (): Promise<void> => {
    if (!form.to || !form.subject || !form.body) {
      setError("Enter a recipient, subject, and body before testing.");
      return;
    }
    if (!window.confirm("Create a real Gmail draft now? This test ignores the schedule and never sends email.")) return;
    setBusy(true);
    try {
      const result = await apiPost<AutomationTestResult>(`/api/automations/${props.automationId}/test`, {
        to: form.to,
        subject: form.subject,
        body: form.body,
        confirmed: true,
      });
      setNotice(`Test passed. Gmail draft${result.draftId ? ` ${result.draftId}` : ""} was created.`);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Test did not create a Gmail draft.");
    } finally {
      setBusy(false);
    }
  };
  const publish = async (): Promise<void> => {
    if (!window.confirm("Publish this version and approve Gmail draft creation for future schedules?")) return;
    setBusy(true);
    try {
      await apiPost(`/api/automations/${props.automationId}/publish`, { confirmed: true });
      setNotice("Live version published. New schedules can now create Gmail drafts.");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish the automation.");
    } finally {
      setBusy(false);
    }
  };
  const disable = async (): Promise<void> => {
    if (!window.confirm("Disable this automation and stop its future schedules?")) return;
    setBusy(true);
    try {
      await apiPost(`/api/automations/${props.automationId}/disable`, {});
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not disable the automation.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <InlineError message={error} />;
  if (!detail || !definition) return <div className="loading-panel">Loading automation…</div>;

  return (
    <div className="page-stack automations-page">
      <section className="page-heading flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm text-muted-foreground hover:text-foreground" to="/automations">
            Automations
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2>{definition.name}</h2>
            <LifecycleBadge lifecycle={detail.automation.lifecycle} />
          </div>
          <p>{definition.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {props.canManage && detail.draft ? (
            <Button variant="outline" onClick={() => void runTest()} disabled={busy}>
              <Play size={15} /> Test
            </Button>
          ) : null}
          {props.canManage && detail.draft ? (
            <Button onClick={() => void publish()} disabled={busy}>
              Publish draft
            </Button>
          ) : null}
          {props.canManage && detail.automation.lifecycle !== "disabled" ? (
            <Button variant="outline" onClick={() => void disable()} disabled={busy}>
              <Power size={15} /> Disable
            </Button>
          ) : null}
        </div>
      </section>
      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}

      <div className="flex gap-2 rounded-lg border bg-muted/30 p-1 w-fit">
        <Button variant={view === "client" ? "default" : "ghost"} size="sm" onClick={() => setView("client")}>
          Client view
        </Button>
        <Button variant={view === "technical" ? "default" : "ghost"} size="sm" onClick={() => setView("technical")}>
          Technical view
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)_20rem]">
        <StepList definition={definition} />
        {view === "client" ? (
          <ScheduleFormView
            automationId={props.automationId}
            connectionName={definition.connectionName}
            live={Boolean(detail.live)}
            form={form}
            onChange={setForm}
            onScheduled={async (message) => {
              setNotice(message);
              await reload();
            }}
          />
        ) : (
          <TechnicalView definition={definition} />
        )}
        <AutomationContext detail={detail} definition={definition} />
      </div>
    </div>
  );
}

function StepList(props: { definition: AutomationDefinition }): ReactNode {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-semibold">Steps</h3>
      <ol className="space-y-3">
        {props.definition.steps.map((step, index) => (
          <li key={step.id} className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-sm">
              {index + 1}
            </span>
            <span>
              <strong className="block text-sm">{step.name}</strong>
              <small>
                {step.kind === "input"
                  ? "Input → Logic → Output"
                  : step.kind === "schedule"
                    ? "Time and recurrence"
                    : "Gmail connected action"}
              </small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TechnicalView(props: { definition: AutomationDefinition }): ReactNode {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div>
        <h3 className="font-semibold">Read-only technical inspection</h3>
        <p className="text-sm text-muted-foreground">
          This automation is created and changed through MCP. The console shows its declared contract.
        </p>
      </div>
      <TechnicalCard
        title="1. Compose email"
        rows={[
          ["Sender Gmail account", props.definition.connectionName],
          ["Input", "to, subject, body"],
          ["Output", "prepared Gmail draft payload"],
        ]}
      />
      <TechnicalCard
        title="2. Schedule draft"
        rows={[
          ["Input", "date, time, IANA time zone"],
          ["Logic", "Run once, or daily / weekly until the optional end date"],
          ["Output", "a scheduled occurrence"],
        ]}
      />
      <TechnicalCard
        title="3. Create Gmail draft"
        rows={[
          ["Allowed action", "gmail.create_email_draft"],
          ["Bound connection", props.definition.connectionName],
          ["Output", "draftId, messageId, threadId"],
        ]}
      />
    </section>
  );
}

function TechnicalCard(props: { title: string; rows: readonly (readonly [string, string])[] }): ReactNode {
  return (
    <article className="rounded-lg border p-4">
      <h4 className="mb-3 font-medium">{props.title}</h4>
      <dl className="space-y-2 text-sm">
        {props.rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[9rem_1fr] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function ScheduleFormView(props: {
  automationId: string;
  connectionName: string;
  live: boolean;
  form: ScheduleForm;
  onChange(form: ScheduleForm): void;
  onScheduled(message: string): Promise<void>;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!props.live) {
      setError("This automation must be published before it can schedule Gmail drafts.");
      return;
    }
    setBusy(true);
    try {
      const schedule = await apiPost<AutomationSchedule>(`/api/automations/${props.automationId}/schedules`, {
        ...props.form,
        cadence: props.form.repeat ? props.form.cadence : undefined,
        endAt:
          props.form.repeat && props.form.endAt ? new Date(`${props.form.endAt}T23:59:59`).toISOString() : undefined,
      });
      await props.onScheduled(
        `Schedule created. Next draft: ${schedule.nextRunAt ? displayDate(schedule.nextRunAt) : "not available"}.`,
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the schedule.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-5">
        <h3 className="font-semibold">Schedule Gmail draft</h3>
        <p className="text-sm text-muted-foreground">Prepare a draft only; this automation never sends email.</p>
      </div>
      {error ? <InlineError message={error} /> : null}
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Sender account</span>
          <strong className="ml-2">{props.connectionName}</strong>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Recipient">
            <Input
              required
              type="email"
              value={props.form.to}
              onChange={(event) => props.onChange({ ...props.form, to: event.target.value })}
            />
          </Field>
          <Field label="Subject">
            <Input
              required
              value={props.form.subject}
              onChange={(event) => props.onChange({ ...props.form, subject: event.target.value })}
            />
          </Field>
        </div>
        <Field label="Body">
          <Textarea
            required
            rows={7}
            value={props.form.body}
            onChange={(event) => props.onChange({ ...props.form, body: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date and time">
            <Input
              required
              type="datetime-local"
              value={props.form.scheduledFor}
              onChange={(event) => props.onChange({ ...props.form, scheduledFor: event.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <Input
              required
              value={props.form.timeZone}
              onChange={(event) => props.onChange({ ...props.form, timeZone: event.target.value })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={props.form.repeat}
            onChange={(event) => props.onChange({ ...props.form, repeat: event.target.checked })}
          />{" "}
          Repeat this schedule
        </label>
        {props.form.repeat ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cadence">
              <Select
                value={props.form.cadence}
                onValueChange={(value) => props.onChange({ ...props.form, cadence: value as Cadence })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="End date (optional)">
              <Input
                type="date"
                value={props.form.endAt}
                onChange={(event) => props.onChange({ ...props.form, endAt: event.target.value })}
              />
            </Field>
          </div>
        ) : null}
        <Button type="submit" disabled={busy || !props.live}>
          <CalendarClock size={16} /> {busy ? "Scheduling…" : "Schedule Gmail draft"}
        </Button>
      </form>
    </section>
  );
}

function Field(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="space-y-2">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}

function AutomationContext(props: { detail: AutomationDetail; definition: AutomationDefinition }): ReactNode {
  const active = props.detail.schedules.filter((schedule) => schedule.state === "active");
  return (
    <aside className="space-y-4">
      <section className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-semibold">Context</h3>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Connected account</dt>
            <dd>{props.definition.connectionName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Action</dt>
            <dd>gmail.create_email_draft</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lifecycle</dt>
            <dd>
              <LifecycleBadge lifecycle={props.detail.automation.lifecycle} />
            </dd>
          </div>
        </dl>
      </section>
      <section className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-semibold">Schedules</h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active schedules.</p>
        ) : (
          <ul className="space-y-3">
            {active.slice(0, 4).map((schedule) => (
              <li key={schedule.id} className="text-sm">
                <strong className="block">{schedule.repeat ? `${schedule.cadence} schedule` : "One-time draft"}</strong>
                <span className="text-muted-foreground">
                  {schedule.nextRunAt ? displayDate(schedule.nextRunAt) : "No next run"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-semibold">Recent runs</h3>
        {props.detail.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No drafts created yet.</p>
        ) : (
          <ul className="space-y-3">
            {props.detail.runs.slice(0, 5).map((run) => (
              <li key={run.id} className="flex items-start gap-2 text-sm">
                {run.status === "success" ? (
                  <CheckCircle2 className="mt-0.5 text-emerald-600" size={15} />
                ) : (
                  <AlertCircle className="mt-0.5 text-destructive" size={15} />
                )}
                <span>
                  <strong className="block capitalize">{run.status}</strong>
                  <small>
                    {displayDate(run.startedAt)}
                    {run.draftId ? " · Gmail draft created" : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function LifecycleBadge(props: { lifecycle: Lifecycle }): ReactNode {
  return (
    <Badge tone={props.lifecycle === "live" ? "success" : props.lifecycle === "disabled" ? "error" : "warning"}>
      {props.lifecycle === "live" ? "Live" : props.lifecycle === "draft" ? "Draft" : "Disabled"}
    </Badge>
  );
}
function displayDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function defaultScheduleForm(): ScheduleForm {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  return {
    to: "",
    subject: "",
    body: "",
    scheduledFor: dateTimeLocal(next),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    repeat: false,
    cadence: "daily",
    endAt: "",
  };
}
function dateTimeLocal(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

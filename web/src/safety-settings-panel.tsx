import type { ResolvedProviderSafetyConfig, SafetyMode, WorkspaceSafetyConfigPatch } from "./model";
import type { FormEvent, ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { apiPut } from "./api";
import { FormStatus } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SafetyField = "scopePreflight" | "idempotency" | "retry" | "rateLimit";
type ProviderMode = SafetyMode | "inherit";

interface SafetySettingsPanelProps {
  title: string;
  description: string;
  endpoint: string;
  config?: ResolvedProviderSafetyConfig;
  canManage: boolean;
  providerOverride?: boolean;
  onRefresh(): void;
  onSaved?(config: ResolvedProviderSafetyConfig): void;
}

interface SafetyFormState {
  scopePreflight: ProviderMode;
  idempotency: ProviderMode;
  retry: ProviderMode;
  rateLimit: ProviderMode;
  maxAttempts: string;
  baseDelayMs: string;
  maxDelayMs: string;
  maxConcurrent: string;
}

export function SafetySettingsPanel(props: SafetySettingsPanelProps): ReactNode {
  const t = useTranslate();
  const [form, setForm] = useState(() => formStateFor(props.config, props.providerOverride ?? false));
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setForm(formStateFor(props.config, props.providerOverride ?? false));
    setStatus(null);
  }, [props.config, props.providerOverride]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus(t("safety.saving"));
    try {
      const config = await apiPut<ResolvedProviderSafetyConfig>(
        props.endpoint,
        payloadFor(form, props.providerOverride ?? false),
      );
      setStatus(t("safety.saved"));
      props.onSaved?.(config);
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("safety.saveFailed"));
    }
  }

  return (
    <section className="detail-panel safety-settings-panel">
      <div className="provider-panel-title-row">
        <div className="detail-heading compact">
          <div className="action-mark">
            <ShieldCheck size={19} />
          </div>
          <div>
            <h3>{props.title}</h3>
            <p>{props.description}</p>
          </div>
        </div>
      </div>

      <form className="safety-settings-grid" onSubmit={(event) => void submit(event)}>
        <SafetyModeSelect
          label={t("safety.scopePreflight")}
          value={form.scopePreflight}
          providerOverride={props.providerOverride ?? false}
          disabled={!props.canManage}
          onChange={(value) => setForm((current) => ({ ...current, scopePreflight: value }))}
        />
        <SafetyModeSelect
          label={t("safety.idempotency")}
          value={form.idempotency}
          providerOverride={props.providerOverride ?? false}
          disabled={!props.canManage}
          onChange={(value) => setForm((current) => ({ ...current, idempotency: value }))}
        />
        <SafetyModeSelect
          label={t("safety.retry")}
          value={form.retry}
          providerOverride={props.providerOverride ?? false}
          disabled={!props.canManage}
          onChange={(value) => setForm((current) => ({ ...current, retry: value }))}
        />
        <SafetyModeSelect
          label={t("safety.rateLimit")}
          value={form.rateLimit}
          providerOverride={props.providerOverride ?? false}
          disabled={!props.canManage}
          onChange={(value) => setForm((current) => ({ ...current, rateLimit: value }))}
        />

        <Label className="field">
          <span>{t("safety.maxAttempts")}</span>
          <Input
            type="number"
            min={1}
            max={10}
            value={form.maxAttempts}
            disabled={!props.canManage}
            onChange={(event) => setForm((current) => ({ ...current, maxAttempts: event.target.value }))}
          />
        </Label>
        <Label className="field">
          <span>{t("safety.baseDelayMs")}</span>
          <Input
            type="number"
            min={1}
            value={form.baseDelayMs}
            disabled={!props.canManage}
            onChange={(event) => setForm((current) => ({ ...current, baseDelayMs: event.target.value }))}
          />
        </Label>
        <Label className="field">
          <span>{t("safety.maxDelayMs")}</span>
          <Input
            type="number"
            min={1}
            value={form.maxDelayMs}
            disabled={!props.canManage}
            onChange={(event) => setForm((current) => ({ ...current, maxDelayMs: event.target.value }))}
          />
        </Label>
        <Label className="field">
          <span>{t("safety.maxConcurrent")}</span>
          <Input
            type="number"
            min={1}
            max={100}
            value={form.maxConcurrent}
            disabled={!props.canManage}
            onChange={(event) => setForm((current) => ({ ...current, maxConcurrent: event.target.value }))}
          />
        </Label>

        {status ? <FormStatus message={status} /> : null}
        <div className="button-row safety-settings-actions">
          <Button type="submit" disabled={!props.canManage}>
            {t("safety.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function SafetyModeSelect(props: {
  label: string;
  value: ProviderMode;
  providerOverride: boolean;
  disabled: boolean;
  onChange(value: ProviderMode): void;
}): ReactNode {
  const t = useTranslate();
  return (
    <Label className="field">
      <span>{props.label}</span>
      <Select
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange(value as ProviderMode)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.providerOverride ? <SelectItem value="inherit">{t("safety.inherit")}</SelectItem> : null}
          <SelectItem value="observe">{t("safety.observe")}</SelectItem>
          <SelectItem value="enforce">{t("safety.enforce")}</SelectItem>
        </SelectContent>
      </Select>
    </Label>
  );
}

function formStateFor(config: ResolvedProviderSafetyConfig | undefined, providerOverride: boolean): SafetyFormState {
  const resolved = config?.resolved;
  const provider = config?.provider;
  return {
    scopePreflight: modeFor(provider?.scopePreflight?.mode, resolved?.scopePreflight.mode, providerOverride),
    idempotency: modeFor(provider?.idempotency?.mode, resolved?.idempotency.mode, providerOverride),
    retry: modeFor(provider?.retry?.mode, resolved?.retry.mode, providerOverride),
    rateLimit: modeFor(provider?.rateLimit?.mode, resolved?.rateLimit.mode, providerOverride),
    maxAttempts: String(provider?.retry?.maxAttempts ?? resolved?.retry.maxAttempts ?? 3),
    baseDelayMs: String(provider?.retry?.baseDelayMs ?? resolved?.retry.baseDelayMs ?? 250),
    maxDelayMs: String(provider?.retry?.maxDelayMs ?? resolved?.retry.maxDelayMs ?? 2000),
    maxConcurrent: String(provider?.rateLimit?.maxConcurrent ?? resolved?.rateLimit.maxConcurrent ?? 4),
  };
}

function modeFor(
  providerMode: SafetyMode | undefined,
  resolvedMode: SafetyMode | undefined,
  providerOverride: boolean,
): ProviderMode {
  if (providerOverride && !providerMode) {
    return "inherit";
  }
  return providerMode ?? resolvedMode ?? "observe";
}

function payloadFor(form: SafetyFormState, providerOverride: boolean): WorkspaceSafetyConfigPatch {
  const payload: WorkspaceSafetyConfigPatch = {};
  setFeature(payload, "scopePreflight", form.scopePreflight, providerOverride);
  setFeature(payload, "idempotency", form.idempotency, providerOverride);
  setRateLimit(payload, form, providerOverride);
  if (providerOverride && form.retry === "inherit") {
    return payload;
  }
  const retry: WorkspaceSafetyConfigPatch["retry"] = {};
  retry.mode = form.retry === "inherit" ? "observe" : form.retry;
  const maxAttempts = positiveInteger(form.maxAttempts);
  const baseDelayMs = positiveInteger(form.baseDelayMs);
  const maxDelayMs = positiveInteger(form.maxDelayMs);
  if (maxAttempts !== undefined) retry.maxAttempts = maxAttempts;
  if (baseDelayMs !== undefined) retry.baseDelayMs = baseDelayMs;
  if (maxDelayMs !== undefined) retry.maxDelayMs = maxDelayMs;
  if (Object.keys(retry).length > 0) payload.retry = retry;
  return payload;
}

function setRateLimit(payload: WorkspaceSafetyConfigPatch, form: SafetyFormState, providerOverride: boolean): void {
  if (providerOverride && form.rateLimit === "inherit") {
    return;
  }
  const maxConcurrent = positiveInteger(form.maxConcurrent);
  payload.rateLimit = {
    mode: form.rateLimit === "inherit" ? "observe" : form.rateLimit,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  };
}

function setFeature(
  payload: WorkspaceSafetyConfigPatch,
  field: Exclude<SafetyField, "retry">,
  value: ProviderMode,
  providerOverride: boolean,
): void {
  if (providerOverride && value === "inherit") {
    return;
  }
  payload[field] = { mode: value === "inherit" ? "observe" : value };
}

function positiveInteger(value: string): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

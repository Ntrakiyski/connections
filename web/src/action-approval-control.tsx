import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPut } from "./api";
import { InlineError } from "./shared-ui";
import { Toggle } from "@/components/ui/toggle";

interface WorkspaceActionPolicy {
  requireApproval: boolean;
}

interface ActionApprovalControlProps {
  actionId: string;
  canManage: boolean;
}

/** Workspace policy switch shared by action detail and provider action lists. */
export function ActionApprovalControl(props: ActionApprovalControlProps): ReactNode {
  const t = useTranslate();
  const [requireApproval, setRequireApproval] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.canManage) return;
    let disposed = false;
    setRequireApproval(true);
    setError(null);
    void apiGet<WorkspaceActionPolicy>(`/api/workspace/action-policies/${encodeURIComponent(props.actionId)}`)
      .then((policy) => {
        if (!disposed) setRequireApproval(policy.requireApproval);
      })
      .catch(() => {
        if (!disposed) setError(t("actions.approvalLoadFailed"));
      });
    return () => {
      disposed = true;
    };
  }, [props.actionId, props.canManage, t]);

  async function update(nextRequireApproval: boolean): Promise<void> {
    const previous = requireApproval;
    setRequireApproval(nextRequireApproval);
    setSaving(true);
    setError(null);
    try {
      const policy = await apiPut<WorkspaceActionPolicy>(
        `/api/workspace/action-policies/${encodeURIComponent(props.actionId)}`,
        { requireApproval: nextRequireApproval },
      );
      setRequireApproval(policy.requireApproval);
    } catch {
      setRequireApproval(previous);
      setError(t("actions.approvalUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!props.canManage) return null;

  return (
    <div className="action-approval-control">
      <Toggle
        variant="outline"
        size="sm"
        pressed={requireApproval}
        disabled={saving}
        aria-label={`${t("actions.requireApproval")}: ${
          requireApproval ? t("actions.approvalOn") : t("actions.approvalOff")
        }`}
        onPressedChange={(pressed) => void update(pressed)}
      >
        {saving ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
        {t("actions.requireApproval")}: {requireApproval ? t("actions.approvalOn") : t("actions.approvalOff")}
      </Toggle>
      {error ? <InlineError message={error} /> : null}
    </div>
  );
}

import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet, apiPut } from "./api";
import { InlineError } from "./shared-ui";
import { useWorkspaceRequests } from "./workspace-context";
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
  const requests = useWorkspaceRequests();
  const t = useTranslate();
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.canManage) return;
    let disposed = false;
    setRequireApproval(null);
    setError(null);
    void apiGet<WorkspaceActionPolicy>(`/api/workspace/action-policies/${encodeURIComponent(props.actionId)}`, requests)
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
        requests,
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

  const loading = requireApproval === null && error === null;
  const label =
    requireApproval === null
      ? t("actions.requireApproval")
      : `${t("actions.requireApproval")}: ${requireApproval ? t("actions.approvalOn") : t("actions.approvalOff")}`;

  return (
    <div className="action-approval-control">
      <Toggle
        variant="outline"
        size="sm"
        pressed={requireApproval ?? false}
        disabled={saving || requireApproval === null}
        onPressedChange={(pressed) => void update(pressed)}
      >
        {loading || saving ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
        {label}
      </Toggle>
      {error ? <InlineError message={error} /> : null}
    </div>
  );
}

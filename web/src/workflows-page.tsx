import type { WorkspaceScope } from "./workspace-scope";
import type { WorkbenchLocation, WorkbenchNotification, WorkbenchView } from "@oomol-lab/open-flow/workbench";
import type { ReactNode } from "react";

import { useLang, useTranslate } from "@embra/i18n/react";
import { OpenFlowWorkbench, resolveWorkbenchLanguage } from "@oomol-lab/open-flow/workbench";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useThemeMode } from "./theme";
import { createWorkflowWorkbenchHost, workflowGatewayPath, workflowProviderHref } from "./workflow-workbench-host";
import { useWorkspaceScope } from "./workspace-context";
import { workspaceHref } from "./workspace-scope";
import { Button } from "@/components/ui/button";
import "@oomol-lab/open-flow/workbench.css";

export default function WorkflowsPage(): ReactNode {
  const scope = useWorkspaceScope();
  return scope ? <WorkspaceWorkbench scope={scope} key={JSON.stringify(scope.intent)} /> : null;
}

function WorkspaceWorkbench({ scope }: { scope: WorkspaceScope }): ReactNode {
  const [availability, setAvailability] = useState<"loading" | "enabled" | "unavailable" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [notification, setNotification] = useState<WorkbenchNotification>();
  const t = useTranslate();
  const lang = useLang();
  const { resolvedTheme } = useThemeMode();
  const { search } = useLocation();
  const navigate = useNavigate();
  const location = useMemo(() => readWorkbenchLocation(search), [search]);
  const host = useMemo(() => createWorkflowWorkbenchHost(scope, setNotification), [scope]);
  const preferences = useMemo(
    () => ({
      getItem: (key: string) =>
        window.localStorage.getItem(`connections.workflows.${scope.intent.userId}.${scope.intent.workspaceId}.${key}`),
      setItem: (key: string, value: string) =>
        window.localStorage.setItem(
          `connections.workflows.${scope.intent.userId}.${scope.intent.workspaceId}.${key}`,
          value,
        ),
    }),
    [scope],
  );

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(scope.requests.signal ? [scope.requests.signal] : [])]);
    void fetch(workflowGatewayPath(scope.intent.workspaceId), { credentials: "same-origin", signal })
      .then(async (response) => {
        if (response.status === 401) window.dispatchEvent(new Event("connections-session-invalidated"));
        if (!response.ok) throw new Error("Could not check workflow availability.");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean") {
          throw new Error("Invalid workflow availability response.");
        }
        if (!signal.aborted) setAvailability(value.enabled ? "enabled" : "unavailable");
      })
      .catch(() => {
        if (!signal.aborted) setAvailability("error");
      });
    return () => controller.abort();
  }, [scope, attempt]);

  if (availability !== "enabled") {
    return (
      <div className="workflows-placeholder">
        <p role={availability === "error" ? "alert" : "status"}>{t(`workflows.${availability}`)}</p>
        {availability === "error" ? (
          <Button
            variant="outline"
            onClick={() => {
              setAvailability("loading");
              setAttempt((value) => value + 1);
            }}
          >
            {t("workflows.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  const hrefFor = (next: WorkbenchLocation): string => {
    const params = new URLSearchParams();
    if (next.flowId) {
      params.set("flowId", next.flowId);
      params.set("view", next.view);
      if (next.view === "runs" && next.runId) params.set("runId", next.runId);
      if (next.view === "runs" && next.runSource) params.set("source", next.runSource);
    }
    return workspaceHref(`/workflows?${params}`, scope.intent);
  };

  return (
    <div className="connections-workbench">
      <OpenFlowWorkbench
        catalogWidth="embedded"
        connectionHref={(_flowId, providerId) => workflowProviderHref(providerId, scope.intent)}
        host={host}
        hrefFor={hrefFor}
        language={resolveWorkbenchLanguage([lang])}
        location={location}
        onNavigate={(next, options) => navigate(hrefFor(next), { replace: options.replace })}
        preferences={preferences}
        sessionKey={JSON.stringify(scope.intent)}
        theme={resolvedTheme}
      />
      {notification ? (
        <div className="workflow-notification" role={notification.kind === "error" ? "alert" : "status"}>
          <span>{notification.message}</span>
          {notification.undo ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const undo = notification.undo;
                setNotification(undefined);
                void undo?.run().catch(() => setNotification({ kind: "error", message: t("workflows.error") }));
              }}
            >
              {notification.undo.label}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setNotification(undefined)}>
            {t("workflows.dismiss")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function readWorkbenchLocation(search: string): WorkbenchLocation {
  const params = new URLSearchParams(search);
  const flowId = params.get("flowId") || undefined;
  const selection = params.get("view");
  const view: WorkbenchView = flowId && (selection === "publications" || selection === "runs") ? selection : "design";
  const source = params.get("source");
  return {
    flowId,
    view,
    ...(view === "runs" ? { runId: params.get("runId") || undefined } : {}),
    ...(view === "runs" && (source === "draft" || source === "live") ? { runSource: source } : {}),
  };
}

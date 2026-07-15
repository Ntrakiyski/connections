import type { WorkspaceSummary } from "./model";
import type { ReactNode } from "react";

import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "./shared-ui";
import { Button } from "@/components/ui/button";

export interface WorkspaceSelectorProps {
  activeWorkspaceId: string;
  disabled?: boolean;
  workspaces: WorkspaceSummary[];
  onSwitch(workspaceId: string): Promise<void>;
}

export function WorkspaceSelector(props: WorkspaceSelectorProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active =
    props.workspaces.find((workspace) => workspace.workspaceId === props.activeWorkspaceId) ?? props.workspaces[0];

  if (!active) return null;

  async function switchWorkspace(workspaceId: string): Promise<void> {
    if (workspaceId === active.workspaceId || switching) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      await props.onSwitch(workspaceId);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not switch workspace.");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="workspace-selector">
      <Button
        className="workspace-selector-trigger"
        variant="ghost"
        type="button"
        disabled={props.disabled || switching}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="workspace-selector-copy">
          <strong>{active.name}</strong>
          <Badge>{roleLabel(active.role)}</Badge>
        </span>
        {switching ? <Loader2 className="spin" size={15} /> : <ChevronDown size={15} />}
      </Button>
      {open ? (
        <div className="workspace-selector-menu" role="menu">
          {props.workspaces.map((workspace) => (
            <button
              key={workspace.workspaceId}
              className={
                workspace.workspaceId === active.workspaceId
                  ? "workspace-selector-item active"
                  : "workspace-selector-item"
              }
              type="button"
              role="menuitem"
              disabled={switching}
              onClick={() => void switchWorkspace(workspace.workspaceId)}
            >
              <span>
                <strong>{workspace.name}</strong>
                <small>{roleLabel(workspace.role)}</small>
              </span>
              {workspace.workspaceId === active.workspaceId ? <Check size={15} /> : null}
            </button>
          ))}
          {error ? <p className="workspace-selector-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function roleLabel(role: WorkspaceSummary["role"]): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

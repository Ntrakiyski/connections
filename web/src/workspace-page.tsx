import type { AppData } from "./model";
import type { FormEvent, ReactNode } from "react";

import { useState } from "react";
import { apiDelete } from "./api";
import { useWorkspaceRequests } from "./workspace-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspacePage(props: { data: AppData; onDirectoryRefresh(): void }): ReactNode {
  const requests = useWorkspaceRequests();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  if (props.data.role !== "admin")
    return (
      <section className="detail-panel">
        <h2>Workspace settings unavailable</h2>
        <p>A workspace admin grant is required.</p>
      </section>
    );
  async function archive(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await apiDelete("/api/workspace", requests, { confirmation });
      setStatus("Workspace archived.");
      props.onDirectoryRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Archiving failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="detail-panel">
      <h2>{props.data.workspaceName}</h2>
      <h3>Archive workspace</h3>
      <p>
        Archiving makes this workspace's connections, files and runtime keys unavailable. An admin can restore it for 14
        days. Revoked keys stay revoked.
      </p>
      <form className="account-form" onSubmit={(event) => void archive(event)}>
        <Label className="field">
          Type {props.data.workspaceName} to confirm
          <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        </Label>
        <Button variant="destructive" type="submit" disabled={busy || confirmation.trim() !== props.data.workspaceName}>
          Archive workspace
        </Button>
        <p role="status" aria-live="polite">
          {status}
        </p>
      </form>
    </section>
  );
}

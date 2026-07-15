import type { WorkspaceSettings } from "./model";
import type { FormEvent, ReactNode } from "react";

import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPut } from "./api";
import { FormStatus, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface WorkspaceSettingsPageProps {
  onDeleted(): void;
  onRefresh(): void;
}

export function WorkspaceSettingsPage(props: WorkspaceSettingsPageProps): ReactNode {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<WorkspaceSettings>("/api/workspace/settings")
      .then((next) => {
        if (!cancelled) {
          setSettings(next);
          setName(next.name);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load workspace settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("Saving workspace settings…");
    try {
      const next = await apiPut<WorkspaceSettings>("/api/workspace/settings", { name: name.trim() });
      setSettings(next);
      setName(next.name);
      setStatus("Workspace settings saved.");
      props.onRefresh();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Could not save workspace settings.");
    }
  }

  async function deleteWorkspace(): Promise<void> {
    setDeleting(true);
    try {
      await apiDelete("/api/workspace");
      props.onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete workspace.");
    } finally {
      setDeleting(false);
    }
  }

  if (error && !settings) return <InlineError message={error} />;
  if (!settings) return <p className="muted-copy">Loading workspace settings…</p>;

  return (
    <div className="workspace-page">
      <section className="detail-panel workspace-settings-panel">
        <div className="table-panel-heading">
          <div>
            <h2>Workspace settings</h2>
            <p>Manage the current workspace.</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={(event) => void save(event)}>
          <Label className="field">
            <span>Workspace name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Label>
          <dl className="workspace-details">
            <div>
              <dt>Created</dt>
              <dd>{new Date(settings.createdAt).toLocaleDateString()}</dd>
            </div>
            <div>
              <dt>Members</dt>
              <dd>{settings.memberCount}</dd>
            </div>
          </dl>
          <div className="button-row">
            <Button type="submit" disabled={!name.trim()}>
              Save changes
            </Button>
          </div>
          {status ? <FormStatus message={status} /> : null}
        </form>
      </section>

      <section className="detail-panel workspace-danger-zone">
        <div>
          <h2>Delete workspace</h2>
          <p>This immediately makes the workspace unavailable. An encrypted backup is retained for 14 days.</p>
        </div>
        <Dialog onOpenChange={(open) => !open && setConfirmation("")}>
          <DialogTrigger asChild>
            <Button variant="destructive" type="button">
              Delete workspace
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {settings.name}?</DialogTitle>
              <DialogDescription>Type the workspace name to confirm this destructive action.</DialogDescription>
            </DialogHeader>
            <Label className="field">
              <span>Workspace name</span>
              <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            </Label>
            <DialogFooter>
              <Button
                variant="destructive"
                type="button"
                disabled={confirmation !== settings.name || deleting}
                onClick={() => void deleteWorkspace()}
              >
                Delete workspace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
      {error ? <InlineError message={error} /> : null}
    </div>
  );
}

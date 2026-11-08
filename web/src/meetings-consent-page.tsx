import type { AccountDirectory } from "./account-model";
import type { ReactNode } from "react";

import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { z } from "zod";
import { apiPost } from "./api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const selectionSchema = z.object({ referenceId: z.string(), workspaceId: z.string().nullable() });
const redirectSchema = z.object({ url: z.string() });

export function MeetingsConsentPage(props: { directory: AccountDirectory; onLogout(): void }): ReactNode {
  const location = useLocation();
  const oauthQuery = location.search.slice(1);
  const parameters = new URLSearchParams(oauthQuery);
  const consent = parameters.has("ba_pl");
  const [workspaceId, setWorkspaceId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const workspaces = props.directory.account.workspaces.filter((workspace) => !workspace.archived);
  useEffect(() => {
    const controller = new AbortController();
    void apiPost<unknown>("/api/meetings-oauth/request", { oauthQuery }, { signal: controller.signal })
      .then((result) => {
        const selection = selectionSchema.parse(result);
        if (!controller.signal.aborted) {
          setWorkspaceId(selection.workspaceId ?? "");
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "The sign-in request is unavailable.");
      });
    return () => controller.abort();
  }, [oauthQuery]);
  async function choose(): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      await apiPost("/api/meetings-oauth/select", { oauthQuery, workspaceId });
      const redirect = redirectSchema.parse(await apiPost("/api/meetings-oauth/continue", { oauthQuery }));
      const url = new URL(redirect.url, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== "/desktop/connect")
        throw new Error("Unexpected sign-in continuation.");
      window.location.assign(url.toString());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workspace selection failed.");
      setBusy(false);
    }
  }
  async function finish(accept: boolean): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const redirect = redirectSchema.parse(await apiPost("/api/meetings-oauth/consent", { oauthQuery, accept }));
      const url = new URL(redirect.url);
      if (
        url.protocol !== "meetingly:" ||
        url.hostname !== "oauth" ||
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== parameters.get("state")
      )
        throw new Error("Unexpected Meetings callback.");
      window.location.assign(url.toString());
      setMessage(
        accept
          ? "Access granted. Return to Meetings to finish signing in."
          : "Access declined. You can return to Meetings.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Consent could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  const selected = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <h1>{consent ? "Connect Meetings" : "Choose a workspace for Meetings"}</h1>
        <p>Signed in as {props.directory.account.user.email}</p>
        {consent ? (
          <>
            <p>
              Meetings will use{" "}
              <strong>
                {selected?.organizationName} / {selected?.workspaceName}
              </strong>
              .
            </p>
            <ul>
              {parameters.get("scope")?.split(" ").includes("meetings:read") ? (
                <li>Read meetings shared in this workspace.</li>
              ) : null}
              {parameters.get("scope")?.split(" ").includes("meetings:write") ? (
                <li>Upload and update recordings you create.</li>
              ) : null}
              {parameters.get("scope")?.split(" ").includes("offline_access") ? (
                <li>Stay signed in for recording sync until access expires or is revoked.</li>
              ) : null}
            </ul>
            <p>
              Switching to another workspace requires a new sign-in. Saved recordings keep their original workspace.
            </p>
            <Button disabled={!loaded || !selected || busy} onClick={() => void finish(true)}>
              Allow Meetings
            </Button>
            <Button variant="outline" disabled={!loaded || busy} onClick={() => void finish(false)}>
              Decline
            </Button>
          </>
        ) : (
          <>
            <Label htmlFor="meetings-workspace">Workspace</Label>
            <select
              id="meetings-workspace"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={!loaded || busy}
            >
              <option value="">Choose a workspace</option>
              {workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.organizationName} / {workspace.workspaceName}
                </option>
              ))}
            </select>
            <Button disabled={!loaded || !selected || busy} onClick={() => void choose()}>
              Continue
            </Button>
            <Button variant="outline" disabled={busy} onClick={props.onLogout}>
              Use another account
            </Button>
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
      </section>
    </main>
  );
}

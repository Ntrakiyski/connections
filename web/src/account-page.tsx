import type { AccountDirectory } from "./account-model";
import type { FormEvent, ReactNode } from "react";

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { authClient } from "./auth-client";
import { useWorkspaceScope } from "./workspace-context";
import { workspaceHref } from "./workspace-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AccountPageProps {
  directory: AccountDirectory;
  onRefresh(): void;
  onLogout(): void;
  embedded?: boolean;
  view?: "companies" | "security";
  managedCompanyId?: string;
}
export function AccountPage(props: AccountPageProps): ReactNode {
  const location = useLocation();
  const scope = useWorkspaceScope();
  const companyId = props.embedded
    ? props.managedCompanyId
    : location.pathname.startsWith("/companies/")
      ? decodeURIComponent(location.pathname.slice("/companies/".length))
      : undefined;
  const company = props.directory.companies.find((item) => item.id === companyId);
  const security = props.view === "security" || (!props.embedded && location.pathname === "/account/security");
  const companiesHref =
    props.embedded && scope ? workspaceHref("/workspace?settingsTab=companies", scope.intent) : "/account";
  const Container = props.embedded ? "div" : "main";
  return (
    <Container className={props.embedded ? "settings-account" : "account-home"}>
      {!props.embedded ? (
        <>
          <header className="account-header">
            <div>
              <h1>Connections</h1>
              <p>{props.directory.account.user.email}</p>
            </div>
            <Button variant="outline" onClick={props.onLogout}>
              Sign out
            </Button>
          </header>
          <nav className="button-row" aria-label="Account navigation">
            <Button variant="outline" asChild>
              <Link to={companiesHref}>Companies and workspaces</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/account/security">Account and security</Link>
            </Button>
          </nav>
        </>
      ) : null}
      {props.embedded && companyId ? (
        <Button variant="outline" size="sm" asChild>
          <Link to={companiesHref}>All companies</Link>
        </Button>
      ) : null}
      {security ? (
        <SecurityPanel key={props.directory.account.user.id} directory={props.directory} onRefresh={props.onRefresh} />
      ) : companyId && (!company || company.role === "member") ? (
        <section className="account-section">
          <h2>Company management unavailable</h2>
          <p role="alert">A current company owner or admin role is required.</p>
          <Link to={companiesHref}>Choose a company or workspace</Link>
        </section>
      ) : company && company.role !== "member" ? (
        <CompanyPanel
          key={company.id}
          organizationId={company.id}
          name={company.name}
          userId={props.directory.account.user.id}
          onRefresh={props.onRefresh}
        />
      ) : (
        <>
          <section className="account-section">
            <h2>Your companies</h2>
            {!props.directory.companies.length ? (
              <p>You have not joined a company yet. Accept an invitation or create one below.</p>
            ) : null}
            <div className="company-grid">
              {props.directory.companies.map((item) => {
                const workspaces = props.directory.account.workspaces.filter(
                  (workspace) => workspace.organizationId === item.id,
                );
                return (
                  <article className="company-card" key={item.id}>
                    <h3>{item.name}</h3>
                    <p>Company {item.role}</p>
                    {!workspaces.length ? (
                      <p>No workspace grant. Ask a company administrator for access.</p>
                    ) : (
                      <ul>
                        {workspaces.map((workspace) => (
                          <li key={workspace.workspaceId}>
                            <Link to={workspaceHref("/overview", workspace)}>{workspace.workspaceName}</Link>
                            <span>
                              {" "}
                              · {workspace.role}
                              {workspace.archived ? " · Archived" : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.role !== "member" ? (
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          to={
                            props.embedded && scope
                              ? workspaceHref(
                                  `/workspace?settingsTab=companies&managedCompanyId=${encodeURIComponent(item.id)}`,
                                  scope.intent,
                                )
                              : `/companies/${encodeURIComponent(item.id)}`
                          }
                        >
                          Manage company
                        </Link>
                      </Button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
          <Invitations directory={props.directory} onRefresh={props.onRefresh} />
          <CreateCompany onRefresh={props.onRefresh} />
        </>
      )}
    </Container>
  );
}

function Invitations(props: Pick<AccountPageProps, "directory" | "onRefresh">): ReactNode {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function accept(id: string): Promise<void> {
    setBusy(true);
    setStatus("");
    try {
      await apiPost(`/api/account/invitations/${encodeURIComponent(id)}/accept`, {});
      setStatus("Invitation accepted.");
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invitation could not be accepted.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-section">
      <h2>Invitations</h2>
      {!props.directory.invitations.length ? (
        <p>No pending invitations for your verified email.</p>
      ) : (
        props.directory.invitations.map((invitation) => (
          <div className="account-row" key={invitation.id}>
            <div>
              <strong>{invitation.organizationName}</strong>
              <p>
                Join as a company {invitation.role}. Expires {new Date(invitation.expiresAt).toLocaleString()}.
              </p>
            </div>
            <Button disabled={busy} onClick={() => void accept(invitation.id)}>
              Accept invitation
            </Button>
          </div>
        ))
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}

function CreateCompany(props: { onRefresh(): void }): ReactNode {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    try {
      await apiPost("/api/companies", {
        name: values.get("name"),
        slug: values.get("slug"),
        workspaceName: values.get("workspaceName"),
      });
      form.reset();
      setStatus("Company and initial workspace created.");
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Company could not be created.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-section">
      <h2>Create a company</h2>
      <p>You become its owner and the admin of its first workspace.</p>
      <form className="account-form" onSubmit={(event) => void submit(event)}>
        <Label className="field">
          Company name
          <Input name="name" required maxLength={160} />
        </Label>
        <Label className="field">
          Company slug
          <Input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="client-company" />
        </Label>
        <Label className="field">
          First workspace name
          <Input name="workspaceName" required maxLength={160} />
        </Label>
        <Button type="submit" disabled={busy}>
          Create company
        </Button>
        <p role="status">{status}</p>
      </form>
    </section>
  );
}

const overviewSchema = z.object({
  members: z.array(
    z.object({ userId: z.string(), name: z.string(), email: z.string(), role: z.enum(["owner", "admin", "member"]) }),
  ),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), archived: z.boolean() })),
  grants: z.array(
    z.object({ workspaceId: z.string(), userId: z.string(), role: z.enum(["admin", "manager", "member"]) }),
  ),
  invitations: z.array(z.object({ id: z.string(), email: z.string(), role: z.string(), expiresAt: z.string() })),
});
type CompanyOverview = z.infer<typeof overviewSchema>;
function CompanyPanel(props: { organizationId: string; name: string; userId: string; onRefresh(): void }): ReactNode {
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const base = `/api/companies/${encodeURIComponent(props.organizationId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void apiGet<unknown>(base, { signal: controller.signal })
      .then((result) => {
        setOverview(overviewSchema.parse(result));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStatus(error instanceof Error ? error.message : "Company access unavailable.");
      });
    return () => controller.abort();
  }, [base, revision]);
  async function perform(operation: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true);
    setStatus("");
    try {
      await operation();
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The operation failed.");
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
      props.onRefresh();
    }
  }
  async function provision(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await perform(
      () => apiPost(`${base}/workspaces`, { name: values.get("name"), initialAdminId: values.get("initialAdminId") }),
      "Workspace created.",
    );
  }
  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const grants = (overview?.workspaces ?? []).flatMap((workspace) => {
      const role = values.get(`grant:${workspace.id}`);
      return role && role !== "none" ? [{ workspaceId: workspace.id, role }] : [];
    });
    const result = await perform(async () => {
      const response = z.object({ delivery: z.enum(["sent", "failed"]) }).parse(
        await apiPost<unknown>(`${base}/invitations`, {
          email: values.get("email"),
          role: values.get("role"),
          grants,
        }),
      );
      if (response.delivery === "failed")
        throw new Error("Invitation saved, but email delivery failed. Use Resend below.");
    }, "Invitation sent.");
    return result;
  }
  if (!overview)
    return (
      <section className="account-section" aria-busy={!status}>
        <h2>{props.name}</h2>
        <p role="status">{status || "Loading company people and grants…"}</p>
      </section>
    );
  return (
    <section className="account-section">
      <h2>Manage {props.name}</h2>
      <p>Company roles govern people. Workspace grants independently govern resources.</p>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <h3>Company people</h3>
      {overview.members.map((person) => (
        <div className="account-row" key={person.userId}>
          <div>
            <strong>{person.name}</strong>
            <p>{person.email}</p>
          </div>
          <form
            className="button-row"
            key={`${person.userId}:${person.role}`}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void perform(
                () => apiPatch(`${base}/members/${encodeURIComponent(person.userId)}`, { role: values.get("role") }),
                "Company role updated.",
              );
            }}
          >
            <select name="role" aria-label={`Company role for ${person.email}`} defaultValue={person.role}>
              <option>member</option>
              <option>admin</option>
              <option>owner</option>
            </select>
            <Button type="submit" variant="outline" disabled={busy}>
              Save role
            </Button>
          </form>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${person.email} from ${props.name} and revoke all their workspace access in this company?`,
                )
              )
                void perform(
                  () => apiDelete(`${base}/members/${encodeURIComponent(person.userId)}`),
                  "Member removed from this company.",
                );
            }}
          >
            Remove member
          </Button>
        </div>
      ))}
      <h3>Workspaces and grants</h3>
      {overview.workspaces.map((workspace) => (
        <article key={workspace.id} className="company-card">
          <h4>
            {workspace.name}
            {workspace.archived ? " · Archived" : ""}
          </h4>
          {overview.members.map((person) => {
            const grant = overview.grants.find(
              (item) => item.workspaceId === workspace.id && item.userId === person.userId,
            );
            return (
              <form
                key={`${person.userId}:${grant?.role}`}
                className="account-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const role = new FormData(event.currentTarget).get("role");
                  const endpoint = `${base}/workspaces/${encodeURIComponent(workspace.id)}/grants/${encodeURIComponent(person.userId)}`;
                  if (
                    role === "none" &&
                    !window.confirm(
                      `Remove ${person.email}'s access and revoke their keys and connections in ${workspace.name}?`,
                    )
                  )
                    return;
                  void perform(
                    () => (role === "none" ? apiDelete(endpoint) : apiPut(endpoint, { role })),
                    "Workspace grant updated.",
                  );
                }}
              >
                <span>{person.email}</span>
                <select
                  name="role"
                  aria-label={`Workspace role for ${person.email} in ${workspace.name}`}
                  defaultValue={grant?.role ?? "none"}
                >
                  <option value="none">No grant</option>
                  <option>member</option>
                  <option>manager</option>
                  <option>admin</option>
                </select>
                <Button type="submit" variant="outline" disabled={busy}>
                  Save grant
                </Button>
              </form>
            );
          })}
        </article>
      ))}
      <h3>Provision a workspace</h3>
      <form className="account-form" onSubmit={(event) => void provision(event)}>
        <Label className="field">
          Workspace name
          <Input name="name" required maxLength={160} />
        </Label>
        <Label className="field">
          Initial workspace admin
          <select name="initialAdminId" defaultValue={props.userId}>
            {overview.members.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.email}
              </option>
            ))}
          </select>
        </Label>
        <Button type="submit" disabled={busy}>
          Create workspace
        </Button>
      </form>
      <h3>Invite a verified account</h3>
      <form className="account-form" onSubmit={(event) => void invite(event)}>
        <Label className="field">
          Recipient email
          <Input name="email" type="email" required />
        </Label>
        <Label className="field">
          Company role
          <select name="role" defaultValue="member">
            <option>member</option>
            <option>admin</option>
            <option>owner</option>
          </select>
        </Label>
        {overview.workspaces
          .filter((workspace) => !workspace.archived)
          .map((workspace) => (
            <Label className="field" key={workspace.id}>
              {workspace.name} grant
              <select name={`grant:${workspace.id}`} defaultValue="none">
                <option value="none">No grant</option>
                <option>member</option>
                <option>manager</option>
                <option>admin</option>
              </select>
            </Label>
          ))}
        <Button type="submit" disabled={busy}>
          Send invitation
        </Button>
      </form>
      <h3>Pending invitations</h3>
      {overview.invitations.map((invitation) => (
        <div className="account-row" key={invitation.id}>
          <span>
            {invitation.email} · {invitation.role}
          </span>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const result = z
                  .object({ delivery: z.enum(["sent", "failed"]) })
                  .parse(
                    await apiPost<unknown>(`/api/company-invitations/${encodeURIComponent(invitation.id)}/resend`, {}),
                  );
                if (result.delivery === "failed")
                  throw new Error("Email delivery failed. The invitation is retained for another retry.");
              }, "Invitation resent.")
            }
          >
            Resend
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(
                () => apiDelete(`/api/company-invitations/${encodeURIComponent(invitation.id)}`),
                "Invitation canceled.",
              )
            }
          >
            Cancel invitation
          </Button>
        </div>
      ))}
    </section>
  );
}

function SecurityPanel(props: Pick<AccountPageProps, "directory" | "onRefresh">): ReactNode {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function rename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    setBusy(true);
    try {
      const result = await authClient.updateUser({ name });
      if (result.error) throw new Error(result.error.message);
      setStatus("Profile updated.");
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile update failed.");
    } finally {
      setBusy(false);
    }
  }
  async function password(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    try {
      const result = await authClient.changePassword({
        currentPassword: String(values.get("currentPassword")),
        newPassword: String(values.get("newPassword")),
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      form.reset();
      setStatus("Password updated and other sessions revoked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Password update failed.");
    } finally {
      setBusy(false);
    }
  }
  async function revokeOthers(): Promise<void> {
    setBusy(true);
    try {
      const result = await authClient.revokeOtherSessions();
      if (result.error) throw new Error(result.error.message);
      setStatus("Other sessions revoked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sessions could not be revoked.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-section">
      <h2>Account and security</h2>
      <p>{props.directory.account.user.email} · Verified</p>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <form className="account-form" onSubmit={(event) => void rename(event)}>
        <Label className="field">
          Name
          <Input name="name" defaultValue={props.directory.account.user.name} required />
        </Label>
        <Button disabled={busy} type="submit">
          Update profile
        </Button>
      </form>
      <h3>Change password</h3>
      <form className="account-form" onSubmit={(event) => void password(event)}>
        <Label className="field">
          Current password
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Label>
        <Label className="field">
          New password
          <Input name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
        </Label>
        <Button type="submit" disabled={busy}>
          Change password
        </Button>
      </form>
      <Button disabled={busy} variant="outline" onClick={() => void revokeOthers()}>
        Sign out other sessions
      </Button>
    </section>
  );
}

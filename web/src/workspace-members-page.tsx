import type { WorkspaceMember, WorkspaceRole } from "./model";
import type { FormEvent, ReactNode } from "react";

import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { Badge, FormStatus, InlineError } from "./shared-ui";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface WorkspaceMembersPageProps {
  currentUserId: string;
}

const roles: WorkspaceRole[] = ["member", "manager", "admin"];

export function WorkspaceMembersPage(props: WorkspaceMembersPageProps): ReactNode {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const admins = useMemo(() => members.filter((member) => member.role === "admin"), [members]);

  function refresh(): void {
    void apiGet<WorkspaceMember[]>("/api/workspace/members")
      .then(setMembers)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Could not load workspace members."),
      );
  }

  useEffect(refresh, []);

  async function invite(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus("Sending invitation…");
    try {
      await apiPost("/api/workspace/members/invite", { email: email.trim(), role: inviteRole });
      setEmail("");
      setStatus("Invitation sent.");
      refresh();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Could not invite this member.");
    }
  }

  async function updateRole(member: WorkspaceMember, role: WorkspaceRole): Promise<void> {
    try {
      await apiPut(`/api/workspace/members/${encodeURIComponent(member.userId)}/role`, { role });
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update this member’s role.");
    }
  }

  async function remove(member: WorkspaceMember): Promise<void> {
    try {
      await apiDelete(`/api/workspace/members/${encodeURIComponent(member.userId)}`);
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this member.");
    }
  }

  return (
    <div className="workspace-page">
      <section className="detail-panel workspace-members-panel">
        <div className="table-panel-heading">
          <div>
            <h2>Members</h2>
            <p>Admins manage access and workspace roles.</p>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isCurrentUser = member.userId === props.currentUserId;
              const isLastAdmin = member.role === "admin" && admins.length === 1;
              return (
                <TableRow key={member.userId}>
                  <TableCell>
                    <strong>{member.name ?? member.email ?? member.userId}</strong>
                    {member.email ? <small className="table-subtitle">{member.email}</small> : null}
                    {isCurrentUser ? <Badge>You</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={member.role}
                      disabled={isCurrentUser || isLastAdmin}
                      onValueChange={(role) => void updateRole(member, role as WorkspaceRole)}
                    >
                      <SelectTrigger size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((role) => (
                          <SelectItem key={role} value={role}>
                            {capitalize(role)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm" disabled={isCurrentUser || isLastAdmin}>
                          Remove
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Remove {member.name ?? member.email ?? member.userId}?</DialogTitle>
                          <DialogDescription>
                            This immediately revokes their runtime tokens and disconnects their provider accounts.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <Button variant="destructive" onClick={() => void remove(member)}>
                            Remove member
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
      <section className="detail-panel workspace-invite-panel">
        <h2>Invite member</h2>
        <form className="form-grid workspace-invite-form" onSubmit={(event) => void invite(event)}>
          <Label className="field">
            <span>Email address</span>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Label>
          <Label className="field">
            <span>Role</span>
            <Select value={inviteRole} onValueChange={(role) => setInviteRole(role as WorkspaceRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {capitalize(role)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <div className="button-row">
            <Button type="submit" disabled={!email.trim()}>
              Send invitation
            </Button>
          </div>
        </form>
        {status ? <FormStatus message={status} /> : null}
      </section>
      {error ? <InlineError message={error} /> : null}
    </div>
  );
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

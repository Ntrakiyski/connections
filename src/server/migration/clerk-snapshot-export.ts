import type { ClerkSnapshot, ClerkSignInMethod } from "./clerk-snapshot.ts";
import type { createClerkClient } from "@clerk/backend";

import { z } from "zod";
import { clerkSnapshotSchema, normalizeClerkSnapshot } from "./clerk-snapshot.ts";

interface Page<T> {
  data: T[];
  totalCount: number;
}
interface Pagination {
  offset: number;
  limit: number;
}
const observedPasskeys = z.object({
  passkeys: z.array(z.unknown()).optional(),
  passkey_enabled: z.boolean().optional(),
});

/** Read-only Backend API export. The instance ID is obtained from the key's actual instance, never supplied as a label. */
export async function exportClerkSnapshot(client: ReturnType<typeof createClerkClient>): Promise<ClerkSnapshot> {
  const instance = await client.instance.get();
  const sourceUsers = await collectPages((page) => client.users.getUserList({ ...page, orderBy: "+created_at" }));
  const organizations = await collectPages((page) =>
    client.organizations.getOrganizationList({ ...page, orderBy: "+created_at" }),
  );
  const snapshot: ClerkSnapshot = {
    version: 1,
    sourceInstance: instance.id,
    capturedAt: new Date().toISOString(),
    users: sourceUsers.map((user) => {
      const primary = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId);
      const passkeys = observedPasskeys.parse(user.raw ?? {});
      const methods: ClerkSignInMethod[] = [];
      if (user.passwordEnabled) methods.push("password");
      if (user.externalAccounts.length) methods.push("external");
      if (user.samlAccounts.length) methods.push("saml");
      if (user.phoneNumbers.length) methods.push("phone");
      if (user.web3Wallets.length) methods.push("wallet");
      if (passkeys.passkey_enabled || passkeys.passkeys?.length) methods.push("passkey");
      return {
        id: user.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.id,
        primaryEmail: primary?.emailAddress ?? null,
        emails: user.emailAddresses.map((email) => ({
          address: email.emailAddress,
          verified: email.verification?.status === "verified",
        })),
        createdAt: new Date(user.createdAt).toISOString(),
        updatedAt: new Date(user.updatedAt).toISOString(),
        signInMethods: methods,
        mfaEnabled: user.twoFactorEnabled || user.totpEnabled || user.backupCodeEnabled,
        disabled: user.banned || user.locked,
      };
    }),
    organizations: organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: new Date(organization.createdAt).toISOString(),
      createdBy: organization.createdBy ?? null,
    })),
    memberships: [],
    invitations: [],
  };
  for (const organization of organizations) {
    const members = await collectPages((page) =>
      client.organizations.getOrganizationMembershipList({
        ...page,
        organizationId: organization.id,
        orderBy: "+created_at",
      }),
    );
    for (const member of members) {
      if (!member.publicUserData?.userId)
        throw new Error("Source membership lacks a stable user ID. Stop and repeat the frozen export.");
      snapshot.memberships.push({
        id: member.id,
        organizationId: organization.id,
        userId: member.publicUserData.userId,
        role: member.role,
        createdAt: new Date(member.createdAt).toISOString(),
      });
    }
    const invitations = await collectPages((page) =>
      client.organizations.getOrganizationInvitationList({ ...page, organizationId: organization.id }),
    );
    for (const invite of invitations) {
      if (!invite.status) throw new Error("Source invitation lacks its status. Stop and repeat the frozen export.");
      snapshot.invitations.push({
        id: invite.id,
        organizationId: organization.id,
        email: invite.emailAddress,
        role: invite.role,
        status: invite.status,
        expiresAt: new Date(invite.expiresAt).toISOString(),
      });
    }
  }
  return normalizeClerkSnapshot(clerkSnapshotSchema.parse(snapshot));
}

async function collectPages<T>(read: (page: Pagination) => Promise<Page<T>>): Promise<T[]> {
  const result: T[] = [];
  let expected: number | undefined;
  for (;;) {
    const page = await read({ offset: result.length, limit: 100 });
    if (expected !== undefined && page.totalCount !== expected)
      throw new Error("Source count changed during export. Freeze Clerk membership writes and repeat.");
    expected = page.totalCount;
    result.push(...page.data);
    if (result.length === expected) return result;
    if (!page.data.length || result.length > expected)
      throw new Error("Incomplete Clerk pagination. Repeat the frozen source export.");
  }
}

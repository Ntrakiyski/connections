import { createHash } from "node:crypto";
import { z } from "zod";

export type ClerkSignInMethod = "password" | "external" | "saml" | "phone" | "wallet" | "passkey";
export interface ClerkSourceUser {
  id: string;
  name: string;
  primaryEmail: string | null;
  emails: Array<{ address: string; verified: boolean }>;
  createdAt: string;
  updatedAt: string;
  signInMethods: ClerkSignInMethod[];
  mfaEnabled: boolean;
  disabled: boolean;
}
export interface ClerkSnapshot {
  version: 1;
  sourceInstance: string;
  capturedAt: string;
  users: ClerkSourceUser[];
  organizations: Array<{ id: string; name: string; slug: string | null; createdAt: string; createdBy: string | null }>;
  memberships: Array<{ id: string; organizationId: string; userId: string; role: string; createdAt: string }>;
  invitations: Array<{
    id: string;
    organizationId: string;
    email: string;
    role: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    expiresAt: string;
  }>;
}
export interface ClerkImportManifest {
  version: 1;
  sourceInstance: string;
  companies: Array<{
    sourceOrganizationId: string;
    workspaceId: string;
    ownerUserId: string;
    workspaceAdminId: string;
    slug: string;
  }>;
  directoryRoles: Record<string, "admin" | "member">;
  localCompatibilityWorkspaceIds: Array<"default">;
}

const userId = z
  .string()
  .regex(/^user_[A-Za-z0-9_-]+$/)
  .max(200);
const organizationId = z
  .string()
  .regex(/^org_[A-Za-z0-9_-]+$/)
  .max(200);
const timestamp = z.iso.datetime();
const email = z.email().transform((value) => value.trim().toLowerCase());
const sourceInstance = z
  .string()
  .regex(/^ins_[A-Za-z0-9_-]+$/)
  .max(200);

/** Contains identity facts only. Passwords, MFA secrets, external tokens and invitation links are never exported. */
export const clerkSnapshotSchema: z.ZodType<ClerkSnapshot> = z.strictObject({
  version: z.literal(1),
  sourceInstance,
  capturedAt: timestamp,
  users: z.array(
    z.strictObject({
      id: userId,
      name: z.string().min(1).max(160),
      primaryEmail: email.nullable(),
      emails: z.array(z.strictObject({ address: email, verified: z.boolean() })),
      createdAt: timestamp,
      updatedAt: timestamp,
      signInMethods: z.array(z.enum(["password", "external", "saml", "phone", "wallet", "passkey"])),
      mfaEnabled: z.boolean(),
      disabled: z.boolean(),
    }),
  ),
  organizations: z.array(
    z.strictObject({
      id: organizationId,
      name: z.string().min(1).max(160),
      slug: z.string().nullable(),
      createdAt: timestamp,
      createdBy: userId.nullable(),
    }),
  ),
  memberships: z.array(
    z.strictObject({
      id: z.string().min(1).max(200),
      organizationId,
      userId,
      role: z.string().min(1).max(100),
      createdAt: timestamp,
    }),
  ),
  invitations: z.array(
    z.strictObject({
      id: z.string().min(1).max(200),
      organizationId,
      email,
      role: z.string().min(1).max(100),
      status: z.enum(["pending", "accepted", "revoked", "expired"]),
      expiresAt: timestamp,
    }),
  ),
});

/** Owners are designated explicitly; workspace admins must already have a verified legacy admin grant. */
export const clerkImportManifestSchema: z.ZodType<ClerkImportManifest> = z.strictObject({
  version: z.literal(1),
  sourceInstance,
  companies: z.array(
    z.strictObject({
      sourceOrganizationId: organizationId,
      workspaceId: z.string().min(1).max(200),
      ownerUserId: userId,
      workspaceAdminId: userId,
      slug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
    }),
  ),
  directoryRoles: z.record(z.string(), z.enum(["admin", "member"])),
  localCompatibilityWorkspaceIds: z.array(z.literal("default")).max(1),
});

/** Stable hashing ignores object property order, but preserves data and array order. Callers sort source collections. */
export function importFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Import fingerprints require JSON values.");
  return result;
}

export function normalizeClerkSnapshot(snapshot: ClerkSnapshot): ClerkSnapshot {
  return {
    ...snapshot,
    users: snapshot.users
      .map((user) => ({
        ...user,
        emails: [...user.emails].sort((a, b) => a.address.localeCompare(b.address)),
        signInMethods: [...user.signInMethods].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    organizations: [...snapshot.organizations].sort((a, b) => a.id.localeCompare(b.id)),
    memberships: [...snapshot.memberships].sort((a, b) => a.id.localeCompare(b.id)),
    invitations: [...snapshot.invitations].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

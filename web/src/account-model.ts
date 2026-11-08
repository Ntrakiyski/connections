import { z } from "zod";
import { apiGet } from "./api";

const companyRole = z.enum(["owner", "admin", "member"]);
const workspaceRole = z.enum(["admin", "manager", "member"]);
export const companySchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: companyRole });
export const accountSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  workspaces: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      organizationRole: companyRole,
      workspaceId: z.string(),
      workspaceName: z.string(),
      role: workspaceRole,
      archived: z.boolean(),
    }),
  ),
});
export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  email: z.string(),
  role: companyRole,
  expiresAt: z.string(),
  grants: z.array(z.object({ workspaceId: z.string(), role: workspaceRole })).optional(),
});
export type Account = z.infer<typeof accountSchema>;
export type Company = z.infer<typeof companySchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export interface AccountDirectory {
  account: Account;
  companies: Company[];
  invitations: Invitation[];
}

export async function loadAccountDirectory(signal?: AbortSignal): Promise<AccountDirectory> {
  const [account, companies, invitations] = await Promise.all([
    apiGet<unknown>("/api/account", { signal }),
    apiGet<unknown>("/api/companies", { signal }),
    apiGet<unknown>("/api/account/invitations", { signal }),
  ]);
  return {
    account: accountSchema.parse(account),
    companies: z.array(companySchema).parse(companies),
    invitations: z.array(invitationSchema).parse(invitations),
  };
}

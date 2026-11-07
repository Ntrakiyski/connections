import type { CompanyDirectoryService } from "../company-directory.ts";
import type { CompanyInvitationService } from "../company-invitations.ts";
import type { CompanyService } from "../company-service.ts";
import type { ConnectionsHumanAuth } from "../human-auth.ts";
import type { Context, Hono } from "hono";

import { z } from "zod";
import { HttpRequestError, readJsonBody } from "./http-utils.ts";
import { assertTrustedMutation } from "./principal-auth.ts";

export interface CompanyRouteOptions {
  auth: ConnectionsHumanAuth;
  trustedOrigins: string[];
  companies: CompanyService;
  invitations: CompanyInvitationService;
  directory: CompanyDirectoryService;
}
const roleSchema = z.enum(["owner", "admin", "member"]);
const grantRoleSchema = z.enum(["admin", "manager", "member"]);
const idSchema = z.string().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(160);

/** Account-level governance has no global active-workspace dependency. All scope comes from route parameters. */
export function registerCompanyRoutes(app: Hono, options: CompanyRouteOptions): void {
  async function user(context: Context): Promise<string> {
    assertTrustedMutation(context.req.raw, options.trustedOrigins);
    if (context.req.header("authorization"))
      throw new HttpRequestError("principal_forbidden", "Company operations require a verified session.", 401);
    const session = await options.auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user.emailVerified)
      throw new HttpRequestError("unauthorized", "A verified session is required.", 401);
    return session.user.id;
  }
  app.get("/api/companies", async (context) => context.json(await options.directory.list(await user(context))));
  app.post("/api/companies", async (context) => {
    const actor = await user(context);
    const data = z
      .object({ name: nameSchema, slug: z.string(), workspaceName: nameSchema })
      .parse(await readJsonBody(context));
    return context.json(await options.companies.createCompany(actor, data), 201);
  });
  app.get("/api/companies/:organizationId", async (context) =>
    context.json(await options.directory.overview(await user(context), context.req.param("organizationId"))),
  );
  app.post("/api/companies/:organizationId/workspaces", async (context) => {
    const actor = await user(context);
    const data = z.object({ name: nameSchema, initialAdminId: idSchema }).parse(await readJsonBody(context));
    return context.json(
      await options.companies.createWorkspace(actor, { ...data, organizationId: context.req.param("organizationId") }),
      201,
    );
  });
  app.patch("/api/companies/:organizationId/members/:userId", async (context) => {
    const actor = await user(context);
    const data = z.object({ role: roleSchema }).parse(await readJsonBody(context));
    await options.companies.setOrganizationRole(actor, {
      role: data.role,
      organizationId: context.req.param("organizationId"),
      userId: context.req.param("userId"),
    });
    return context.json({ ok: true });
  });
  app.delete("/api/companies/:organizationId/members/:userId", async (context) => {
    await options.companies.removeOrganizationMember(
      await user(context),
      context.req.param("organizationId"),
      context.req.param("userId"),
    );
    return context.json({ ok: true });
  });
  app.put("/api/companies/:organizationId/workspaces/:workspaceId/grants/:userId", async (context) => {
    const actor = await user(context);
    const data = z.object({ role: grantRoleSchema }).parse(await readJsonBody(context));
    await options.companies.setWorkspaceGrant(actor, {
      role: data.role,
      organizationId: context.req.param("organizationId"),
      workspaceId: context.req.param("workspaceId"),
      userId: context.req.param("userId"),
    });
    return context.json({ ok: true });
  });
  app.delete("/api/companies/:organizationId/workspaces/:workspaceId/grants/:userId", async (context) => {
    await options.companies.removeWorkspaceGrant(
      await user(context),
      context.req.param("organizationId"),
      context.req.param("workspaceId"),
      context.req.param("userId"),
    );
    return context.json({ ok: true });
  });
  app.post("/api/companies/:organizationId/invitations", async (context) => {
    const actor = await user(context);
    const data = z
      .object({
        email: z.email(),
        role: roleSchema,
        grants: z.array(z.object({ workspaceId: idSchema, role: grantRoleSchema })).max(25),
      })
      .parse(await readJsonBody(context));
    return context.json(
      await options.invitations.create(actor, { ...data, organizationId: context.req.param("organizationId") }),
      201,
    );
  });
  app.get("/api/account/invitations", async (context) =>
    context.json(await options.invitations.listForRecipient(await user(context))),
  );
  app.post("/api/account/invitations/:invitationId/accept", async (context) =>
    context.json(await options.invitations.accept(await user(context), context.req.param("invitationId"))),
  );
  app.post("/api/company-invitations/:invitationId/resend", async (context) =>
    context.json(await options.invitations.resend(await user(context), context.req.param("invitationId"))),
  );
  app.delete("/api/company-invitations/:invitationId", async (context) => {
    await options.invitations.cancel(await user(context), context.req.param("invitationId"));
    return context.json({ ok: true });
  });
}

import type { PrincipalAuthOptions } from "./api/principal-auth.ts";
import type { ConnectionsHumanAuth } from "./human-auth.ts";
import type { MeetingsOAuthIdentity } from "./meetings-oauth-context.ts";
import type { IIdentityMutationStore } from "./storage/identity-mutations.ts";

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { symmetricEncrypt } from "better-auth/crypto";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpRequestError } from "./api/http-utils.ts";
import { resolveWorkspaceAccess } from "./api/principal-auth.ts";
import {
  meetingsAccessPrefix,
  meetingsRefreshPrefix,
  meetingsOAuthCalls,
  meetingsOAuthClientId,
  meetingsOAuthRedirect,
  meetingsOAuthScopes,
} from "./meetings-oauth-context.ts";

const date = z.preprocess((value) => (value instanceof Date ? value.toISOString() : value), z.iso.datetime());
const resourceClientId = "connections-meetings-resource-v1";
const bindingSchema = z.object({
  id: z.string(),
  flow_hash: z.string(),
  authorization_code_hash: z.string().nullable(),
  code_redeemed_at: date.nullable(),
  user_id: z.string().nullable(),
  session_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  expires_at: date,
  revoked_at: date.nullable(),
});
const tokenSchema = z.object({
  id: z.string(),
  token: z.string(),
  client_id: z.string(),
  user_id: z.string(),
  reference_id: z.string(),
  expires_at: date,
  revoked: date.nullable().optional(),
  rotated_at: date.nullable().optional(),
});
const introspectionSchema = z.object({
  active: z.literal(true),
  sub: z.string(),
  client_id: z.literal(meetingsOAuthClientId),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  scope: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  workspaceId: z.string(),
});
export interface MeetingsOAuthOptions {
  auth: ConnectionsHumanAuth;
  store: IIdentityMutationStore;
  access: Pick<PrincipalAuthOptions, "directory" | "workspaceStore" | "membershipStore">;
  origin: string;
}
export interface MeetingsOAuthAccess extends MeetingsOAuthIdentity {
  referenceId: string;
  tokenId: string;
  expiresAt: number;
  scopes: string[];
}
export interface MeetingsOAuthSelection {
  referenceId: string;
  workspaceId: string | null;
}

export interface MeetingsLegacyMapping {
  sourceInstance: string;
  legacyOrganizationId: string;
  legacyUserId: string;
}

/** Delegation binding around Better Auth's native PKCE issuer; protocol tokens stay Better Auth-owned. */
export class MeetingsOAuthService {
  readonly issuer: string;
  readonly resource: string;
  private readonly options: MeetingsOAuthOptions;
  constructor(options: MeetingsOAuthOptions) {
    this.options = options;
    this.issuer = `${options.origin}/api/identity`;
    this.resource = `${options.origin}/api/meetings`;
  }

  /** Only a completed import ledger proves the original Clerk recording ownership. */
  async legacyMapping(identity: MeetingsOAuthIdentity): Promise<MeetingsLegacyMapping | null> {
    const rows = await this.options.store.read({
      sql: `select w.source_instance,w.source_id as legacy_organization_id,u.source_id as legacy_user_id
        from identity_source_mappings w
        join identity_import_runs r on r.source_instance=w.source_instance and r.verification='verified'
        join identity_source_mappings c on c.source_instance=w.source_instance and c.kind='company'
          and c.source_id=w.source_id and c.target_id=?
        join identity_source_mappings u on u.source_instance=w.source_instance and u.kind='user' and u.target_id=?
        where w.kind='workspace' and w.target_id=?`,
      values: [identity.organizationId, identity.userId, identity.workspaceId],
    });
    if (rows.length !== 1) return null;
    const row = z
      .object({
        source_instance: z.string().min(1),
        legacy_organization_id: z.string().min(1),
        legacy_user_id: z.string().min(1),
      })
      .parse(rows[0]);
    return {
      sourceInstance: row.source_instance,
      legacyOrganizationId: row.legacy_organization_id,
      legacyUserId: row.legacy_user_id,
    };
  }

  async initialize(): Promise<void> {
    const context = await this.options.auth.$context;
    const now = new Date().toISOString();
    const secret = await symmetricEncrypt({ key: context.secretConfig, data: await this.resourceClientSecret() });
    await this.options.store.commit([
      {
        sql: `insert into auth_oauth_client(id,client_id,name,disabled,client_secret,token_endpoint_auth_method,redirect_uris,scopes,grant_types,response_types,created_at,updated_at)
          values(?,?,?,false,?,'client_secret_post','[]','[]','[]','[]',?,?)
          on conflict(client_id) do update set client_secret=excluded.client_secret,updated_at=excluded.updated_at`,
        values: [randomUUID(), resourceClientId, "Connections Meetings resource server", secret, now, now],
      },
      {
        sql: `insert into auth_oauth_client(id,client_id,name,disabled,skip_consent,token_endpoint_auth_method,application_type,require_pkce,redirect_uris,scopes,grant_types,response_types,created_at,updated_at)
          values(?,?,?,false,false,'none','native',true,?,?,?, ?,?,?) on conflict(client_id) do nothing`,
        values: [
          randomUUID(),
          meetingsOAuthClientId,
          "Meetings desktop",
          JSON.stringify([meetingsOAuthRedirect]),
          JSON.stringify(meetingsOAuthScopes),
          JSON.stringify(["authorization_code", "refresh_token"]),
          JSON.stringify(["code"]),
          now,
          now,
        ],
      },
      {
        sql: `insert into auth_oauth_resource(id,identifier,name,allowed_scopes,access_token_ttl,disabled,policy_version,created_at,updated_at)
          values(?,?,'Meetings',?,300,false,1,?,?) on conflict(identifier) do nothing`,
        values: [randomUUID(), this.resource, JSON.stringify(meetingsOAuthScopes), now, now],
      },
      ...[meetingsOAuthClientId, resourceClientId].map((clientId) => ({
        sql: "insert into auth_oauth_client_resource(id,client_id,resource_id,created_at) values(?,?,?,?) on conflict(client_id,resource_id) do nothing",
        values: [randomUUID(), clientId, this.resource, now],
      })),
    ]);
  }

  async start(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    this.validateQuery(query);
    const session = await this.options.auth.api.getSession({ headers: request.headers });
    await this.ensureBinding(query, session?.user.emailVerified ? session.user.id : undefined);
    return this.handler("/oauth2/authorize", request, query);
  }

  async selection(oauthQuery: string, userId: string): Promise<MeetingsOAuthSelection> {
    const query = await this.verifyQuery(oauthQuery);
    const binding = await this.ensureBinding(query, userId);
    if (binding.user_id && binding.user_id !== userId) throw denied();
    return { referenceId: binding.id, workspaceId: binding.workspace_id };
  }

  async select(
    oauthQuery: string,
    userId: string,
    sessionId: string,
    workspaceId: string,
  ): Promise<MeetingsOAuthSelection> {
    const query = await this.verifyQuery(oauthQuery);
    const binding = await this.ensureBinding(query, userId);
    if (
      (binding.user_id && binding.user_id !== userId) ||
      (binding.workspace_id && binding.workspace_id !== workspaceId)
    )
      throw denied();
    if (binding.workspace_id) return { referenceId: binding.id, workspaceId: binding.workspace_id };
    const workspace = await resolveWorkspaceAccess(this.options.access, userId, workspaceId);
    const marker = randomUUID();
    try {
      await this.options.store.commit(
        [
          {
            sql: `insert into identity_mutation_checks(id,authorized) select ?,case when exists(
        select 1 from workspaces w join workspace_memberships wm on wm.workspace_id=w.id and wm.organization_id=w.organization_id
        join organization_memberships om on om.organization_id=w.organization_id and om.user_id=wm.user_id
        join auth_user u on u.id=wm.user_id join auth_session s on s.user_id=u.id
        where w.id=? and w.organization_id=? and wm.user_id=? and w.deleted_at is null
        and u.email_verified=true and s.id=? and s.expires_at>${this.options.store.currentTimeSQL}
      ) and exists(select 1 from meetings_oauth_bindings where id=? and workspace_id is null
        and (user_id is null or user_id=?) and revoked_at is null and expires_at>${this.options.store.currentTimeSQL}) then 1 else 0 end`,
            values: [marker, workspaceId, workspace.organizationId ?? "", userId, sessionId, binding.id, userId],
          },
          {
            sql: "update meetings_oauth_bindings set user_id=?,session_id=?,organization_id=?,workspace_id=?,expires_at=? where id=? and workspace_id is null",
            values: [
              userId,
              sessionId,
              workspace.organizationId ?? "",
              workspaceId,
              new Date(Date.now() + 30 * 86400000).toISOString(),
              binding.id,
            ],
          },
          { sql: "delete from identity_mutation_checks where id=?", values: [marker] },
        ],
        workspace.organizationId,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("identity_forbidden")) throw denied();
      throw error;
    }
    return { referenceId: binding.id, workspaceId };
  }

  async consent(request: Request, oauthQuery: string, userId: string, accept: boolean): Promise<Response> {
    const selection = await this.selection(oauthQuery, userId);
    if (!selection.workspaceId) throw denied();
    const query = await this.verifyQuery(oauthQuery);
    const current = await this.binding(selection.referenceId);
    if (current.session_id !== (await this.options.auth.api.getSession({ headers: request.headers }))?.session.id)
      throw denied();
    await this.authorize(userId, selection.referenceId, this.scopes(query.get("scope") ?? ""));
    if (!accept) await this.revokeBinding(selection.referenceId);
    const response = await this.handler(
      "/oauth2/consent",
      request,
      undefined,
      { oauth_query: oauthQuery, accept },
      selection.referenceId,
    );
    if (accept && response.ok) {
      const callback = new URL(z.object({ url: z.string() }).parse(await response.clone().json()).url);
      const code = callback.searchParams.get("code");
      if (callback.protocol !== "meetingly:" || callback.host !== "oauth" || callback.pathname !== "/callback" || !code)
        throw denied();
      const results = await this.options.store.commit(
        [
          {
            sql: "update meetings_oauth_bindings set authorization_code_hash=? where id=? and authorization_code_hash is null and revoked_at is null returning id",
            values: [createHash("sha256").update(code).digest("hex"), selection.referenceId],
          },
        ],
        current.organization_id ?? undefined,
      );
      if (!results[0]?.rows.length) {
        await this.revokeBinding(selection.referenceId);
        throw denied();
      }
    }
    return response;
  }

  async continue(request: Request, oauthQuery: string, userId: string): Promise<Response> {
    const selection = await this.selection(oauthQuery, userId);
    if (!selection.workspaceId) throw denied();
    const current = await this.binding(selection.referenceId);
    if (current.session_id !== (await this.options.auth.api.getSession({ headers: request.headers }))?.session.id)
      throw denied();
    return this.handler(
      "/oauth2/continue",
      request,
      undefined,
      { oauth_query: oauthQuery, postLogin: true },
      selection.referenceId,
    );
  }

  async token(request: Request, form: URLSearchParams): Promise<Response> {
    this.unique(form);
    if (
      form.get("client_id") !== meetingsOAuthClientId ||
      form.has("client_secret") ||
      form.has("workspaceId") ||
      form.has("organizationId")
    )
      throw denied();
    if (form.get("resource") !== this.resource) throw denied();
    const grant = form.get("grant_type");
    let referenceId: string | undefined;
    if (grant === "refresh_token") {
      const token = await this.findToken(form.get("refresh_token") ?? "", "refresh");
      referenceId = token.reference_id;
      await this.authorize(
        token.user_id,
        referenceId,
        this.scopes(form.get("scope") ?? "meetings:read meetings:write offline_access"),
      );
      if (token.rotated_at && Date.parse(token.rotated_at) + 30000 < Date.now()) {
        await this.revokeBinding(referenceId);
        throw denied();
      }
    } else if (grant === "authorization_code") {
      if (form.get("redirect_uri") !== meetingsOAuthRedirect) throw denied();
      const codeHash = createHash("sha256")
        .update(form.get("code") ?? "")
        .digest("hex");
      const rows = await this.options.store.read({
        sql: "select * from meetings_oauth_bindings where authorization_code_hash=?",
        values: [codeHash],
      });
      const binding = bindingSchema.safeParse(rows[0]);
      if (!binding.success || !binding.data.user_id) throw denied();
      referenceId = binding.data.id;
      await this.authorize(
        binding.data.user_id,
        referenceId,
        this.scopes(form.get("scope") ?? "meetings:read meetings:write offline_access"),
      );
      const claim = await this.options.store.commit(
        [
          {
            sql: "update meetings_oauth_bindings set code_redeemed_at=? where id=? and code_redeemed_at is null and revoked_at is null returning id",
            values: [new Date().toISOString(), referenceId],
          },
        ],
        binding.data.organization_id ?? undefined,
      );
      if (!claim[0]?.rows.length) {
        await this.revokeBinding(referenceId);
        throw denied();
      }
    } else throw denied();
    return this.handler("/oauth2/token", request, undefined, form, referenceId);
  }

  async revoke(request: Request, form: URLSearchParams): Promise<Response> {
    this.unique(form);
    if (form.get("client_id") !== meetingsOAuthClientId) throw denied();
    const secret = form.get("token") ?? "";
    try {
      const token = await this.findToken(secret, secret.startsWith(meetingsRefreshPrefix) ? "refresh" : "access");
      await this.revokeBinding(token.reference_id);
    } catch (error) {
      if (!(error instanceof HttpRequestError)) throw error;
    }
    return new Response(null, { status: 200 });
  }

  async verify(secret: string, requiredScope: "meetings:read" | "meetings:write"): Promise<MeetingsOAuthAccess> {
    const token = await this.findToken(secret, "access");
    await this.authorize(token.user_id, token.reference_id, [requiredScope]);
    const response = await this.handler(
      "/oauth2/introspect",
      new Request(this.issuer),
      undefined,
      new URLSearchParams({
        token: secret,
        client_id: resourceClientId,
        client_secret: await this.resourceClientSecret(),
      }),
      token.reference_id,
    );
    if (!response.ok) throw denied();
    const result = introspectionSchema.safeParse(await response.json());
    if (!result.success) throw denied();
    const claims = result.data;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== this.issuer ||
      audience.length !== 1 ||
      audience[0] !== this.resource ||
      claims.sub !== claims.userId ||
      claims.exp <= Date.now() / 1000
    )
      throw denied();
    const scopes = this.scopes(claims.scope);
    if (!scopes.includes(requiredScope))
      throw new HttpRequestError("insufficient_scope", "The Meetings grant lacks the required scope.", 403);
    const identity = await this.authorize(claims.userId, token.reference_id, scopes);
    if (identity.workspaceId !== claims.workspaceId || identity.organizationId !== claims.organizationId)
      throw denied();
    return { ...identity, referenceId: token.reference_id, tokenId: token.id, expiresAt: claims.exp, scopes };
  }

  private async authorize(userId: string, referenceId: string, scopes: string[]): Promise<MeetingsOAuthIdentity> {
    if (!scopes.length || scopes.some((scope) => !meetingsOAuthScopes.includes(scope))) throw denied();
    const binding = await this.binding(referenceId);
    if (
      binding.user_id !== userId ||
      !binding.workspace_id ||
      !binding.organization_id ||
      binding.revoked_at ||
      Date.parse(binding.expires_at) <= Date.now()
    )
      throw denied();
    const sessions = await this.options.store.read({
      sql: `select s.id from auth_session s join auth_user u on u.id=s.user_id
        where s.id=? and s.user_id=? and u.email_verified=true and s.expires_at>${this.options.store.currentTimeSQL}`,
      values: [binding.session_id, userId],
    });
    if (!sessions.length) throw denied();
    const workspace = await resolveWorkspaceAccess(this.options.access, userId, binding.workspace_id);
    if (workspace.organizationId !== binding.organization_id) throw denied();
    return { userId, organizationId: binding.organization_id, workspaceId: binding.workspace_id };
  }

  private async binding(referenceId: string): Promise<z.infer<typeof bindingSchema>> {
    const rows = await this.options.store.read({
      sql: "select * from meetings_oauth_bindings where id=?",
      values: [referenceId],
    });
    if (!rows[0]) throw denied();
    return bindingSchema.parse(rows[0]);
  }

  private async ensureBinding(query: URLSearchParams, userId?: string): Promise<z.infer<typeof bindingSchema>> {
    const hash = this.flowHash(query);
    await this.options.store.commit([
      {
        sql: "insert into meetings_oauth_bindings(id,flow_hash,user_id,expires_at) values(?,?,?,?) on conflict(flow_hash) do nothing",
        values: [randomUUID(), hash, userId ?? null, new Date(Date.now() + 600000).toISOString()],
      },
    ]);
    const rows = await this.options.store.read({
      sql: "select * from meetings_oauth_bindings where flow_hash=?",
      values: [hash],
    });
    const binding = bindingSchema.parse(rows[0]);
    if (
      binding.revoked_at ||
      Date.parse(binding.expires_at) <= Date.now() ||
      (userId && binding.user_id && binding.user_id !== userId)
    )
      throw denied();
    return binding;
  }

  private async revokeBinding(referenceId: string): Promise<void> {
    const binding = await this.binding(referenceId);
    await this.options.store.commit(
      [
        {
          sql: "update meetings_oauth_bindings set revoked_at=coalesce(revoked_at,?) where id=?",
          values: [new Date().toISOString(), referenceId],
        },
      ],
      binding.organization_id ?? undefined,
    );
  }

  private async resourceClientSecret(): Promise<string> {
    return createHmac("sha256", (await this.options.auth.$context).secret)
      .update(resourceClientId)
      .digest("base64url");
  }

  private async findToken(secret: string, kind: "access" | "refresh"): Promise<z.infer<typeof tokenSchema>> {
    const prefix = kind === "access" ? meetingsAccessPrefix : meetingsRefreshPrefix;
    if (!secret.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(secret.slice(prefix.length))) throw denied();
    const hash = createHash("sha256").update(secret.slice(prefix.length)).digest("base64url");
    const rows = await this.options.store.read({
      sql: `select * from ${kind === "access" ? "auth_oauth_access_token" : "auth_oauth_refresh_token"} where token=?`,
      values: [hash],
    });
    const result = tokenSchema.safeParse(rows[0]);
    if (
      !result.success ||
      result.data.client_id !== meetingsOAuthClientId ||
      Date.parse(result.data.expires_at) <= Date.now() ||
      (result.data.revoked && !(kind === "refresh" && result.data.rotated_at))
    )
      throw denied();
    return result.data;
  }

  private async verifyQuery(raw: string): Promise<URLSearchParams> {
    if (raw.length > 8192 || !(await verifyOAuthQueryParams(raw, (await this.options.auth.$context).secret)))
      throw denied();
    const query = new URLSearchParams(raw);
    this.validateQuery(query);
    return query;
  }

  private validateQuery(query: URLSearchParams): void {
    this.unique(query);
    if (
      query.get("response_type") !== "code" ||
      query.get("client_id") !== meetingsOAuthClientId ||
      query.get("redirect_uri") !== meetingsOAuthRedirect ||
      query.get("resource") !== this.resource ||
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") ||
      !/^[A-Za-z0-9_-]{20,200}$/.test(query.get("state") ?? "")
    )
      throw denied();
    this.scopes(query.get("scope") ?? "");
  }

  private scopes(raw: string): string[] {
    const scopes = raw.split(" ").filter(Boolean);
    if (!scopes.length || scopes.some((scope) => !meetingsOAuthScopes.includes(scope))) throw denied();
    return [...new Set(scopes)];
  }
  private unique(params: URLSearchParams): void {
    if ([...params.keys()].some((key) => key !== "ba_param" && params.getAll(key).length !== 1)) throw denied();
  }
  private flowHash(query: URLSearchParams): string {
    return createHash("sha256")
      .update(
        JSON.stringify(
          ["client_id", "redirect_uri", "state", "code_challenge", "resource", "scope"].map((key) => query.get(key)),
        ),
      )
      .digest("hex");
  }
  private handler(
    path: string,
    request: Request,
    query?: URLSearchParams,
    body?: object | URLSearchParams,
    referenceId?: string,
  ): Promise<Response> {
    const url = new URL(this.issuer + path);
    if (query) url.search = query.toString();
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (body instanceof URLSearchParams) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      headers.delete("cookie");
    } else if (body) headers.set("content-type", "application/json");
    headers.delete("content-length");
    return meetingsOAuthCalls.run(
      { referenceId, authorize: (userId, ref, scopes) => this.authorize(userId, ref, scopes) },
      () =>
        this.options.auth.handler(
          new Request(url, {
            method: body ? "POST" : "GET",
            headers,
            body: body instanceof URLSearchParams ? body.toString() : body ? JSON.stringify(body) : undefined,
          }),
        ),
    );
  }
}

function denied(): HttpRequestError {
  return new HttpRequestError("invalid_grant", "The Meetings authorization is invalid or no longer available.", 401);
}

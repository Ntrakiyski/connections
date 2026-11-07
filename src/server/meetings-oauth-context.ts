import type { OAuthOptions, Scope } from "@better-auth/oauth-provider";

import { APIError } from "better-auth/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { meetingsOAuthSchema } from "./meetings-oauth-schema.ts";

export const meetingsOAuthClientId = "meetings-desktop-v1";
export const meetingsOAuthRedirect = "meetingly://oauth/callback";
export const meetingsOAuthScopes: string[] = ["meetings:read", "meetings:write", "offline_access"];
export const meetingsAccessPrefix = "cma_";
export const meetingsRefreshPrefix = "cmr_";

export interface MeetingsOAuthIdentity {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

export interface MeetingsOAuthCall {
  referenceId?: string;
  authorize(userId: string, referenceId: string, scopes: string[]): Promise<MeetingsOAuthIdentity>;
}

/** Request-local consent context; a session's active company is never used for delegation. */
export const meetingsOAuthCalls: AsyncLocalStorage<MeetingsOAuthCall> = new AsyncLocalStorage<MeetingsOAuthCall>();

function currentCall(): MeetingsOAuthCall {
  const call = meetingsOAuthCalls.getStore();
  if (!call)
    throw new APIError("FORBIDDEN", {
      error: "invalid_grant",
      error_description: "Meetings authorization context is required.",
    });
  return call;
}

export function meetingsOAuthProviderOptions(origin: string): OAuthOptions<Scope[]> {
  return {
    schema: meetingsOAuthSchema,
    loginPage: "/desktop/connect",
    consentPage: "/desktop/connect",
    disableJwtPlugin: true,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    allowPublicClientPrelogin: false,
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: meetingsOAuthScopes,
    resources: [
      {
        identifier: `${origin}/api/meetings`,
        name: "Meetings",
        allowedScopes: meetingsOAuthScopes,
        accessTokenTtl: 300,
      },
    ],
    enforcePerClientResources: true,
    cachedTrustedClients: new Set([meetingsOAuthClientId]),
    accessTokenExpiresIn: 300,
    refreshTokenExpiresIn: 30 * 24 * 60 * 60,
    refreshTokenReuseInterval: 30,
    codeExpiresIn: 120,
    prefix: { opaqueAccessToken: meetingsAccessPrefix, refreshToken: meetingsRefreshPrefix },
    clientPrivileges: async () => false,
    resourcePrivileges: async () => false,
    postLogin: {
      page: "/desktop/connect",
      shouldRedirect: async ({ user, isContinuation }) => {
        if (!user.emailVerified) throw new APIError("FORBIDDEN", { error: "access_denied" });
        const call = currentCall();
        if (!isContinuation || !call.referenceId) return true;
        await call.authorize(user.id, call.referenceId, meetingsOAuthScopes);
        return false;
      },
      consentReferenceId: async ({ user }) => {
        const call = currentCall();
        if (!call.referenceId) throw new APIError("FORBIDDEN", { error: "invalid_grant" });
        await call.authorize(user.id, call.referenceId, meetingsOAuthScopes);
        return call.referenceId;
      },
    },
    customAccessTokenClaims: async ({ user, referenceId, scopes, resources }) => {
      if (!user?.emailVerified || !referenceId || resources?.length !== 1 || resources[0] !== `${origin}/api/meetings`)
        throw new APIError("FORBIDDEN", { error: "invalid_grant" });
      return currentCall().authorize(user.id, referenceId, scopes);
    },
    customTokenResponseFields: async ({ user, scopes, verificationValue }) => {
      const call = currentCall();
      const referenceId = verificationValue?.referenceId ?? call.referenceId;
      if (!user?.emailVerified || !referenceId) throw new APIError("FORBIDDEN", { error: "invalid_grant" });
      await call.authorize(user.id, referenceId, scopes);
      return { connections_contract: "meetings-v1" };
    },
  };
}

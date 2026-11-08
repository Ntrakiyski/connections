import type { BetterAuthOptions } from "better-auth";

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { betterAuthSchemaOptions } from "./auth-schema.ts";
import { meetingsOAuthProviderOptions } from "./meetings-oauth-context.ts";

export interface AuthMail {
  to: string;
  subject: string;
  text: string;
}

export interface AuthMailDelivery {
  (message: AuthMail): Promise<void>;
}

export interface HumanAuthConfig {
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  sendMail: AuthMailDelivery;
}

export type ConnectionsHumanAuth = ReturnType<typeof betterAuth>;

/** Uses the reviewed schema. Schema migration is a deployment step, never startup DDL. */
export function createHumanAuth(
  config: HumanAuthConfig,
  database: BetterAuthOptions["database"],
): ConnectionsHumanAuth {
  if (!database) throw new Error("A supported authentication database is required.");
  if (config.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  const origin = new URL(config.baseURL).origin;
  const trustedOrigins = [...new Set([origin, ...config.trustedOrigins])];
  for (const allowed of trustedOrigins) {
    if (new URL(allowed).origin !== allowed) throw new Error("Trusted authentication origins must be exact origins.");
  }
  const options: BetterAuthOptions = {
    ...betterAuthSchemaOptions,
    plugins: [...(betterAuthSchemaOptions.plugins ?? []), oauthProvider(meetingsOAuthProviderOptions(origin))],
    database,
    baseURL: config.baseURL,
    basePath: "/api/identity",
    secret: config.secret,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await config.sendMail({
          to: user.email,
          subject: "Reset your Connections password",
          text: `Reset your password: ${url}`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await config.sendMail({
          to: user.email,
          subject: "Verify your Connections email",
          text: `Verify your email: ${url}`,
        });
      },
    },
    session: {
      ...betterAuthSchemaOptions.session,
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: new URL(config.baseURL).protocol === "https:",
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
  };
  return betterAuth(options);
}

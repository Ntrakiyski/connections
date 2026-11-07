import type { BetterAuthOptions } from "better-auth";

import { organization } from "better-auth/plugins";

/** Schema ownership only; issue #5 mounts and configures the human session handler. */
export const betterAuthSchemaOptions: BetterAuthOptions = {
  user: {
    modelName: "auth_user",
    fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
  },
  session: {
    modelName: "auth_session",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
    },
  },
  account: {
    modelName: "auth_account",
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "auth_verification",
    fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
  },
  plugins: [
    organization({
      schema: {
        organization: { modelName: "organizations", fields: { createdAt: "created_at" } },
        member: {
          modelName: "organization_memberships",
          fields: { organizationId: "organization_id", userId: "user_id", createdAt: "created_at" },
        },
        invitation: {
          modelName: "organization_invitations",
          fields: {
            organizationId: "organization_id",
            expiresAt: "expires_at",
            createdAt: "created_at",
            inviterId: "inviter_id",
          },
        },
        session: { fields: { activeOrganizationId: "active_organization_id" } },
      },
    }),
  ],
};

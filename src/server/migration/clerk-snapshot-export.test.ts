import { createClerkClient } from "@clerk/backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportClerkSnapshot } from "./clerk-snapshot-export.ts";
import { clerkSnapshotSchema } from "./clerk-snapshot.ts";

const createdAt = Date.parse("2026-07-15T00:00:00.000Z");
const organization = {
  object: "organization",
  id: "org_alpha",
  name: "Alpha",
  slug: "alpha",
  created_at: createdAt,
  updated_at: createdAt,
  public_metadata: {},
  private_metadata: { secret: "organization-private-secret" },
  max_allowed_memberships: 10,
  admin_delete_enabled: true,
};
const users = Array.from({ length: 101 }, (_, index) => ({
  object: "user",
  id: `user_${index}`,
  first_name: "User",
  last_name: String(index),
  username: null,
  primary_email_address_id: `email_${index}`,
  email_addresses: [
    {
      object: "email_address",
      id: `email_${index}`,
      email_address: `user-${index}@example.test`,
      verification: { status: "verified", strategy: "email_code" },
      linked_to: [],
    },
  ],
  phone_numbers: [],
  web3_wallets: [],
  external_accounts: [
    {
      object: "external_account",
      id: `external_${index}`,
      provider: "oauth_google",
      verification: { status: "verified" },
      access_token: "external-access-secret",
    },
  ],
  saml_accounts: [],
  passkeys: [{ id: "passkey-secret-id", public_key: "passkey-factor-secret" }],
  password_enabled: true,
  two_factor_enabled: false,
  totp_enabled: false,
  backup_code_enabled: false,
  banned: false,
  locked: false,
  created_at: createdAt,
  updated_at: createdAt,
  public_metadata: {},
  private_metadata: { password_hash: "source-password-hash-secret", mfa_seed: "source-mfa-seed-secret" },
  unsafe_metadata: { secret: "unsafe-metadata-secret" },
}));
afterEach(() => vi.unstubAllGlobals());
function transport(changeCount = false): string[] {
  const paths: string[] = [];
  let counts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      paths.push(url.pathname);
      expect(request.method).toBe("GET");
      if (url.pathname === "/v1/instance")
        return Response.json({
          object: "instance",
          id: "ins_actual_key_instance",
          environment_type: "development",
          allowed_origins: [],
        });
      if (url.pathname === "/v1/users/count")
        return Response.json({ object: "total_count", total_count: changeCount && counts++ > 0 ? 102 : 101 });
      if (url.pathname === "/v1/users") {
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(users.slice(offset, offset + 100));
      }
      if (url.pathname === "/v1/organizations") return Response.json({ data: [organization], total_count: 1 });
      if (url.pathname.endsWith("/memberships"))
        return Response.json({
          data: [
            {
              object: "organization_membership",
              id: "orgmem_source",
              role: "org:admin",
              permissions: [],
              created_at: createdAt,
              updated_at: createdAt,
              organization,
              public_user_data: {
                user_id: "user_0",
                identifier: "user-0@example.test",
                first_name: "User",
                last_name: "0",
                image_url: "",
                has_image: false,
              },
              public_metadata: {},
              private_metadata: { secret: "membership-private-secret" },
            },
          ],
          total_count: 1,
        });
      if (url.pathname.endsWith("/invitations"))
        return Response.json({
          data: [
            {
              object: "organization_invitation",
              id: "orginv_source",
              organization_id: "org_alpha",
              email_address: "invite@example.test",
              role: "org:member",
              role_name: "Member",
              status: "pending",
              created_at: createdAt,
              updated_at: createdAt,
              expires_at: createdAt + 86400000,
              url: "https://clerk.invalid/?__clerk_ticket=invitation-ticket-secret",
              public_metadata: {},
              private_metadata: { secret: "invitation-private-secret" },
            },
          ],
          total_count: 1,
        });
      throw new Error("Unexpected SDK request path.");
    }),
  );
  return paths;
}
describe("Clerk read-only source export", () => {
  it("uses the real SDK pagination/instance and excludes credentials, factor material and invitation links", async () => {
    const paths = transport();
    const source = await exportClerkSnapshot(createClerkClient({ secretKey: "sk_test_synthetic_export_key" }));
    expect(source.sourceInstance).toBe("ins_actual_key_instance");
    expect(source.users).toHaveLength(101);
    expect(paths.filter((path) => path === "/v1/users")).toHaveLength(2);
    expect(source.memberships).toEqual([
      {
        id: "orgmem_source",
        organizationId: "org_alpha",
        userId: "user_0",
        role: "org:admin",
        createdAt: new Date(createdAt).toISOString(),
      },
    ]);
    expect(source.users[0]?.signInMethods).toEqual(["external", "passkey", "password"]);
    const output = JSON.stringify(source);
    for (const secret of [
      "source-password-hash-secret",
      "source-mfa-seed-secret",
      "external-access-secret",
      "passkey-factor-secret",
      "invitation-ticket-secret",
      "organization-private-secret",
      "membership-private-secret",
      "invitation-private-secret",
      "unsafe-metadata-secret",
    ])
      expect(output).not.toContain(secret);
    expect(
      clerkSnapshotSchema.safeParse({ ...source, privateMetadata: { secret: "must-not-enter-snapshot" } }).success,
    ).toBe(false);
  });
  it("stops when source counts change while paginating", async () => {
    transport(true);
    await expect(exportClerkSnapshot(createClerkClient({ secretKey: "sk_test_synthetic_export_key" }))).rejects.toThrow(
      "Source count changed",
    );
  });
});

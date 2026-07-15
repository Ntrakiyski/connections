import { describe, expect, it } from "vitest";
import { readClerkOrganization } from "./clerk-auth.ts";

describe("readClerkOrganization", () => {
  it("reads Clerk's current compact version-2 organization claim", () => {
    expect(readClerkOrganization({ o: { id: "org_current", rol: "admin" } })).toEqual({
      id: "org_current",
      role: "org:admin",
    });
  });

  it("keeps support for the legacy organization claims", () => {
    expect(readClerkOrganization({ org_id: "org_legacy", org_role: "org:member" })).toEqual({
      id: "org_legacy",
      role: "org:member",
    });
  });
});

import { describe, expect, it } from "vitest";
import { normalizePostgresConnectionString } from "./postgres-config.ts";

describe("normalizePostgresConnectionString", () => {
  it.each(["prefer", "require", "verify-ca"])("uses explicit verify-full TLS for sslmode=%s", (sslmode) => {
    expect(normalizePostgresConnectionString(`postgresql://db.example.test/connections?sslmode=${sslmode}`)).toBe(
      "postgresql://db.example.test/connections?sslmode=verify-full",
    );
  });

  it("keeps an already explicit TLS mode and URLs without a TLS mode unchanged", () => {
    expect(normalizePostgresConnectionString("postgresql://db.example.test/connections?sslmode=verify-full")).toBe(
      "postgresql://db.example.test/connections?sslmode=verify-full",
    );
    expect(normalizePostgresConnectionString("postgresql://db.example.test/connections")).toBe(
      "postgresql://db.example.test/connections",
    );
  });
});

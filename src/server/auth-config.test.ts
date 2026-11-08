import { describe, expect, it } from "vitest";
import { readDeploymentAuthSettings } from "./auth-config.ts";

const configured = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "synthetic-test-authentication-secret-with-32-characters",
  BETTER_AUTH_URL: "https://connections.example.test",
  DATABASE_URL: "postgresql://synthetic@localhost/fixture",
  OOMOL_CONNECT_ENCRYPTION_KEY: "synthetic-encryption-key",
  SMTP_URL: "smtp://localhost:1025",
  SMTP_FROM: "Connections <noreply@example.test>",
};

describe("hosted authentication startup configuration", () => {
  it("requires server-only auth, PostgreSQL, encryption and delivery settings", () => {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "OOMOL_CONNECT_ENCRYPTION_KEY",
      "SMTP_URL",
      "SMTP_FROM",
    ]) {
      expect(() => readDeploymentAuthSettings({ ...configured, [key]: undefined })).toThrow(`${key} is required.`);
    }
    expect(readDeploymentAuthSettings(configured)).toMatchObject({
      kind: "sessions",
      trustedOrigins: [configured.BETTER_AUTH_URL],
    });
  });

  it("supports explicit Resend HTTPS delivery without SMTP and requires its key", () => {
    const env = {
      ...configured,
      AUTH_MAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "synthetic-resend-key",
      SMTP_URL: undefined,
    };
    expect(readDeploymentAuthSettings(env)).toMatchObject({ mail: { kind: "resend", apiKey: "synthetic-resend-key" } });
    expect(() => readDeploymentAuthSettings({ ...env, RESEND_API_KEY: undefined })).toThrow(
      "RESEND_API_KEY is required.",
    );
    expect(() => readDeploymentAuthSettings({ ...configured, AUTH_MAIL_TRANSPORT: "unknown" })).toThrow(
      "must be smtp or resend",
    );
  });

  it("rejects mismatched origins, weak secrets and public production bypasses", () => {
    expect(() =>
      readDeploymentAuthSettings({ ...configured, OOMOL_CONNECT_ORIGIN: "https://other.example.test" }),
    ).toThrow("must agree");
    expect(() => readDeploymentAuthSettings({ ...configured, BETTER_AUTH_SECRET: "short" })).toThrow("32 characters");
    expect(() => readDeploymentAuthSettings({ ...configured, CONNECTIONS_DEV_AUTH_BYPASS: "true" })).toThrow(
      "loopback",
    );
    expect(() =>
      readDeploymentAuthSettings({
        ...configured,
        NODE_ENV: "development",
        HOST: "0.0.0.0",
        CONNECTIONS_DEV_AUTH_BYPASS: "true",
      }),
    ).toThrow("loopback");
    expect(() =>
      readDeploymentAuthSettings({ ...configured, BETTER_AUTH_URL: "http://connections.example.test" }),
    ).toThrow("HTTPS");
  });

  it("allows only an explicit loopback development bypass", () => {
    expect(
      readDeploymentAuthSettings({ NODE_ENV: "development", HOST: "127.0.0.1", CONNECTIONS_DEV_AUTH_BYPASS: "true" }),
    ).toEqual({ kind: "development-bypass" });
  });
});

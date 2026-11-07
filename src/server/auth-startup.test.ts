import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configured = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "synthetic-startup-auth-secret-at-least-32-characters",
  BETTER_AUTH_URL: "https://connections.example.test",
  DATABASE_URL: "postgresql://synthetic@localhost/fixture",
  OOMOL_CONNECT_ENCRYPTION_KEY: "synthetic-encryption-key",
  SMTP_URL: "smtp://localhost:1025",
  SMTP_FROM: "Connections <noreply@example.test>",
  CONNECTIONS_DEV_AUTH_BYPASS: "false",
  OOMOL_CONNECT_ORIGIN: "https://connections.example.test",
};

describe("Node authentication entry point", () => {
  it("exits before opening a listener or initializing data when hosted configuration is incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "connections-startup-"));
    try {
      for (const key of [
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "DATABASE_URL",
        "OOMOL_CONNECT_ENCRYPTION_KEY",
        "SMTP_URL",
        "SMTP_FROM",
      ]) {
        const dataDir = join(directory, key);
        const env = { ...process.env, ...configured, OOMOL_CONNECT_DATA_DIR: dataDir, [key]: undefined };
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
          env,
          encoding: "utf8",
          timeout: 10000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${key} is required.`);
        expect(result.stdout).not.toContain("listening");
        expect(existsSync(dataDir)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
});

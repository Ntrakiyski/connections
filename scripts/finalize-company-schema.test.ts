import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

it("does not expose credentials when finalization configuration is malformed", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./finalize-company-schema.ts", import.meta.url).pathname, "--dry-run"],
    {
      env: { ...process.env, DATABASE_URL: "postgresql://operator:synthetic-private-secret@[" },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No database parameters are printed");
  expect(result.stderr).not.toContain("synthetic-private-secret");
});

describe.skipIf(!process.env.CONNECTIONS_TEST_POSTGRES_URL)("guarded PostgreSQL company schema finalization", () => {
  async function fixture(): Promise<{ pool: Pool; url: string; close: () => Promise<void> }> {
    const connectionString = process.env.CONNECTIONS_TEST_POSTGRES_URL;
    if (!connectionString) throw new Error("Disposable PostgreSQL connection required");
    const schema = "finalize_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const file of [
      "../connections-docs/insforge-schema.sql",
      "../migrations/20261107200000_organization-identity.sql",
      "../migrations/20261107210000_identity-governance.sql",
      "../migrations/20261107220000_identity-import.sql",
    ]) {
      await pool.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    }
    await pool.query(
      "insert into auth_user(id,name,email,email_verified,created_at,updated_at) values('owner','Synthetic owner','owner@example.test',true,now(),now()); insert into organizations(id,name,slug,created_at) values('A','Synthetic A','synthetic-a',now()); insert into organization_memberships(id,organization_id,user_id,role,created_at) values('owner-A','A','owner','owner',now()); insert into workspaces(id,clerk_org_id,organization_id,name,created_at,updated_at) values('A1','connections-workspace:A1','A','A1','2026-11-08','2026-11-08'); insert into workspace_memberships(workspace_id,organization_id,user_id,role,created_at,updated_at) values('A1','A','owner','admin','2026-11-08','2026-11-08')",
    );
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return {
      pool,
      url: url.href,
      close: async () => {
        await pool.end();
        await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
      },
    };
  }
  it("previews without writes and finalizes only the verified, owned company schema", async () => {
    const f = await fixture();
    try {
      const run = (args: string[]) =>
        spawnSync(process.execPath, [new URL("./finalize-company-schema.ts", import.meta.url).pathname, ...args], {
          env: { ...process.env, DATABASE_URL: f.url },
          encoding: "utf8",
          timeout: 10000,
        });
      const preview = run(["--dry-run"]);
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ status: "ready" });
      expect(
        (
          await f.pool.query(
            "select is_nullable from information_schema.columns where table_schema=current_schema() and table_name='workspaces' and column_name='organization_id'",
          )
        ).rows[0],
      ).toEqual({ is_nullable: "YES" });
      const apply = run(["--apply", "--maintenance"]);
      expect(apply.status).toBe(0);
      expect(JSON.parse(apply.stdout)).toMatchObject({ status: "finalized" });
      await expect(
        f.pool.query(
          "insert into workspaces(id,clerk_org_id,name,created_at,updated_at) values('unmapped','org-unmapped','Unmapped','2026-11-08','2026-11-08')",
        ),
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await f.close();
    }
  });
  it("blocks an unmapped legacy workspace without tightening or changing its ownership", async () => {
    const f = await fixture();
    try {
      await f.pool.query(
        "insert into workspaces(id,clerk_org_id,name,created_at,updated_at) values('unmapped','org-unmapped','Unmapped','2026-11-08','2026-11-08')",
      );
      const result = spawnSync(
        process.execPath,
        [new URL("./finalize-company-schema.ts", import.meta.url).pathname, "--apply", "--maintenance"],
        { env: { ...process.env, DATABASE_URL: f.url }, encoding: "utf8", timeout: 10000 },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        counts: { unmapped_workspaces: 1, unverified_legacy_workspaces: 1 },
      });
      expect((await f.pool.query("select organization_id from workspaces where id='unmapped'")).rows[0]).toEqual({
        organization_id: null,
      });
      expect(
        (
          await f.pool.query(
            "select is_nullable from information_schema.columns where table_schema=current_schema() and table_name='workspaces' and column_name='organization_id'",
          )
        ).rows[0],
      ).toEqual({ is_nullable: "YES" });
    } finally {
      await f.close();
    }
  });
});

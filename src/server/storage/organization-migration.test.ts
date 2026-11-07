import type { BetterAuthOptions } from "better-auth";

import { getAuthTables } from "@better-auth/core/db";
import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaOptions } from "../auth-schema.ts";

interface MigrationFixture {
  database: BetterAuthOptions["database"];
  exec(sql: string): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  expand(): Promise<void>;
  close(): Promise<void>;
  timestamp: string;
  columns(): Promise<Record<string, unknown>[]>;
}

const sqliteDirectory = new URL("../../../sqlite-migrations/", import.meta.url);
const expansion = "0009_organization_identity.sql";
const postgresExpansion = new URL("../../../migrations/20261107200000_organization-identity.sql", import.meta.url);
const postgresUrl = process.env.CONNECTIONS_TEST_POSTGRES_URL;

async function createSqliteFixture(): Promise<MigrationFixture> {
  const database = new DatabaseSync(":memory:");
  database.exec("pragma foreign_keys=on");
  for (const filename of readdirSync(sqliteDirectory)
    .filter((name) => name.endsWith(".sql") && name < expansion)
    .sort()) {
    database.exec(readFileSync(new URL(filename, sqliteDirectory), "utf8"));
  }
  return {
    database,
    timestamp: "'2026-07-15T00:00:00.000Z'",
    async exec(sql) {
      database.exec(sql);
    },
    async rows(sql) {
      return database.prepare(sql).all();
    },
    async expand() {
      database.exec("begin");
      try {
        database.exec(readFileSync(new URL(expansion, sqliteDirectory), "utf8"));
        database.exec("commit");
      } catch (error) {
        database.exec("rollback");
        throw error;
      }
    },
    async columns() {
      return database
        .prepare(
          "select m.name as table_name, p.name as column_name from sqlite_master m join pragma_table_info(m.name) p where m.type='table'",
        )
        .all();
    },
    async close() {
      database.close();
    },
  };
}

async function createPostgresFixture(): Promise<MigrationFixture> {
  const schema = `organization_test_${randomUUID().replaceAll("-", "")}`;
  const owner = new Pool({ connectionString: postgresUrl });
  await owner.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema},public` });
  await pool.query(readFileSync(new URL("../../../connections-docs/insforge-schema.sql", import.meta.url), "utf8"));
  // Simulate a hosted database whose defaults would otherwise expose new tables.
  await pool.query(`alter default privileges in schema ${schema} grant all on tables to public`);
  return {
    database: pool,
    timestamp: "'2026-07-15T00:00:00.000Z'",
    async exec(sql) {
      await pool.query(sql);
    },
    async rows(sql) {
      return (await pool.query(sql)).rows;
    },
    async expand() {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(readFileSync(postgresExpansion, "utf8"));
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async columns() {
      return (
        await pool.query(
          "select table_name,column_name from information_schema.columns where table_schema=current_schema()",
        )
      ).rows;
    },
    async close() {
      await pool.end();
      await owner.query(`drop schema ${schema} cascade`);
      await owner.end();
    },
  };
}

function migrationContract(adapter: string, create: () => Promise<MigrationFixture>): void {
  describe(adapter, () => {
    it("supports real Better Auth identity, password account and session persistence", async () => {
      const fixture = await create();
      try {
        await fixture.expand();
        const auth = betterAuth({
          ...betterAuthSchemaOptions,
          database: fixture.database,
          baseURL: "http://localhost:3000",
          secret: "synthetic-schema-fixture-secret-at-least-32-characters",
          emailAndPassword: { enabled: true },
          logger: { disabled: true },
          telemetry: { enabled: false },
        });
        const body = { name: "Schema fixture", email: "schema@example.test", password: "synthetic-password-12345" };
        const created = await auth.api.signUpEmail({ body });
        expect(created.user.emailVerified).toBe(false);
        expect(created.user.createdAt).toBeInstanceOf(Date);
        const signedIn = await auth.api.signInEmail({ body });
        expect(signedIn.user.id).toBe(created.user.id);
        expect(signedIn.user.createdAt).toBeInstanceOf(Date);
        expect(await fixture.rows("select user_id,provider_id from auth_account")).toEqual([
          { user_id: created.user.id, provider_id: "credential" },
        ]);
        expect(await fixture.rows("select user_id from auth_session")).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    });
    it("expands fresh databases with every field in the pinned Better Auth schema", async () => {
      const fixture = await create();
      try {
        await fixture.expand();
        const columns = await fixture.columns();
        for (const table of Object.values(getAuthTables(betterAuthSchemaOptions))) {
          const expected = ["id", ...Object.entries(table.fields).map(([name, field]) => field.fieldName ?? name)];
          for (const column of expected) {
            expect(columns).toContainEqual({ table_name: table.modelName, column_name: column });
          }
        }
      } finally {
        await fixture.close();
      }
    });

    it("preserves populated workspace IDs, owner keys, roles and revoked token hashes", async () => {
      const fixture = await create();
      try {
        await fixture.exec(`
          insert into workspaces(id,clerk_org_id,name,created_at,updated_at)
            values('legacy','clerk-A','Original','time','time');
          insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at)
            values('legacy','original-user','manager','time','time');
          insert into connections(workspace_id,service,connection_name,label,value,created_by,updated_at)
            values('legacy','synthetic','same-label','same-label','encrypted-sentinel','original-user','time');
          insert into runtime_tokens(id,workspace_id,user_id,name,token_hash,created_at,revoked_at)
            values('revoked','legacy','original-user','agent','original-hash','time','revoked-time');
        `);
        const connections = await fixture.rows("select * from connections");
        const tokens = await fixture.rows("select * from runtime_tokens");
        await fixture.expand();
        expect(await fixture.rows("select * from connections")).toEqual(connections);
        expect(await fixture.rows("select * from runtime_tokens")).toEqual(tokens);
        expect(await fixture.rows("select id,clerk_org_id,organization_id from workspaces")).toEqual([
          { id: "legacy", clerk_org_id: "clerk-A", organization_id: null },
        ]);
        expect(await fixture.rows("select user_id,role,organization_id from workspace_memberships")).toEqual([
          { user_id: "original-user", role: "manager", organization_id: null },
        ]);
        expect(await fixture.rows("select * from auth_user")).toEqual([]);
      } finally {
        await fixture.close();
      }
    });

    it("rejects duplicate company memberships, cross-company grants, NULL bypasses and reparenting", async () => {
      const fixture = await create();
      try {
        await fixture.expand();
        await seedCompanies(fixture);
        await expect(
          fixture.exec(
            `insert into organization_memberships(id,organization_id,user_id,role,created_at) values('duplicate','A','operator','member',${fixture.timestamp})`,
          ),
        ).rejects.toThrow();
        await expect(
          fixture.exec(
            "insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at,organization_id) values('A1','B-only','member','time','time','A')",
          ),
        ).rejects.toThrow();
        await expect(
          fixture.exec(
            "insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at,organization_id) values('A1','operator','member','time','time','B')",
          ),
        ).rejects.toThrow();
        await expect(
          fixture.exec(
            "insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at) values('A1','operator','member','time','time')",
          ),
        ).rejects.toThrow();
        await fixture.exec(
          "insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at,organization_id) values('A1','operator','manager','time','time','A')",
        );
        await expect(
          fixture.exec("update workspace_memberships set organization_id=null where workspace_id='A1'"),
        ).rejects.toThrow();
        await expect(fixture.exec("update workspaces set organization_id='B' where id='A1'")).rejects.toThrow();
        await expect(fixture.exec("update workspaces set organization_id=null where id='A1'")).rejects.toThrow();
        expect(
          await fixture.rows(
            "select organization_id,role from organization_memberships where user_id='operator' order by organization_id",
          ),
        ).toEqual([
          { organization_id: "A", role: "owner" },
          { organization_id: "B", role: "member" },
        ]);
        expect(await fixture.rows("select id from workspaces where organization_id='A' order by id")).toEqual([
          { id: "A1" },
          { id: "A2" },
        ]);
        // Directory membership alone did not create a grant in A2 or B1.
        expect(await fixture.rows("select workspace_id from workspace_memberships where user_id='operator'")).toEqual([
          { workspace_id: "A1" },
        ]);
      } finally {
        await fixture.close();
      }
    });

    it("binds verified legacy mappings atomically and cascades company removal only in that company", async () => {
      const fixture = await create();
      try {
        await fixture.expand();
        await seedCompanies(fixture);
        await fixture.exec(`
          insert into workspaces(id,clerk_org_id,name,created_at,updated_at) values('legacy','legacy-clerk','Legacy','time','time');
          insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at) values('legacy','operator','admin','time','time');
        `);
        await expect(fixture.exec("update workspaces set organization_id='A' where id='legacy'")).rejects.toThrow();
        await fixture.exec(`begin;
          update workspace_memberships set organization_id='A' where workspace_id='legacy';
          update workspaces set organization_id='A' where id='legacy';
          commit;
        `);
        await fixture.exec(`
          insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at,organization_id) values('A2','operator','member','time','time','A');
          insert into workspace_memberships(workspace_id,user_id,role,created_at,updated_at,organization_id) values('B1','operator','admin','time','time','B');
          delete from organization_memberships where organization_id='A' and user_id='operator';
        `);
        expect(
          await fixture.rows("select workspace_id,role from workspace_memberships where user_id='operator'"),
        ).toEqual([{ workspace_id: "B1", role: "admin" }]);
        expect(
          await fixture.rows("select organization_id from organization_memberships where user_id='operator'"),
        ).toEqual([{ organization_id: "B" }]);
      } finally {
        await fixture.close();
      }
    });
  });
}

async function seedCompanies(fixture: MigrationFixture): Promise<void> {
  const time = fixture.timestamp;
  await fixture.exec(`
    insert into auth_user(id,name,email,email_verified,created_at,updated_at) values
      ('operator','Operator','operator@example.test',true,${time},${time}),
      ('B-only','Employee','employee@example.test',true,${time},${time});
    insert into organizations(id,name,slug,created_at) values('A','Company A','company-a',${time}),('B','Company B','company-b',${time});
    insert into organization_memberships(id,organization_id,user_id,role,created_at) values
      ('operator-A','A','operator','owner',${time}),('operator-B','B','operator','member',${time}),('employee-B','B','B-only','member',${time});
    insert into workspaces(id,clerk_org_id,name,created_at,updated_at,organization_id) values
      ('A1','connections-workspace:A1','A1','time','time','A'),
      ('A2','connections-workspace:A2','A2','time','time','A'),
      ('B1','connections-workspace:B1','B1','time','time','B');
  `);
}

migrationContract("SQLite / D1 migration SQL", createSqliteFixture);
describe.skipIf(!postgresUrl)("PostgreSQL migration SQL (CONNECTIONS_TEST_POSTGRES_URL)", () => {
  migrationContract("PostgreSQL", createPostgresFixture);
  it("keeps identity and company tables private despite permissive default grants", async () => {
    const fixture = await createPostgresFixture();
    try {
      await fixture.expand();
      const tableNames = Object.values(getAuthTables(betterAuthSchemaOptions)).map((table) => table.modelName);
      const tables = await fixture.rows(
        "select relname,relrowsecurity from pg_class where relnamespace=current_schema()::regnamespace",
      );
      for (const name of tableNames) expect(tables).toContainEqual({ relname: name, relrowsecurity: true });
      const exposed = await fixture.rows(
        "select table_name from information_schema.table_privileges where table_schema=current_schema() and grantee in ('PUBLIC','anon','authenticated')",
      );
      expect(exposed.filter((row) => tableNames.includes(String(row.table_name)))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

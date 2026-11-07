import type { IClerkImportStore } from "../migration/clerk-import-store.ts";
import type { RuntimeDatabase } from "../storage/runtime-database.ts";
import type { FixtureSql } from "./two-company.ts";
import type { BetterAuthOptions } from "better-auth";

import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { createD1AuthDatabase } from "../cloudflare/d1-auth-database.ts";
import {
  D1ClerkImportStore,
  PostgresClerkImportStore,
  SqliteClerkImportStore,
} from "../migration/clerk-import-store.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { D1RuntimeDatabase } from "../storage/d1-runtime-store.ts";
import { PostgresRuntimeDatabase } from "../storage/postgres-runtime-store.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { FixtureD1Database } from "./sqlite-d1.ts";
export interface FixtureDatabase {
  database: RuntimeDatabase;
  importStore: IClerkImportStore;
  authDatabase: BetterAuthOptions["database"];
  sql: FixtureSql;
  close(): Promise<void>;
}
const postgresUrl = process.env.CONNECTIONS_TEST_POSTGRES_URL;

export async function createFixtureDatabase(adapter: string): Promise<FixtureDatabase> {
  const codec = new AesGcmSecretCodec("synthetic-fixture-key");
  if (adapter === "D1") {
    const binding = new FixtureD1Database();
    return {
      database: new D1RuntimeDatabase(binding, { secretCodec: codec }),
      importStore: new D1ClerkImportStore(binding),
      authDatabase: createD1AuthDatabase(binding),
      sql: {
        write: async (sql, values) => {
          binding.sqlite.prepare(sql).run(...values);
        },
        placeholder: () => "?",
        authTimestamp: "2026-07-15T00:00:00.000Z",
        verifiedBoolean: 1,
      },
      close: async () => {
        binding.sqlite.close();
      },
    };
  }
  if (adapter === "PostgreSQL") {
    const schema = `fixture_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`create schema ${schema}`);
    const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    try {
      await pool.query(readFileSync(new URL("../../../connections-docs/insforge-schema.sql", import.meta.url), "utf8"));
      const directory = new URL("../../../migrations/", import.meta.url);
      for (const name of readdirSync(directory)
        .filter(
          (name) =>
            name.includes("organization-identity") ||
            name.includes("identity-governance") ||
            name.includes("identity-import") ||
            name.includes("workspace-safety-settings"),
        )
        .sort()) {
        await pool.query(readFileSync(new URL(name, directory), "utf8"));
      }
    } catch (error) {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
      throw error;
    }
    return {
      database: new PostgresRuntimeDatabase(pool, codec),
      importStore: new PostgresClerkImportStore(pool),
      authDatabase: pool,
      sql: {
        write: async (sql, values) => {
          await pool.query(sql, values);
        },
        placeholder: (index) => `$${index}`,
        authTimestamp: "2026-07-15T00:00:00.000Z",
        verifiedBoolean: true,
      },
      close: async () => {
        await pool.end();
        await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
      },
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "connections-fixture-"));
  const path = join(directory, "fixture.sqlite");
  const database = new SqliteRuntimeDatabase(path, { secretCodec: codec });
  const raw = new DatabaseSync(path);
  raw.exec("pragma foreign_keys = on");
  return {
    database,
    importStore: new SqliteClerkImportStore(raw),
    authDatabase: raw,
    sql: {
      write: async (sql, values) => {
        raw.prepare(sql).run(...values);
      },
      placeholder: () => "?",
      authTimestamp: "2026-07-15T00:00:00.000Z",
      verifiedBoolean: 1,
    },
    close: async () => {
      raw.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

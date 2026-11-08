import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { IdentityStatement, IdentityMutationResult } from "../storage/identity-mutations.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

import {
  D1IdentityMutationStore,
  PostgresIdentityMutationStore,
  SqliteIdentityMutationStore,
} from "../storage/identity-mutations.ts";

export interface IClerkImportStore {
  read(statement: IdentityStatement): Promise<Record<string, unknown>[]>;
  commitImport(statements: IdentityStatement[], tables: readonly string[]): Promise<IdentityMutationResult[]>;
}

export class PostgresClerkImportStore implements IClerkImportStore {
  private readonly pool: Pool;
  private readonly reader: PostgresIdentityMutationStore;
  constructor(pool: Pool) {
    this.pool = pool;
    this.reader = new PostgresIdentityMutationStore(pool);
  }
  read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return this.reader.read(statement);
  }
  async commitImport(statements: IdentityStatement[], tables: readonly string[]): Promise<IdentityMutationResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identifiers = [...tables, "identity_mutation_checks"].sort().map(importSqlIdentifier);
      await client.query(`lock table ${identifiers.join(",")} in share row exclusive mode`);
      const results: IdentityMutationResult[] = [];
      for (const statement of statements) {
        let index = 0;
        const result = await client.query(
          statement.sql.replaceAll("?", () => `$${++index}`),
          statement.values,
        );
        results.push({ rows: result.rows, changes: result.rowCount ?? 0 });
      }
      await client.query("commit");
      return results;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class SqliteClerkImportStore implements IClerkImportStore {
  private readonly store: SqliteIdentityMutationStore;
  constructor(database: DatabaseSync) {
    this.store = new SqliteIdentityMutationStore(database);
  }
  read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return this.store.read(statement);
  }
  commitImport(statements: IdentityStatement[]): Promise<IdentityMutationResult[]> {
    return this.store.commit(statements);
  }
}

export class D1ClerkImportStore implements IClerkImportStore {
  private readonly store: D1IdentityMutationStore;
  constructor(database: D1DatabaseBinding) {
    this.store = new D1IdentityMutationStore(database);
  }
  read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return this.store.read(statement);
  }
  commitImport(statements: IdentityStatement[]): Promise<IdentityMutationResult[]> {
    return this.store.commit(statements);
  }
}

/** Identifiers are fixed schema names; resource and identity values are always bound parameters. */
export function importSqlIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Invalid import schema identifier.");
  return `"${value}"`;
}

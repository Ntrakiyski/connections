import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

export interface IdentityStatement {
  sql: string;
  values: Array<string | number | null>;
}

export interface IdentityMutationResult {
  rows: Record<string, unknown>[];
  changes: number;
}

export interface IIdentityMutationStore {
  readonly currentTimeSQL: string;
  read(statement: IdentityStatement): Promise<Record<string, unknown>[]>;
  /** The company lock serializes concurrent governance changes on PostgreSQL. D1 batches and SQLite writes are atomic. */
  commit(statements: IdentityStatement[], organizationId?: string): Promise<IdentityMutationResult[]>;
}

export class PostgresIdentityMutationStore implements IIdentityMutationStore {
  readonly currentTimeSQL = "clock_timestamp()";
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return (await this.pool.query(postgresSql(statement.sql), statement.values)).rows;
  }

  async commit(statements: IdentityStatement[], organizationId?: string): Promise<IdentityMutationResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (organizationId) {
        await client.query("select id from organizations where id = $1 for update", [organizationId]);
        await client.query("select id from workspaces where organization_id = $1 order by id for update", [
          organizationId,
        ]);
      }
      const results: IdentityMutationResult[] = [];
      for (const statement of statements) {
        const result = await client.query(postgresSql(statement.sql), statement.values);
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

export class SqliteIdentityMutationStore implements IIdentityMutationStore {
  readonly currentTimeSQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return this.database.prepare(statement.sql).all(...statement.values);
  }

  async commit(statements: IdentityStatement[]): Promise<IdentityMutationResult[]> {
    // No await occurs inside this transaction: another local request cannot interleave.
    this.database.exec("begin immediate");
    try {
      const results = statements.map((statement) => {
        const rows = this.database.prepare(statement.sql).all(...statement.values);
        const changes = Number(this.database.prepare("select changes() as changes").get()?.changes ?? 0);
        return { rows, changes };
      });
      this.database.exec("commit");
      return results;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }
}

export class D1IdentityMutationStore implements IIdentityMutationStore {
  readonly currentTimeSQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  private readonly database: D1DatabaseBinding;
  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async read(statement: IdentityStatement): Promise<Record<string, unknown>[]> {
    return (
      await this.database
        .prepare(statement.sql)
        .bind(...statement.values)
        .all()
    ).results;
  }

  async commit(statements: IdentityStatement[]): Promise<IdentityMutationResult[]> {
    const results = await this.database.batch<Record<string, unknown>>(
      statements.map((statement) => this.database.prepare(statement.sql).bind(...statement.values)),
    );
    return results.map((result) => ({ rows: result.results ?? [], changes: result.meta.changes ?? 0 }));
  }
}

function postgresSql(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}

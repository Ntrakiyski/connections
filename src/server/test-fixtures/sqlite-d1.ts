import type { D1DatabaseBinding, D1PreparedStatementBinding, D1RunResult } from "../cloudflare/cloudflare-bindings.ts";

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** SQLite-backed D1 contract fake. Runs the shipped migrations with FK enforcement enabled. */
export class FixtureD1Database implements D1DatabaseBinding {
  readonly sqlite: DatabaseSync = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec("pragma foreign_keys = on");
    const directory = new URL("../../../sqlite-migrations/", import.meta.url);
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
  }

  prepare(query: string): D1PreparedStatementBinding {
    return new FixtureD1Statement(this.sqlite, query);
  }

  async batch(statements: D1PreparedStatementBinding[]): Promise<D1RunResult[]> {
    this.sqlite.exec("begin");
    try {
      const results: D1RunResult[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("commit");
      return results;
    } catch (error) {
      this.sqlite.exec("rollback");
      throw error;
    }
  }
}

class FixtureD1Statement implements D1PreparedStatementBinding {
  private readonly database: DatabaseSync;
  private readonly query: string;
  private readonly values: Array<string | number | null>;

  constructor(database: DatabaseSync, query: string, values: Array<string | number | null> = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementBinding {
    const bound = values.map((value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      throw new Error("Fixture D1 only accepts scalar SQL bindings.");
    });
    return new FixtureD1Statement(this.database, this.query, bound);
  }

  async first<T>(): Promise<T | null> {
    // D1's generic row type is supplied by its caller, just as for the real binding.
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.query).all(...this.values) as T[] };
  }

  async run(): Promise<D1RunResult> {
    return { success: true, meta: { changes: Number(this.database.prepare(this.query).run(...this.values).changes) } };
  }
}

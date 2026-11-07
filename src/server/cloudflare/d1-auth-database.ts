import type { D1DatabaseBinding, D1PreparedStatementBinding, D1RunResult } from "./cloudflare-bindings.ts";
import type { BetterAuthOptions } from "better-auth";

type AuthDatabase = Extract<NonNullable<BetterAuthOptions["database"]>, { exec(query: string): Promise<unknown> }>;
type AuthStatement = ReturnType<AuthDatabase["prepare"]>;

/** Preserves native D1 batches while adapting the runtime's narrowed binding contract. */
export function createD1AuthDatabase(database: D1DatabaseBinding): AuthDatabase {
  if (!database.exec) throw new Error("Human sessions require a native D1 binding with exec support.");
  const statements = new WeakMap<AuthStatement, D1PreparedStatementBinding>();
  function wrap(binding: D1PreparedStatementBinding): AuthStatement {
    const statement: AuthStatement = {
      bind: (...values: unknown[]) => wrap(binding.bind(...values)),
      async all<T>() {
        const result = await binding.all<T>();
        return { results: result.results, meta: metadata(result.meta) };
      },
    };
    statements.set(statement, binding);
    return statement;
  }
  return {
    prepare: (query: string) => wrap(database.prepare(query)),
    async batch<T>(batch: AuthStatement[]) {
      const bindings = batch.map((statement) => {
        const binding = statements.get(statement);
        if (!binding) throw new Error("Authentication batch contains a foreign statement.");
        return binding;
      });
      const results = await database.batch<T>(bindings);
      return results.map((result) => ({ results: result.results ?? [], meta: metadata(result.meta) }));
    },
    exec: (query: string) => {
      if (!database.exec) throw new Error("Native D1 exec support is required.");
      return database.exec(query);
    },
  };
}

function metadata(meta: D1RunResult["meta"] | undefined): { changes: number; last_row_id: number } {
  return { changes: meta?.changes ?? 0, last_row_id: meta?.last_row_id ?? 0 };
}

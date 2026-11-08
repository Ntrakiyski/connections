import type { IdentityStatement } from "../storage/identity-mutations.ts";
import type { IClerkImportStore } from "./clerk-import-store.ts";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { importSqlIdentifier } from "./clerk-import-store.ts";
import { importFingerprint } from "./clerk-snapshot.ts";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowSchema = z.record(z.string(), scalar);
export type ImportDatabaseRow = Record<string, string | number | boolean | null>;
export interface ImportTableInventory {
  table: string;
  rows: ImportDatabaseRow[];
}

export const importResourceTables: readonly string[] = [
  "connections",
  "oauth_client_configs",
  "runtime_tokens",
  "runs",
  "meetily_meetings",
  "audit_events",
  "workspace_providers",
  "workspace_action_policies",
  "workspace_safety_settings",
  "workspace_provider_safety_settings",
  "workspace_idempotency_records",
];
export const importInventoryTables: readonly string[] = [
  "workspaces",
  "workspace_memberships",
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
  "organizations",
  "organization_memberships",
  "organization_invitations",
  "oauth_states",
  "identity_import_runs",
  "identity_source_mappings",
  "identity_import_invitation_recovery",
  ...importResourceTables,
];

/** Full rows stay private to the process. Reports contain counts and SHA-256 fingerprints only. */
export async function readClerkImportInventory(store: IClerkImportStore): Promise<ImportTableInventory[]> {
  const inventory: ImportTableInventory[] = [];
  for (const table of importInventoryTables) {
    const values = await store.read({ sql: `select * from ${importSqlIdentifier(table)}`, values: [] });
    const rows = values.map((row) =>
      rowSchema.parse(
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Date
              ? value.toISOString()
              : value !== null && typeof value === "object"
                ? JSON.stringify(value)
                : value,
          ]),
        ),
      ),
    );
    rows.sort((left, right) => importFingerprint(left).localeCompare(importFingerprint(right)));
    inventory.push({ table, rows });
  }
  return inventory;
}

export interface ImportInventoryGuards {
  statements: IdentityStatement[];
  cleanup: IdentityStatement[];
}

/** Recheck every observed row and count inside the locked transaction/batch, before any migration writes. */
export function guardClerkImportInventory(inventory: ImportTableInventory[]): ImportInventoryGuards {
  const statements: IdentityStatement[] = [];
  const cleanup: IdentityStatement[] = [];
  function guard(condition: string, values: IdentityStatement["values"]): void {
    const id = randomUUID();
    statements.push({
      sql: `insert into identity_mutation_checks(id,authorized) select ?, case when ${condition} then 1 else 0 end`,
      values: [id, ...values],
    });
    cleanup.push({ sql: "delete from identity_mutation_checks where id=?", values: [id] });
  }
  for (const { table, rows } of inventory) {
    const identifier = importSqlIdentifier(table);
    guard(`(select count(*) from ${identifier})=?`, [rows.length]);
    for (const row of rows) {
      const values: IdentityStatement["values"] = [];
      const predicates = Object.entries(row).map(([column, value]) => {
        const key = importSqlIdentifier(column);
        if (value === null) return `${key} is null`;
        if (typeof value === "boolean") return `${key}=${value ? "true" : "false"}`;
        values.push(value);
        return `${key}=?`;
      });
      guard(`exists(select 1 from ${identifier} where ${predicates.join(" and ")})`, values);
    }
  }
  return { statements, cleanup };
}

export interface ClerkImportFile {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  bytes: number;
  modifiedAtNs: string;
  contentFingerprint: string;
  metadataFingerprint: string;
}
export const clerkImportFileSchema: z.ZodType<ClerkImportFile> = z.strictObject({
  id: z.string().min(1),
  workspaceId: z.string().nullable(),
  userId: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  modifiedAtNs: z.string().regex(/^\d+$/),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  metadataFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface IClerkImportFiles {
  read(): Promise<ClerkImportFile[]>;
}

import type { IClerkImportStore } from "../src/server/migration/clerk-import-store.ts";

import { createClerkClient } from "@clerk/backend";
import { readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { z } from "zod";
import { ClerkIdentityImporter } from "../src/server/migration/clerk-identity-importer.ts";
import { NodeClerkImportFiles } from "../src/server/migration/clerk-import-files.ts";
import { PostgresClerkImportStore, SqliteClerkImportStore } from "../src/server/migration/clerk-import-store.ts";
import { exportClerkSnapshot } from "../src/server/migration/clerk-snapshot-export.ts";
import { createSecretCodec } from "../src/server/secrets/secret-codec.ts";
import { normalizePostgresConnectionString } from "../src/server/storage/postgres-config.ts";

let phase = "arguments";
let close: (() => Promise<void>) | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      snapshot: { type: "string" },
      manifest: { type: "string" },
      output: { type: "string" },
      sqlite: { type: "string" },
      "files-root": { type: "string" },
      plan: { type: "string" },
      maintenance: { type: "boolean" },
    },
  });
  const command = z.enum(["export", "dry-run", "apply"]).parse(positionals[0]);
  if (positionals.length !== 1) throw new Error("Exactly one import command is required.");
  if (command === "export") {
    const output = z.string().min(1).parse(values.output);
    const secretKey = z.string().min(1).parse(process.env.CLERK_SECRET_KEY);
    phase = "source_export";
    const snapshot = await exportClerkSnapshot(createClerkClient({ secretKey }));
    await writeFile(output, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        kind: "exported",
        sourceInstance: snapshot.sourceInstance,
        counts: {
          users: snapshot.users.length,
          companies: snapshot.organizations.length,
          memberships: snapshot.memberships.length,
          invitations: snapshot.invitations.length,
        },
      }) + "\n",
    );
  } else {
    const snapshotPath = z.string().min(1).parse(values.snapshot);
    const manifestPath = z.string().min(1).parse(values.manifest);
    const filesRoot = z.string().min(1).parse(values["files-root"]);
    if (command === "apply" && (!values.maintenance || !values.plan))
      throw new Error("Apply requires --maintenance and the reviewed --plan fingerprint.");
    const source: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    phase = "target_inventory";
    let store: IClerkImportStore;
    if (values.sqlite) {
      // Dry run must not initialize schema, create a database or run startup migrations.
      if (!(await stat(values.sqlite)).isFile()) throw new Error("The target SQLite database must already exist.");
      const database = new DatabaseSync(values.sqlite, { readOnly: command === "dry-run" });
      database.exec("pragma foreign_keys=on");
      store = new SqliteClerkImportStore(database);
      close = async () => {
        database.close();
      };
    } else {
      const url = z.string().min(1).parse(process.env.DATABASE_URL);
      const pool = new Pool({ connectionString: normalizePostgresConnectionString(url) });
      store = new PostgresClerkImportStore(pool);
      close = async () => {
        await pool.end();
      };
    }
    const importer = new ClerkIdentityImporter({
      store,
      secretCodec: createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY),
      files: new NodeClerkImportFiles(filesRoot),
    });
    phase = command === "apply" ? "apply" : "target_inventory";
    const report =
      command === "apply"
        ? await importer.apply(source, manifest, {
            expectedPlanFingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(values.plan),
            maintenanceMode: true,
          })
        : await importer.preview(source, manifest);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (
      report.kind === "blocked" ||
      report.kind === "apply_uncertain" ||
      report.kind === "verification_pending" ||
      report.exceptions.some((item) => item.severity === "block")
    )
      process.exitCode = 1;
  }
} catch {
  process.stderr.write(
    JSON.stringify({
      kind: "error",
      phase,
      message:
        "Import stopped. Verify arguments, frozen source/manifest, pre-applied schema, file inventory and original encryption key. No source data or authentication secrets are printed. See connections-docs/CLERK_IMPORT.md.",
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await close?.();
}

import pg from "pg";
import { z } from "zod";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const maintenance = process.argv.includes("--maintenance");
  const unknown = process.argv
    .slice(2)
    .filter((argument) => !["--apply", "--maintenance", "--dry-run"].includes(argument));
  if (unknown.length || (apply && !maintenance))
    throw new Error("Use --dry-run, or --apply --maintenance after freezing all identity/workspace writers.");
  const url = new URL(z.string().parse(process.env.DATABASE_URL));
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Finalization requires PostgreSQL.");
  const pool = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 10000 });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  try {
    await client.query(apply ? "begin" : "begin isolation level repeatable read read only");
    if (apply)
      await client.query(
        "lock table workspaces, workspace_memberships, organizations, organization_memberships, identity_import_runs, identity_source_mappings in share row exclusive mode",
      );
    const result = await client.query(`select
    (select count(*)::int from workspaces where organization_id is null) as unmapped_workspaces,
    (select count(*)::int from workspace_memberships where organization_id is null) as unmapped_grants,
    (select count(*)::int from identity_import_runs where verification <> 'verified') as pending_imports,
    (select count(*)::int from workspaces w where w.clerk_org_id not like 'connections-workspace:%' and not exists(select 1 from identity_source_mappings m join identity_import_runs r on r.source_instance=m.source_instance where m.kind='workspace' and m.target_id=w.id and r.verification='verified')) as unverified_legacy_workspaces,
    (select count(*)::int from organizations o where not exists(select 1 from organization_memberships m join auth_user u on u.id=m.user_id where m.organization_id=o.id and m.role='owner' and u.email_verified=true)) as missing_company_owners,
    (select count(*)::int from workspaces w where not exists(select 1 from workspace_memberships m join organization_memberships d on d.organization_id=m.organization_id and d.user_id=m.user_id where m.workspace_id=w.id and m.role='admin')) as missing_workspace_admins`);
    const counts = z
      .object({
        unmapped_workspaces: z.number().int(),
        unmapped_grants: z.number().int(),
        pending_imports: z.number().int(),
        unverified_legacy_workspaces: z.number().int(),
        missing_company_owners: z.number().int(),
        missing_workspace_admins: z.number().int(),
      })
      .parse(result.rows[0]);
    const blocked = Object.values(counts).some((count) => count !== 0);
    if (apply && !blocked) {
      await client.query("alter table workspaces alter column organization_id set not null");
      await client.query("alter table workspace_memberships alter column organization_id set not null");
    }
    await client.query(blocked ? "rollback" : "commit");
    process.stdout.write(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        status: blocked ? "blocked" : apply ? "finalized" : "ready",
        counts,
      }) + "\n",
    );
    if (blocked) process.exitCode = 1;
  } catch {
    await client.query("rollback").catch(() => {});
    process.stderr.write(
      "Company schema finalization failed. Verify the frozen target, reviewed import ledger and schema; no database parameters are printed.\n",
    );
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
await main().catch(() => {
  process.stderr.write(
    "Company schema finalization stopped. Verify arguments, the frozen target, reviewed mappings and schema. No database parameters are printed.\n",
  );
  process.exitCode = 1;
});

import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { IdentityStatement } from "../storage/identity-mutations.ts";
import type { ClerkImportFile, IClerkImportFiles, ImportTableInventory } from "./clerk-import-inventory.ts";
import type { IClerkImportStore } from "./clerk-import-store.ts";
import type { ClerkSnapshot } from "./clerk-snapshot.ts";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  clerkImportFileSchema,
  guardClerkImportInventory,
  importInventoryTables,
  importResourceTables,
  readClerkImportInventory,
} from "./clerk-import-inventory.ts";
import {
  clerkImportManifestSchema,
  clerkSnapshotSchema,
  importFingerprint,
  normalizeClerkSnapshot,
} from "./clerk-snapshot.ts";

const workspaceSchema = z.object({
  id: z.string(),
  clerk_org_id: z.string(),
  organization_id: z.string().nullable(),
  deleted_at: z.string().nullable(),
});
const grantSchema = z.object({
  workspace_id: z.string(),
  user_id: z.string(),
  organization_id: z.string().nullable(),
  role: z.enum(["admin", "manager", "member"]),
});
export interface ClerkImportException {
  code: string;
  entity: string;
  id: string;
  severity: "block" | "review";
  remedy: string;
}
export interface ClerkImportMapping {
  kind: "user" | "company" | "workspace";
  sourceId: string;
  targetId: string;
}
export interface ClerkImportReport {
  version: 1;
  kind: "dry_run" | "blocked" | "applied" | "already_applied" | "apply_uncertain" | "verification_pending";
  sourceFingerprint: string;
  manifestFingerprint: string;
  planFingerprint: string;
  preservedResourceFingerprint: string;
  filesFingerprint: string;
  counts: Record<string, number>;
  directoryRoles: { owner: number; admin: number; member: number };
  workspaceRoles: { admin: number; manager: number; member: number };
  mappings: ClerkImportMapping[];
  exceptions: ClerkImportException[];
}
const exceptionSchema = z.object({
  code: z.string(),
  entity: z.string(),
  id: z.string(),
  severity: z.enum(["block", "review"]),
  remedy: z.string(),
});
export const clerkImportReportSchema: z.ZodType<ClerkImportReport> = z.object({
  version: z.literal(1),
  kind: z.enum(["dry_run", "blocked", "applied", "already_applied", "apply_uncertain", "verification_pending"]),
  sourceFingerprint: z.string(),
  manifestFingerprint: z.string(),
  planFingerprint: z.string(),
  preservedResourceFingerprint: z.string(),
  filesFingerprint: z.string(),
  counts: z.record(z.string(), z.number()),
  directoryRoles: z.object({ owner: z.number(), admin: z.number(), member: z.number() }),
  workspaceRoles: z.object({ admin: z.number(), manager: z.number(), member: z.number() }),
  mappings: z.array(
    z.object({ kind: z.enum(["user", "company", "workspace"]), sourceId: z.string(), targetId: z.string() }),
  ),
  exceptions: z.array(exceptionSchema),
});
type ImportException = ClerkImportException;

export interface ClerkIdentityImporterOptions {
  store: IClerkImportStore;
  secretCodec: ISecretCodec;
  files: IClerkImportFiles;
}
export interface ClerkImportApplyOptions {
  expectedPlanFingerprint: string;
  maintenanceMode: true;
}
interface ImportPlan {
  report: ClerkImportReport;
  inventory: ImportTableInventory[];
  statements: IdentityStatement[];
  files: ClerkImportFile[];
}

/** Imports stable IDs once. Replays consult the ledger and never reconstruct memberships or restore revoked keys. */
export class ClerkIdentityImporter {
  private readonly options: ClerkIdentityImporterOptions;
  constructor(options: ClerkIdentityImporterOptions) {
    this.options = options;
  }

  async preview(source: unknown, manifest: unknown): Promise<ClerkImportReport> {
    return (await this.plan(source, manifest)).report;
  }

  async apply(source: unknown, manifest: unknown, options: ClerkImportApplyOptions): Promise<ClerkImportReport> {
    if (options.maintenanceMode !== true)
      throw new Error("Import apply requires a frozen source and application in maintenance mode.");
    const plan = await this.plan(source, manifest);
    if (plan.report.kind === "blocked" || plan.report.kind === "already_applied") return plan.report;
    if (options.expectedPlanFingerprint !== plan.report.planFingerprint)
      return blocked(
        plan.report,
        "plan_changed",
        "import",
        plan.report.planFingerprint,
        "Run the read-only inventory again and review its current plan fingerprint.",
      );
    const sourceInstance = clerkSnapshotSchema.parse(source).sourceInstance;
    if (plan.report.kind === "verification_pending")
      return this.completeVerification(plan.report, sourceInstance, "already_applied");
    const currentFiles = await this.readFiles();
    if (importFingerprint(currentFiles) !== plan.report.filesFingerprint)
      return blocked(
        plan.report,
        "files_changed",
        "files",
        "inventory",
        "Freeze file writes and repeat the inventory before applying.",
      );
    const guards = guardClerkImportInventory(plan.inventory);
    const preserved = guardClerkImportInventory(
      plan.inventory.filter((item) => importResourceTables.includes(item.table)),
    );
    try {
      await this.options.store.commitImport(
        [...guards.statements, ...plan.statements, ...preserved.statements, ...preserved.cleanup, ...guards.cleanup],
        importInventoryTables,
      );
    } catch {
      // A lost connection can make commit outcome uncertain. Rerun against the ledger; do not claim rollback.
      return {
        ...plan.report,
        kind: "apply_uncertain",
        exceptions: [
          ...plan.report.exceptions,
          exception(
            "apply_outcome_unconfirmed",
            "import",
            plan.report.planFingerprint,
            "Inspect the completed-import ledger before retrying; keep cutover stopped.",
          ),
        ],
      };
    }
    return this.completeVerification(plan.report, sourceInstance, "applied");
  }

  private async completeVerification(
    report: ClerkImportReport,
    sourceInstance: string,
    kind: "applied" | "already_applied",
  ): Promise<ClerkImportReport> {
    try {
      const inventory = await readClerkImportInventory(this.options.store);
      const resources = inventory.filter((item) => importResourceTables.includes(item.table));
      if (importFingerprint(resources) !== report.preservedResourceFingerprint)
        return {
          ...blocked(
            report,
            "pending_resources_changed",
            "resources",
            "inventory",
            "Identity import committed; preservation verification remains pending. Reconcile resource changes against the backup before cutover.",
          ),
          kind: "verification_pending",
        };
      if (importFingerprint(await this.readFiles()) !== report.filesFingerprint)
        return {
          ...blocked(
            report,
            "pending_files_changed",
            "files",
            "inventory",
            "Identity import committed; file verification remains pending. Reconcile original bytes, metadata and timestamps before cutover.",
          ),
          kind: "verification_pending",
        };
      const guards = guardClerkImportInventory(inventory);
      const marker = randomUUID();
      const writes: IdentityStatement[] = [
        ...guards.statements,
        {
          sql: "insert into identity_mutation_checks(id,authorized) select ?,case when exists(select 1 from identity_import_runs where source_instance=? and source_fingerprint=? and manifest_fingerprint=? and plan_fingerprint=?) then 1 else 0 end",
          values: [
            marker,
            sourceInstance,
            report.sourceFingerprint,
            report.manifestFingerprint,
            report.planFingerprint,
          ],
        },
        {
          sql: "update identity_import_runs set verification='verified',verified_at=?,report=? where source_instance=? and plan_fingerprint=? and verification='pending'",
          values: [
            new Date().toISOString(),
            JSON.stringify({ ...report, kind: "applied" }),
            sourceInstance,
            report.planFingerprint,
          ],
        },
        { sql: "delete from identity_mutation_checks where id=?", values: [marker] },
        ...guards.cleanup,
      ];
      await this.options.store.commitImport(writes, importInventoryTables);
      return { ...report, kind };
    } catch {
      return {
        ...blocked(
          report,
          "verification_unconfirmed",
          "import",
          report.planFingerprint,
          "Identity import committed; final verification is unconfirmed. Recheck the ledger and resume the same reviewed apply without reconstructing grants.",
        ),
        kind: "verification_pending",
      };
    }
  }

  private async readFiles(): Promise<ClerkImportFile[]> {
    return z
      .array(clerkImportFileSchema)
      .parse(await this.options.files.read())
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async plan(sourceInput: unknown, manifestInput: unknown): Promise<ImportPlan> {
    const source = normalizeClerkSnapshot(clerkSnapshotSchema.parse(sourceInput));
    const manifest = clerkImportManifestSchema.parse(manifestInput);
    const roleMappings = new Map(Object.entries(manifest.directoryRoles));
    manifest.companies.sort((a, b) => a.sourceOrganizationId.localeCompare(b.sourceOrganizationId));
    const invitationsForReview = source.invitations.filter(
      (invite) => invite.status === "pending" && invite.expiresAt > source.capturedAt,
    );
    const sourceFingerprint = importFingerprint({
      ...source,
      capturedAt: null,
      invitationsForReview: invitationsForReview.map((invite) => invite.id),
    });
    const manifestFingerprint = importFingerprint(manifest);
    const completed = await this.options.store.read({
      sql: "select source_fingerprint,manifest_fingerprint,report,verification from identity_import_runs where source_instance=?",
      values: [source.sourceInstance],
    });
    if (completed.length) {
      const row = z
        .object({
          source_fingerprint: z.string(),
          manifest_fingerprint: z.string(),
          report: z.string(),
          verification: z.enum(["pending", "verified"]),
        })
        .parse(completed[0]);
      const report = clerkImportReportSchema.parse(JSON.parse(row.report));
      if (row.source_fingerprint !== sourceFingerprint || row.manifest_fingerprint !== manifestFingerprint)
        return {
          report: blocked(
            report,
            "completed_source_changed",
            "import",
            source.sourceInstance,
            "A completed import cannot replay a changed source. Reconcile changes through current governance services.",
          ),
          inventory: [],
          statements: [],
          files: [],
        };
      return {
        report: { ...report, kind: row.verification === "verified" ? "already_applied" : "verification_pending" },
        inventory: [],
        statements: [],
        files: [],
      };
    }
    const inventory = await readClerkImportInventory(this.options.store);
    const files = await this.readFiles();
    const rows = (table: string): ImportTableInventory["rows"] =>
      inventory.find((item) => item.table === table)?.rows ?? [];
    const workspaces = rows("workspaces").map((row) => workspaceSchema.parse(row));
    const grants = rows("workspace_memberships").map((row) => grantSchema.parse(row));
    const users = new Map(source.users.map((user) => [user.id, user]));
    const companies = new Map(manifest.companies.map((company) => [company.sourceOrganizationId, company]));
    const workspaceCompanies = new Map(manifest.companies.map((company) => [company.workspaceId, company]));
    const directory = new Map(
      source.memberships.map((member) => [`${member.organizationId}:${member.userId}`, member]),
    );
    const grantKeys = new Set(grants.map((grant) => `${grant.workspace_id}:${grant.user_id}`));
    const local = new Set<string>(manifest.localCompatibilityWorkspaceIds);
    const exceptions: ImportException[] = [];
    const add = (
      code: string,
      entity: string,
      id: string,
      remedy: string,
      severity: ImportException["severity"] = "block",
    ): void => {
      exceptions.push(exception(code, entity, id, remedy, severity));
    };
    if (source.sourceInstance !== manifest.sourceInstance)
      add(
        "wrong_source_instance",
        "source",
        source.sourceInstance,
        "Use the manifest reviewed for this exact Clerk instance.",
      );
    checkDuplicates(source.users, (user) => user.id, "duplicate_source_user", "user", add);
    checkDuplicates(
      source.organizations,
      (organization) => organization.id,
      "duplicate_source_company",
      "company",
      add,
    );
    checkDuplicates(source.memberships, (member) => member.id, "duplicate_source_membership", "membership", add);
    checkDuplicates(
      source.memberships,
      (member) => `${member.organizationId}:${member.userId}`,
      "duplicate_directory_membership",
      "membership",
      add,
    );
    checkDuplicates(source.invitations, (invite) => invite.id, "duplicate_source_invitation", "invitation", add);
    checkDuplicates(
      manifest.companies,
      (company) => company.sourceOrganizationId,
      "duplicate_company_mapping",
      "company",
      add,
    );
    checkDuplicates(
      manifest.companies,
      (company) => company.workspaceId,
      "duplicate_workspace_mapping",
      "workspace",
      add,
    );
    checkDuplicates(manifest.companies, (company) => company.slug, "duplicate_company_slug", "company", add);

    const emailOwners = new Map<string, string>();
    for (const user of source.users) {
      if (!user.primaryEmail || !user.emails.some((email) => email.address === user.primaryEmail))
        add(
          "missing_primary_email",
          "user",
          user.id,
          "Establish the user's primary email in Clerk and export a fresh verified snapshot.",
        );
      for (const email of user.emails.filter((email) => email.verified || email.address === user.primaryEmail)) {
        const owner = emailOwners.get(email.address);
        if (owner && owner !== user.id) {
          add(
            "ambiguous_email_identity",
            "user",
            user.id,
            "Resolve duplicate verified aliases or primary emails in the source; never merge ownership by email text.",
          );
          add(
            "ambiguous_email_identity",
            "user",
            owner,
            "Resolve duplicate verified aliases or primary emails in the source; never merge ownership by email text.",
          );
        }
        emailOwners.set(email.address, user.id);
      }
      if (user.mfaEnabled)
        add(
          "mfa_recovery_required",
          "user",
          user.id,
          "Complete a reviewed MFA recovery/re-enrollment plan before importing; no factor secrets or weaker automatic fallback are migrated.",
        );
      if (user.disabled)
        add(
          "disabled_identity",
          "user",
          user.id,
          "Reconcile banned/locked identity and revoke or remove its active access before an approved source export.",
        );
      if (
        rows("auth_user").some(
          (row) =>
            row.id === user.id ||
            (typeof row.email === "string" && emailOwners.get(row.email.toLowerCase()) === user.id),
        )
      )
        add(
          "existing_identity_collision",
          "user",
          user.id,
          "Resolve the existing target identity through a verified source mapping; do not adopt a target account by email.",
        );
    }
    for (const member of source.memberships) {
      if (
        !users.has(member.userId) ||
        !source.organizations.some((organization) => organization.id === member.organizationId)
      )
        add(
          "orphan_source_membership",
          "membership",
          member.id,
          "Resolve missing source users/companies and repeat the frozen export.",
        );
      if (!verifiedUser(source, member.userId))
        add(
          "unverified_directory_identity",
          "user",
          member.userId,
          "Verify the source account before importing company membership.",
        );
      if (!roleMappings.get(member.role))
        add(
          "unmapped_directory_role",
          "membership",
          member.id,
          "Add an explicit admin/member mapping for the source directory role; workspace roles remain independent.",
        );
      if (rows("organization_memberships").some((row) => row.id === member.id))
        add(
          "existing_membership_collision",
          "membership",
          member.id,
          "Resolve the target membership ID collision before applying.",
        );
    }
    for (const organization of source.organizations) {
      const mapping = companies.get(organization.id);
      if (!mapping) {
        add(
          "unmapped_source_company",
          "company",
          organization.id,
          "Designate its existing initial workspace, company owner and workspace admin in the manifest.",
        );
        continue;
      }
      const workspace = workspaces.find(
        (item) => item.id === mapping.workspaceId && item.clerk_org_id === organization.id,
      );
      if (!workspace || workspace.organization_id !== null)
        add(
          "ambiguous_workspace_parent",
          "company",
          organization.id,
          "Bind only the existing workspace with this exact source organization key; resolve any target company collision.",
        );
      if (!directory.has(`${organization.id}:${mapping.ownerUserId}`) || !verifiedUser(source, mapping.ownerUserId))
        add(
          "invalid_designated_owner",
          "company",
          organization.id,
          "Designate a verified current source company member as its owner.",
        );
      if (
        !grants.some(
          (grant) =>
            grant.workspace_id === mapping.workspaceId &&
            grant.user_id === mapping.workspaceAdminId &&
            grant.role === "admin",
        ) ||
        !directory.has(`${organization.id}:${mapping.workspaceAdminId}`) ||
        !verifiedUser(source, mapping.workspaceAdminId)
      )
        add(
          "missing_workspace_admin",
          "workspace",
          mapping.workspaceId,
          "Repair the zero-admin or invalid-admin workspace in the source before cutover; an owner role does not create a grant.",
        );
      if (rows("organizations").some((row) => row.id === organization.id || row.slug === mapping.slug))
        add(
          "existing_company_collision",
          "company",
          organization.id,
          "Resolve existing target company/slug collisions using verified source IDs.",
        );
    }
    for (const mapping of manifest.companies)
      if (!source.organizations.some((organization) => organization.id === mapping.sourceOrganizationId))
        add(
          "unknown_manifest_company",
          "company",
          mapping.sourceOrganizationId,
          "Remove an unverified mapping or repeat the complete source inventory.",
        );
    for (const workspace of workspaces)
      if (workspace.organization_id === null && !workspaceCompanies.has(workspace.id) && !local.has(workspace.id))
        add(
          "unmapped_legacy_workspace",
          "workspace",
          workspace.id,
          "Map every legacy production workspace; only the explicit local default workspace can remain unmapped.",
        );
    for (const grant of grants) {
      const mapping = workspaceCompanies.get(grant.workspace_id);
      if (
        mapping &&
        (grant.organization_id !== null || !directory.has(`${mapping.sourceOrganizationId}:${grant.user_id}`))
      )
        add(
          "stale_or_unmapped_grant",
          "grant",
          `${grant.workspace_id}:${grant.user_id}`,
          "Reconcile stale grants against the current source company membership before importing; never recreate removed access.",
        );
      if (!mapping && grant.organization_id === null && !local.has(grant.workspace_id))
        add(
          "unmapped_workspace_grant",
          "grant",
          `${grant.workspace_id}:${grant.user_id}`,
          "Resolve the grant's verified parent company before cutover.",
        );
    }

    const ownerColumns: Readonly<Record<string, string>> = {
      connections: "created_by",
      oauth_client_configs: "created_by",
      runtime_tokens: "user_id",
      runs: "user_id",
      meetily_meetings: "created_by",
      audit_events: "user_id",
      workspace_providers: "enabled_by",
      workspace_action_policies: "updated_by",
    };
    for (const table of importResourceTables)
      for (const row of rows(table)) {
        const workspaceId = z.string().parse(row.workspace_id);
        if (local.has(workspaceId)) continue;
        const workspace = workspaces.find((item) => item.id === workspaceId);
        if (!workspace) {
          add(
            "orphan_resource_workspace",
            table,
            importFingerprint(row),
            "Resolve resource ownership without moving records into another workspace.",
          );
          continue;
        }
        const mapping = workspaceCompanies.get(workspaceId);
        if (!mapping) continue; // Independently created Better Auth workspaces are preserved unchanged.
        const ownerColumn = ownerColumns[table];
        if (!ownerColumn) continue;
        const owner = z.string().parse(row[ownerColumn]);
        const active =
          !workspace.deleted_at && (table === "connections" || (table === "runtime_tokens" && row.revoked_at === null));
        const member =
          directory.has(`${mapping.sourceOrganizationId}:${owner}`) && grantKeys.has(`${workspaceId}:${owner}`);
        if (active && (!users.has(owner) || !member))
          add(
            "unmapped_active_owner",
            table,
            importFingerprint(row),
            "Resolve or revoke the active record in its original scope; do not invent a verified owner.",
          );
        else if (!users.has(owner))
          add(
            "historical_owner_unavailable",
            table,
            importFingerprint(row),
            "Retain the historical source owner ID; it cannot authorize new activity.",
            "review",
          );
      }
    for (const table of ["connections", "oauth_client_configs"])
      for (const row of rows(table)) {
        try {
          JSON.parse(await this.options.secretCodec.decode(z.string().parse(row.value)));
        } catch {
          add(
            "credential_decryption_failed",
            table,
            importFingerprint(row),
            "Use the existing credential-encryption key and resolve corrupt blobs; never rotate or rewrite credentials during import.",
          );
        }
      }
    for (const file of files) {
      if (file.workspaceId && local.has(file.workspaceId)) continue;
      if (!file.workspaceId || !file.userId || !workspaces.some((workspace) => workspace.id === file.workspaceId))
        add(
          "unmapped_file_owner",
          "file",
          file.id,
          "Resolve file metadata under its original user/workspace; preserve the file bytes and metadata.",
        );
      else {
        const mapping = workspaceCompanies.get(file.workspaceId);
        if (
          mapping &&
          (!users.has(file.userId) ||
            !directory.has(`${mapping.sourceOrganizationId}:${file.userId}`) ||
            !grantKeys.has(`${file.workspaceId}:${file.userId}`))
        )
          add(
            "unmapped_file_owner",
            "file",
            file.id,
            "Reconcile the active file's original scope before cutover; do not change ownership by email.",
          );
      }
    }
    for (const invite of source.invitations)
      if (!companies.has(invite.organizationId))
        add(
          "unmapped_invitation_company",
          "invitation",
          invite.id,
          "Map the invitation's source company before preparing reissue review.",
        );

    const report: ClerkImportReport = {
      version: 1,
      kind: exceptions.some((item) => item.severity === "block") ? "blocked" : "dry_run",
      sourceFingerprint,
      manifestFingerprint,
      planFingerprint: importFingerprint({ sourceFingerprint, manifestFingerprint, inventory, files }),
      preservedResourceFingerprint: importFingerprint(
        inventory.filter((item) => importResourceTables.includes(item.table)),
      ),
      filesFingerprint: importFingerprint(files),
      counts: {
        users: source.users.length,
        verifiedUsers: source.users.filter((user) => verifiedUser(source, user.id)).length,
        companies: source.organizations.length,
        memberships: source.memberships.length,
        workspaceGrants: grants.filter((grant) => workspaceCompanies.has(grant.workspace_id)).length,
        passwordRecoveryUsers: source.users.length,
        invitationsForReissueReview: source.invitations.filter(
          (invite) => invite.status === "pending" && invite.expiresAt > source.capturedAt,
        ).length,
        files: files.length,
        ...Object.fromEntries(inventory.map((item) => [item.table, item.rows.length])),
      },
      directoryRoles: { owner: 0, admin: 0, member: 0 },
      workspaceRoles: { admin: 0, manager: 0, member: 0 },
      mappings: [
        ...source.users.map(
          (user) =>
            ({ kind: "user", sourceId: user.id, targetId: user.id }) satisfies ClerkImportReport["mappings"][number],
        ),
        ...manifest.companies.flatMap(
          (company) =>
            [
              { kind: "company", sourceId: company.sourceOrganizationId, targetId: company.sourceOrganizationId },
              { kind: "workspace", sourceId: company.sourceOrganizationId, targetId: company.workspaceId },
            ] satisfies ClerkImportReport["mappings"],
        ),
      ],
      exceptions,
    };
    for (const member of source.memberships) {
      const role =
        companies.get(member.organizationId)?.ownerUserId === member.userId ? "owner" : roleMappings.get(member.role);
      if (role) report.directoryRoles[role]++;
    }
    for (const grant of grants) if (workspaceCompanies.has(grant.workspace_id)) report.workspaceRoles[grant.role]++;
    if (report.kind === "blocked") return { report, inventory, files, statements: [] };

    const statements: IdentityStatement[] = [];
    const write = (sql: string, values: IdentityStatement["values"]): void => {
      statements.push({ sql, values });
    };
    write(
      "insert into identity_import_runs(source_instance,source_fingerprint,manifest_fingerprint,plan_fingerprint,report,applied_at) values(?,?,?,?,?,?)",
      [
        source.sourceInstance,
        sourceFingerprint,
        manifestFingerprint,
        report.planFingerprint,
        JSON.stringify({ ...report, kind: "verification_pending" }),
        new Date().toISOString(),
      ],
    );
    for (const user of source.users)
      write(
        "insert into auth_user(id,name,email,email_verified,created_at,updated_at) values(?,?,?,case when ?=1 then true else false end,?,?)",
        [user.id, user.name, user.primaryEmail, verifiedUser(source, user.id) ? 1 : 0, user.createdAt, user.updatedAt],
      );
    for (const organization of source.organizations)
      write("insert into organizations(id,name,slug,created_at) values(?,?,?,?)", [
        organization.id,
        organization.name,
        companies.get(organization.id)?.slug ?? "",
        organization.createdAt,
      ]);
    for (const member of source.memberships)
      write("insert into organization_memberships(id,organization_id,user_id,role,created_at) values(?,?,?,?,?)", [
        member.id,
        member.organizationId,
        member.userId,
        companies.get(member.organizationId)?.ownerUserId === member.userId
          ? "owner"
          : (roleMappings.get(member.role) ?? "member"),
        member.createdAt,
      ]);
    for (const company of manifest.companies) {
      write("update workspace_memberships set organization_id=? where workspace_id=?", [
        company.sourceOrganizationId,
        company.workspaceId,
      ]);
      write("update workspaces set organization_id=? where id=?", [company.sourceOrganizationId, company.workspaceId]);
    }
    for (const mapping of report.mappings)
      write("insert into identity_source_mappings(source_instance,kind,source_id,target_id) values(?,?,?,?)", [
        source.sourceInstance,
        mapping.kind,
        mapping.sourceId,
        mapping.targetId,
      ]);
    for (const invite of source.invitations.filter(
      (invite) => invite.status === "pending" && invite.expiresAt > source.capturedAt,
    ))
      write(
        "insert into identity_import_invitation_recovery(source_instance,source_invitation_id,organization_id,email,source_role,expires_at) values(?,?,?,?,?,?)",
        [source.sourceInstance, invite.id, invite.organizationId, invite.email, invite.role, invite.expiresAt],
      );
    for (const table of ["auth_session", "auth_verification", "oauth_states"]) write(`delete from ${table}`, []);
    return { report, inventory, files, statements };
  }
}

function verifiedUser(source: ClerkSnapshot, userId: string): boolean {
  const user = source.users.find((item) => item.id === userId);
  return Boolean(
    user?.primaryEmail && user.emails.some((email) => email.address === user.primaryEmail && email.verified),
  );
}
function exception(
  code: string,
  entity: string,
  id: string,
  remedy: string,
  severity: ImportException["severity"] = "block",
): ImportException {
  return { code, entity, id: importFingerprint(id).slice(0, 24), severity, remedy };
}
function blocked(
  report: ClerkImportReport,
  code: string,
  entity: string,
  id: string,
  remedy: string,
): ClerkImportReport {
  return { ...report, kind: "blocked", exceptions: [...report.exceptions, exception(code, entity, id, remedy)] };
}
function checkDuplicates<T>(
  items: T[],
  key: (item: T) => string,
  code: string,
  entity: string,
  add: (code: string, entity: string, id: string, remedy: string) => void,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id))
      add(code, entity, id, "Resolve duplicate source identifiers before applying the frozen snapshot.");
    seen.add(id);
  }
}

import type { ClerkImportFile, IClerkImportFiles } from "./clerk-import-inventory.ts";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const metadataSchema = z.object({ workspaceId: z.string().optional(), userId: z.string().optional() });

/** Hashes Node transit-file bytes and sidecar metadata without writing, renaming, cleaning up or exposing content. */
export class NodeClerkImportFiles implements IClerkImportFiles {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async read(): Promise<ClerkImportFile[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const files: ClerkImportFile[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) throw new Error("Unexpected transit-file entry type. Reconcile it before import.");
      if (entry.name.endsWith(".meta.json")) continue;
      if (!/^[a-f0-9]{32}(?:\.[a-zA-Z0-9]+)?$/.test(entry.name))
        throw new Error(
          "Unrecognized transit-file entry. Freeze writes and reconcile partial/orphaned files before import.",
        );
      const path = join(this.root, entry.name);
      const metadata = await readFile(`${path}.meta.json`, "utf8");
      const scope = metadataSchema.parse(JSON.parse(metadata));
      const content = createHash("sha256");
      for await (const chunk of createReadStream(path)) content.update(chunk);
      const stats = await stat(path, { bigint: true });
      files.push({
        id: entry.name,
        workspaceId: scope.workspaceId ?? null,
        userId: scope.userId ?? null,
        bytes: Number(stats.size),
        modifiedAtNs: stats.mtimeNs.toString(),
        contentFingerprint: content.digest("hex"),
        metadataFingerprint: createHash("sha256").update(metadata).digest("hex"),
      });
    }
    const expectedMetadata = new Set(files.map((file) => `${file.id}.meta.json`));
    if (entries.some((entry) => entry.name.endsWith(".meta.json") && !expectedMetadata.has(entry.name)))
      throw new Error("Orphaned transit-file metadata. Reconcile it before importing.");
    return files;
  }
}

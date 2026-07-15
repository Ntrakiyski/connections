import type { R2BucketBinding, R2ObjectBinding } from "../cloudflare/cloudflare-bindings.ts";
import type {
  ITransitFileService,
  TransitFileAccess,
  TransitFileRead,
  TransitFileUpload,
} from "./transit-file-store.ts";

import { extname } from "node:path";
import { contentTypeFromFileId, TransitFileError } from "./transit-file-store.ts";

export interface R2TransitFileOptions {
  bucket: R2BucketBinding;
  publicOrigin: string;
  ttlSeconds: number;
  maxBytes: number;
}

interface TransitFileMetadata {
  name: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
  workspaceId?: string;
  userId?: string;
}

export class R2TransitFileService implements ITransitFileService {
  private readonly bucket: R2BucketBinding;
  private readonly publicOrigin: string;
  private readonly ttlMs: number;
  readonly maxBytes: number;

  constructor(options: R2TransitFileOptions) {
    this.bucket = options.bucket;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
  }

  async create(file: File, access?: TransitFileAccess): Promise<TransitFileUpload> {
    this.assertFileSize(file.size);
    const fileId = `${randomHex(16)}${safeExtension(file.name)}`;
    const metadata = normalizeMetadata({
      name: file.name || fileId,
      mimeType: file.type || contentTypeFromFileId(fileId),
      createdAt: new Date().toISOString(),
      sizeBytes: file.size,
      workspaceId: access?.workspaceId,
      userId: access?.userId,
    });

    await this.bucket.put(objectKey(fileId), file.stream(), {
      httpMetadata: { contentType: metadata.mimeType },
    });
    await this.bucket.put(metadataKey(fileId), JSON.stringify(metadata));

    return {
      fileId,
      downloadUrl: `${this.publicOrigin}/api/files/${encodeURIComponent(fileId)}`,
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async read(fileId: string, access?: TransitFileAccess): Promise<TransitFileRead> {
    const { object, metadata } = await this.readObject(fileId, access);
    return {
      file: new File([await object.arrayBuffer()], metadata.name, { type: metadata.mimeType }),
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async response(fileId: string, access?: TransitFileAccess): Promise<Response> {
    const { object, metadata } = await this.readObject(fileId, access);
    return new Response(object.body, {
      headers: {
        "content-length": String(metadata.sizeBytes),
        "content-type": metadata.mimeType,
        "content-disposition": `attachment; filename="${escapeHeaderValue(metadata.name)}"`,
      },
    });
  }

  async delete(fileId: string, access?: TransitFileAccess): Promise<boolean> {
    assertSafeFileId(fileId);
    const [existing, metadata] = await Promise.all([this.bucket.get(objectKey(fileId)), this.readMetadata(fileId)]);
    if (!existing || !metadata) return false;
    try {
      assertAccess(metadata, access);
    } catch {
      return false;
    }
    await this.deleteStored(fileId);
    return true;
  }

  async cleanupExpired(): Promise<void> {}

  private async readObject(
    fileId: string,
    access?: TransitFileAccess,
  ): Promise<{
    object: R2ObjectBinding;
    metadata: TransitFileMetadata;
  }> {
    assertSafeFileId(fileId);
    const [object, metadata] = await Promise.all([this.bucket.get(objectKey(fileId)), this.readMetadata(fileId)]);
    if (!object || !metadata || this.isExpired(metadata)) {
      await this.deleteStored(fileId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }
    assertAccess(metadata, access);

    return { object, metadata };
  }

  private async readMetadata(fileId: string): Promise<TransitFileMetadata | undefined> {
    const metadata = await this.bucket.get(metadataKey(fileId));
    if (!metadata) {
      return undefined;
    }

    try {
      return normalizeMetadata(JSON.parse(await metadataText(metadata)) as Partial<TransitFileMetadata>);
    } catch {
      return undefined;
    }
  }

  private assertFileSize(size: number): void {
    if (size > this.maxBytes) {
      throw new TransitFileError(413, "file_too_large", `Transit file must be ${this.maxBytes} bytes or smaller.`);
    }
  }

  private isExpired(metadata: TransitFileMetadata): boolean {
    return Date.now() - Date.parse(metadata.createdAt) > this.ttlMs;
  }

  private async deleteStored(fileId: string): Promise<void> {
    await Promise.all([this.bucket.delete(objectKey(fileId)), this.bucket.delete(metadataKey(fileId))]);
  }
}

async function metadataText(metadata: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  return new TextDecoder().decode(await metadata.arrayBuffer());
}

function normalizeMetadata(input: Partial<TransitFileMetadata>): TransitFileMetadata {
  const metadata: TransitFileMetadata = {
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : "file",
    mimeType:
      typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim() : "application/octet-stream",
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    sizeBytes: typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0,
  };
  if (typeof input.workspaceId === "string") metadata.workspaceId = input.workspaceId;
  if (typeof input.userId === "string") metadata.userId = input.userId;
  return metadata;
}

function assertAccess(metadata: TransitFileMetadata, access: TransitFileAccess | undefined): void {
  if (!metadata.workspaceId && !metadata.userId) return;
  if (
    !access ||
    metadata.workspaceId !== access.workspaceId ||
    (!access.canManageWorkspace && metadata.userId !== access.userId)
  ) {
    throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
  }
}

function objectKey(fileId: string): string {
  return `transit/${fileId}`;
}

function metadataKey(fileId: string): string {
  return `transit/${fileId}.meta.json`;
}

function assertSafeFileId(fileId: string): void {
  if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(fileId)) {
    throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
  }
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : "";
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

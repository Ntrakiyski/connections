import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type WorkspaceRole = "member" | "manager" | "admin";

/** Request context after token authentication and current-role resolution. */
export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  tokenId?: string;
}

export interface RuntimeTokenRecord {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface RuntimeTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface RuntimeTokenCreation {
  token: string;
  record: RuntimeTokenRecord;
}

export interface RuntimeTokenAccess {
  userId: string;
  canManageWorkspace: boolean;
}

export interface IRuntimeTokenStore {
  add(record: RuntimeTokenRecord): Promise<void>;
  list(): Promise<RuntimeTokenRecord[]>;
  findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined>;
  revoke(id: string): Promise<boolean>;
  revokeByUser(workspaceId: string, userId: string): Promise<void>;
  markUsed(id: string, workspaceId: string, usedAt: string): Promise<void>;
}

const tokenPrefix = "oct_";

export class RuntimeTokenService {
  private readonly store: IRuntimeTokenStore;

  constructor(store: IRuntimeTokenStore) {
    this.store = store;
  }

  async createToken(workspaceId: string, userId: string, name: string): Promise<RuntimeTokenCreation> {
    const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: RuntimeTokenRecord = {
      id: randomUUID(),
      workspaceId,
      userId,
      name: name.trim(),
      tokenHash: hashRuntimeToken(token),
      createdAt: now,
    };
    await this.store.add(record);
    return { token, record };
  }

  async listTokens(access?: RuntimeTokenAccess): Promise<RuntimeTokenSummary[]> {
    const records = await this.store.list();
    return records
      .filter((record) => !access || access.canManageWorkspace || record.userId === access.userId)
      .map(summarizeRuntimeToken);
  }

  async revokeToken(id: string, access?: RuntimeTokenAccess): Promise<boolean> {
    if (access && !access.canManageWorkspace) {
      const record = (await this.store.list()).find((item) => item.id === id);
      if (!record || record.userId !== access.userId) {
        return false;
      }
    }
    return await this.store.revoke(id);
  }

  async revokeTokensForUser(workspaceId: string, userId: string): Promise<void> {
    await this.store.revokeByUser(workspaceId, userId);
  }

  async verifyToken(token: string): Promise<RuntimeTokenContext | undefined> {
    const tokenHash = hashRuntimeToken(token);
    const matched = await this.store.findByHash(tokenHash);
    if (!matched) {
      return undefined;
    }

    if (!equalHashes(matched.tokenHash, tokenHash)) {
      return undefined;
    }

    await this.store.markUsed(matched.id, matched.workspaceId, new Date().toISOString());
    return { workspaceId: matched.workspaceId, userId: matched.userId, tokenId: matched.id };
  }
}

export interface RuntimeTokenContext {
  workspaceId: string;
  userId: string;
  tokenId: string;
}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function summarizeRuntimeToken(record: RuntimeTokenRecord): RuntimeTokenSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

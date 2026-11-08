import type { OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { IIdentityMutationStore } from "./identity-mutations.ts";

import { z } from "zod";
import { OAuthFlowError } from "../../oauth/oauth-flow-service.ts";

export interface ProviderOAuthConsent {
  workspaceId: string;
  userId: string;
  pending: OAuthAuthorizationState;
}
export interface IProviderOAuthConsentStore {
  take(state: string): Promise<ProviderOAuthConsent | undefined>;
}
const rowSchema = z.object({ workspace_id: z.string(), user_id: z.string().nullable(), value: z.string() });
const stateSchema = z.object({
  state: z.string(),
  service: z.string(),
  createdAt: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  connectionName: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  pkceCodeVerifier: z.string().optional(),
});

/** Redeems opaque consent exactly once and derives ownership exclusively from stored facts. */
export class SqlProviderOAuthConsentStore implements IProviderOAuthConsentStore {
  private readonly store: IIdentityMutationStore;
  private readonly codec: ISecretCodec;
  constructor(store: IIdentityMutationStore, codec: ISecretCodec) {
    this.store = store;
    this.codec = codec;
  }

  async take(state: string): Promise<ProviderOAuthConsent | undefined> {
    const result = await this.store.commit([
      { sql: "delete from oauth_states where state=? returning workspace_id, user_id, value", values: [state] },
    ]);
    const rows = result[0]?.rows ?? [];
    if (!rows.length) return undefined;
    if (rows.length !== 1) throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    const decodedRow = rowSchema.safeParse(rows[0]);
    if (!decodedRow.success) throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    const row = decodedRow.data;
    let value: unknown;
    try {
      value = JSON.parse(await this.codec.decode(row.value));
    } catch {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    }
    const parsed = stateSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.state !== state ||
      parsed.data.workspaceId !== row.workspace_id ||
      parsed.data.userId !== row.user_id
    )
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    return { workspaceId: row.workspace_id, userId: parsed.data.userId, pending: parsed.data };
  }
}

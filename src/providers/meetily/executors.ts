import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { MeetilyActionName } from "./actions.ts";

import { defineApiKeyProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";

const service = "meetily";

type MeetilyHandler = (input: Record<string, unknown>, context: ApiKeyProviderContext) => Promise<unknown>;

const retired = async (): Promise<never> => {
  throw new ProviderRequestError(
    410,
    "The Meetily API-key provider is retired; use the Clerk-authenticated Meetings API.",
  );
};

export const meetilyActionHandlers: Record<MeetilyActionName, MeetilyHandler> = {
  list_meetings: retired,
  get_meeting: retired,
  get_latest_meeting: retired,
  search_transcripts: retired,
};

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, meetilyActionHandlers);

export const credentialValidators: CredentialValidators = {
  async apiKey() {
    await retired();
  },
};

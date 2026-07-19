import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { olxActionHandlers, validateOlxCredential } from "./runtime.ts";

const service = "olx";

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, olxActionHandlers);

export const credentialValidators: CredentialValidators = {
  oauth2(input, { fetcher, signal }) {
    return validateOlxCredential(input.accessToken, fetcher, signal);
  },
};

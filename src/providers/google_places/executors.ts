import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { googlePlacesActionHandlers, validateGooglePlacesCredential } from "./runtime.ts";

const service = "google_places";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, googlePlacesActionHandlers);

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    return validateGooglePlacesCredential(input, fetcher, signal);
  },
};

import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { BoardContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { boardActionHandlers, normalizeBoardBaseUrl, validateBoardCredential } from "./runtime.ts";

const service = "board";

export const executors: ProviderExecutors = defineProviderExecutors<BoardContext>({
  service,
  handlers: boardActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<BoardContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      baseUrl: normalizeBoardBaseUrl(credential.values.boardUrl ?? credential.metadata.boardUrl),
      token: credential.apiKey,
      fetcher,
      signal: context.signal,
    };
  },
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateBoardCredential(input.values, input.apiKey, guardedFetcher, signal);
  },
};

import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { BoardContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { boardActionHandlers, createBoardContext, validateBoardCredential } from "./runtime.ts";

const service = "board";

export const executors: ProviderExecutors = defineProviderExecutors<BoardContext>({
  service,
  handlers: boardActionHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<BoardContext> {
    const credential = await requireCustomCredential(context, service);
    return createBoardContext(credential.values, fetcher, context.signal);
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateBoardCredential(input.values, guardedFetcher, signal);
  },
};

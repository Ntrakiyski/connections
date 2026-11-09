import { readBoundedResponseBytes } from "../core/request.ts";
import { createProviderFetch, providerInputError, runProviderRequest } from "./provider-runtime.ts";

export type { ProviderTransitFile } from "./provider-runtime.ts";
export { readTransitFileInput } from "./provider-runtime.ts";

interface UploadSourceInput {
  url: string;
  fetcher: typeof fetch;
  fieldName: string;
  maximumBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Download an upload source through public-only egress with a bounded body. */
export async function downloadUploadSource(
  input: UploadSourceInput,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  return runProviderRequest(
    { label: input.fieldName, timeoutMs: input.timeoutMs ?? 15_000, signal: input.signal },
    async (signal) => {
      const response = await createProviderFetch({ fetch: input.fetcher })(input.url, { signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw providerInputError(`${input.fieldName} download failed with HTTP ${response.status}`);
      }
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: input.maximumBytes ?? 20 * 1024 * 1024,
        fieldName: input.fieldName,
        createError: providerInputError,
      });
      return { bytes, contentType: response.headers.get("content-type") ?? undefined };
    },
  );
}

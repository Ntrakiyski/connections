import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { MeetilyActionName } from "./actions.ts";

import { optionalInteger, requiredString } from "../../core/cast.ts";
import { defineApiKeyProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";

const service = "meetily";
const apiUrl = "https://4ksznmsh.eu-central.insforge.app/functions/meetily";

type MeetilyHandler = (input: Record<string, unknown>, context: ApiKeyProviderContext) => Promise<unknown>;

const handlers: Record<MeetilyActionName, MeetilyHandler> = {
  list_meetings(input, context) {
    return requestMeetings(context, { operation: "list", limit: optionalInteger(input.limit) });
  },
  async get_meeting(input, context) {
    const meetings = await requestMeetings(context, {
      operation: "get",
      externalId: requiredString(input.externalId, "externalId"),
    });
    return { meeting: meetings.meetings[0] ?? null };
  },
  async get_latest_meeting(_input, context) {
    const meetings = await requestMeetings(context, { operation: "latest" });
    return { meeting: meetings.meetings[0] ?? null };
  },
  search_transcripts(input, context) {
    return requestMeetings(context, {
      operation: "search",
      q: requiredString(input.query, "query"),
      limit: optionalInteger(input.limit),
    });
  },
};

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, handlers);

export const credentialValidators: CredentialValidators = {
  async apiKey(input, options) {
    await requestMeetings(
      { apiKey: input.apiKey, fetcher: options.fetcher, signal: options.signal },
      { operation: "latest" },
    );
    return {
      profile: { accountId: "connections-meetily", displayName: "Meetily transcripts" },
      grantedScopes: [],
    };
  },
};

async function requestMeetings(
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  query: Record<string, string | number | undefined>,
): Promise<{ meetings: Record<string, unknown>[] }> {
  const url = new URL(apiUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await context.fetcher(url, {
    headers: { accept: "application/json", authorization: `Bearer ${context.apiKey}` },
    signal: context.signal,
  });
  const payload = (await response.json()) as { error?: string; meetings?: unknown[] };
  if (!response.ok) throw new ProviderRequestError(response.status, payload.error ?? "Meetily request failed", payload);
  return { meetings: (payload.meetings ?? []).map(normalizeMeeting) };
}

function normalizeMeeting(value: unknown): Record<string, unknown> {
  const meeting = value as Record<string, unknown>;
  return {
    externalId: meeting.external_id,
    title: meeting.title,
    ...(meeting.transcript === undefined ? {} : { transcript: meeting.transcript }),
    transcriptSegments: meeting.transcript_segments ?? [],
    summary: meeting.summary ?? null,
    createdAt: meeting.created_at,
    updatedAt: meeting.updated_at,
  };
}

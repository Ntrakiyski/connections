import { describe, expect, it } from "vitest";
import { youtubeActions } from "./actions.ts";
import { youtubeActionHandlers } from "./runtime.ts";
import { youtubeReadScope, youtubeWriteScope } from "./scopes.ts";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

describe("YouTube feed runtime", () => {
  it("lists subscriptions with read-only scope metadata, pagination, and normalized channel data", async () => {
    const requests: RecordedRequest[] = [];
    const result = await youtubeActionHandlers.list_subscriptions(
      { mine: true, maxResults: 25, pageToken: "next-page" },
      {
        accessToken: "token",
        fetcher: createFetcher(requests, {
          items: [
            {
              id: "subscription-1",
              kind: "youtube#subscription",
              snippet: { resourceId: { channelId: "channel-1" }, title: "Creator" },
              contentDetails: { totalItemCount: 42 },
              subscriberSnippet: { title: "Creator" },
            },
          ],
          nextPageToken: "following-page",
          pageInfo: { totalResults: 42, resultsPerPage: 25 },
        }),
      },
    );

    const requestUrl = new URL(requests[0]!.url);
    expect(requestUrl.pathname).toBe("/youtube/v3/subscriptions");
    expect(requestUrl.searchParams.get("part")).toBe("snippet,contentDetails,subscriberSnippet");
    expect(requestUrl.searchParams.get("mine")).toBe("true");
    expect(requestUrl.searchParams.get("maxResults")).toBe("25");
    expect(requestUrl.searchParams.get("pageToken")).toBe("next-page");
    expect(result).toEqual({
      subscriptions: [
        {
          id: "subscription-1",
          kind: "youtube#subscription",
          etag: null,
          snippet: { resourceId: { channelId: "channel-1" }, title: "Creator" },
          contentDetails: { totalItemCount: 42 },
          subscriberSnippet: { title: "Creator" },
          raw: {
            id: "subscription-1",
            kind: "youtube#subscription",
            snippet: { resourceId: { channelId: "channel-1" }, title: "Creator" },
            contentDetails: { totalItemCount: 42 },
            subscriberSnippet: { title: "Creator" },
          },
        },
      ],
      nextPageToken: "following-page",
      prevPageToken: null,
      pageInfo: { totalResults: 42, resultsPerPage: 25 },
    });
    expect(youtubeActions.find((action) => action.name === "list_subscriptions")).toMatchObject({
      requiredScopes: [youtubeReadScope],
    });
    expect(youtubeActions.find((action) => action.name === "create_playlist")?.requiredScopes).toEqual([
      youtubeWriteScope,
    ]);
  });

  it("includes live-stream metadata for feed video lookups", async () => {
    const requests: RecordedRequest[] = [];
    await youtubeActionHandlers.list_videos(
      { ids: ["video-1"] },
      { accessToken: "token", fetcher: createFetcher(requests, { items: [] }) },
    );

    expect(new URL(requests[0]!.url).searchParams.get("part")).toBe(
      "snippet,contentDetails,statistics,status,liveStreamingDetails",
    );
  });

  it("rejects missing subscription filters and preserves YouTube API errors", async () => {
    const requests: RecordedRequest[] = [];
    await expect(
      youtubeActionHandlers.list_subscriptions({}, { accessToken: "token", fetcher: createFetcher(requests, {}) }),
    ).rejects.toMatchObject({ status: 400, message: "mine or channelId is required" });
    expect(requests).toHaveLength(0);

    await expect(
      youtubeActionHandlers.list_subscriptions(
        { channelId: "channel-1" },
        {
          accessToken: "token",
          fetcher: createFetcher(requests, { error: { message: "The request is not authorized" } }, 403),
        },
      ),
    ).rejects.toMatchObject({ status: 403, message: "The request is not authorized" });
  });
});

function createFetcher(requests: RecordedRequest[], payload: unknown, status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json(payload, { status });
  }) as typeof fetch;
}

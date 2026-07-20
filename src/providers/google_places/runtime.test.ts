import { describe, expect, it } from "vitest";
import { googlePlacesActionHandlers, validateGooglePlacesCredential } from "./runtime.ts";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

describe("Google Places runtime", () => {
  it("sends API key, field mask, and request body to Places API (New)", async () => {
    const requests: RecordedRequest[] = [];
    const fetcher = createFetcher(requests, { places: [{ id: "place-1", rating: 4.8 }] });

    const output = await googlePlacesActionHandlers.search_text(
      {
        fieldMask: "places.id,places.rating,places.reviews",
        textQuery: "coffee in Sofia",
        pageSize: 5,
      },
      { apiKey: "key-123", fetcher },
    );

    expect(output).toEqual({ places: [{ id: "place-1", rating: 4.8 }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(requests[0]!.init).toMatchObject({ method: "POST" });
    expect(new Headers(requests[0]!.init?.headers).get("x-goog-api-key")).toBe("key-123");
    expect(new Headers(requests[0]!.init?.headers).get("x-goog-fieldmask")).toBe(
      "places.id,places.rating,places.reviews",
    );
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      textQuery: "coffee in Sofia",
      pageSize: 5,
    });
  });

  it("encodes place IDs and forwards supported Place Details query parameters", async () => {
    const requests: RecordedRequest[] = [];
    const fetcher = createFetcher(requests, { id: "abc/def", rating: 4.9, reviews: [] });

    await googlePlacesActionHandlers.get_place_details(
      {
        fieldMask: "id,rating,reviews",
        placeId: "abc/def",
        languageCode: "bg",
        regionCode: "BG",
      },
      { apiKey: "key-123", fetcher },
    );

    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/v1/places/abc%2Fdef");
    expect(url.searchParams.get("languageCode")).toBe("bg");
    expect(url.searchParams.get("regionCode")).toBe("BG");
    expect(requests[0]!.init).toMatchObject({ method: "GET" });
    expect(requests[0]!.init?.body).toBeUndefined();
  });

  it("maps nearby searches to the dedicated endpoint", async () => {
    const requests: RecordedRequest[] = [];
    const fetcher = createFetcher(requests, { places: [] });

    await googlePlacesActionHandlers.search_nearby(
      {
        fieldMask: "places.id,places.displayName",
        locationRestriction: {
          circle: { center: { latitude: 42.6977, longitude: 23.3219 }, radius: 1_000 },
        },
      },
      { apiKey: "key-123", fetcher },
    );

    expect(requests[0]!.url).toBe("https://places.googleapis.com/v1/places:searchNearby");
  });

  it("rejects field masks containing whitespace before making a request", async () => {
    const requests: RecordedRequest[] = [];

    expect(() =>
      googlePlacesActionHandlers.search_text(
        { fieldMask: "places.id, places.rating", textQuery: "coffee" },
        { apiKey: "key-123", fetcher: createFetcher(requests, {}) },
      ),
    ).toThrow("fieldMask must not contain spaces");
    expect(requests).toHaveLength(0);
  });

  it("preserves Google error messages and status for execution failures", async () => {
    const requests: RecordedRequest[] = [];

    await expect(
      googlePlacesActionHandlers.search_text(
        { fieldMask: "places.id", textQuery: "coffee" },
        {
          apiKey: "bad-key",
          fetcher: createFetcher(requests, { error: { message: "API key not valid" } }, 403),
        },
      ),
    ).rejects.toMatchObject({ status: 403, message: "API key not valid" });
  });

  it("validates a key with a minimal text search", async () => {
    const requests: RecordedRequest[] = [];
    const result = await validateGooglePlacesCredential(
      { apiKey: "key-123" },
      createFetcher(requests, { id: "ChIJj61dQgK6j4AR4GeTYWZsKWw" }),
    );

    expect(result.profile).toEqual({
      accountId: "google_places",
      displayName: "Google Places API Key",
    });
    expect(requests[0]!.url).toBe("https://places.googleapis.com/v1/places/ChIJj61dQgK6j4AR4GeTYWZsKWw");
    expect(new Headers(requests[0]!.init?.headers).get("x-goog-fieldmask")).toBe("id");
    expect(requests[0]!.init).toMatchObject({ method: "GET" });
    expect(requests[0]!.init?.body).toBeUndefined();
  });
});

function createFetcher(requests: RecordedRequest[], payload: unknown, status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

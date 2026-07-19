import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { olxActionHandlers, validateOlxCredential } from "./runtime.ts";

describe("OLX runtime", () => {
  it("sends OAuth and Version headers and normalizes advert list filters", async () => {
    const requests: Request[] = [];
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        data: [
          {
            id: 123,
            status: "active",
            url: "https://www.olx.bg/d/ad/example",
            title: "Example advert",
            description: "Example description",
            category_id: 42,
            advertiser_type: "business",
            external_id: "ext-1",
            created_at: "2026-07-18 10:00:00",
            activated_at: "2026-07-18 10:01:00",
            valid_to: "2026-08-18 10:01:00",
          },
        ],
      });
    };

    const result = await olxActionHandlers.list_adverts(
      { offset: 10, limit: 5, externalId: "ext-1", categoryIds: [42, 43] },
      {
        accessToken: "access-token",
        tokenType: "Bearer",
        fetcher,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://www.olx.bg/api/partner/adverts?offset=10&limit=5&external_id=ext-1&category_ids=42%2C43",
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer access-token");
    expect(requests[0].headers.get("version")).toBe("2.0");
    expect(result).toMatchObject({
      adverts: [
        {
          id: 123,
          status: "active",
          title: "Example advert",
          categoryId: 42,
          advertiserType: "business",
          externalId: "ext-1",
        },
      ],
    });
  });

  it("interpolates path params and sends JSON bodies for write actions", async () => {
    const requests: Request[] = [];
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        id: 91,
        text: "Hi",
      });
    };

    const result = await olxActionHandlers.post_thread_message(
      { threadId: 9, body: { text: "Hi" } },
      {
        accessToken: "access-token",
        tokenType: "Bearer",
        fetcher,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://www.olx.bg/api/partner/threads/9/messages");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("content-type")).toContain("application/json");
    await expect(requests[0].json()).resolves.toEqual({ text: "Hi" });
    expect(result).toEqual({
      message: {
        id: 91,
        text: "Hi",
      },
    });
  });

  it("validates credentials with the current user endpoint", async () => {
    const requests: Request[] = [];
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        id: 77,
        email: "partner@example.com",
        name: "OLX Partner",
        status: "confirmed",
        is_business: true,
      });
    };

    await expect(validateOlxCredential("access-token", fetcher)).resolves.toMatchObject({
      profile: {
        accountId: "olx:user:77",
        displayName: "partner@example.com",
      },
      metadata: {
        apiVersion: "2.0",
        userId: 77,
        isBusiness: true,
      },
    });
    expect(requests[0].url).toBe("https://www.olx.bg/api/partner/users/me");
  });

  it("maps OLX error envelopes to provider errors", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json(
        {
          error: {
            status: 403,
            title: "Forbidden",
            detail: "Scope is missing.",
          },
        },
        { status: 403 },
      );

    await expect(
      olxActionHandlers.list_regions(
        {},
        {
          accessToken: "access-token",
          tokenType: "Bearer",
          fetcher,
        },
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: "Scope is missing.",
    } satisfies Partial<ProviderRequestError>);
  });
});

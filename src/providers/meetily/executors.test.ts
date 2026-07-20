import { describe, expect, it, vi } from "vitest";
import { meetilyActionHandlers } from "./executors.ts";

describe("Meetily provider", () => {
  it("is retired locally instead of calling the retired 410 endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(meetilyActionHandlers.list_meetings({}, { apiKey: "key", fetcher })).rejects.toMatchObject({
      status: 410,
      message: expect.stringContaining("retired"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

import type { BoardContext } from "./runtime.ts";

import { describe, expect, it } from "vitest";
import { boardActionHandlers, normalizeBoardBaseUrl } from "./runtime.ts";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

describe("Board runtime", () => {
  it("normalizes Board server root URLs", () => {
    expect(normalizeBoardBaseUrl("https://board.example.com/")).toBe("https://board.example.com");
    expect(() => normalizeBoardBaseUrl("https://board.example.com/app")).toThrow("root URL");
    expect(() => normalizeBoardBaseUrl("https://user:pass@board.example.com")).toThrow("credentials");
    expect(() => normalizeBoardBaseUrl("https://board.example.com?x=1")).toThrow("query");
    expect(normalizeBoardBaseUrl("http://100.123.30.5:5421")).toBe("http://100.123.30.5:5421");
  });

  it("maps the selected OpenAPI operations to Board requests", async () => {
    const { fetcher, requests } = createFetcher();
    const context: BoardContext = {
      baseUrl: "https://board.example.com",
      token: "bd_board-token",
      fetcher,
    };

    await boardActionHandlers.list_boards({}, context);
    await boardActionHandlers.read_board({ roomId: "client/a" }, context);
    await boardActionHandlers.get_board_snapshot({ roomId: "client/a" }, context);
    await boardActionHandlers.rename_board({ roomId: "client/a", name: "Client A" }, context);
    await boardActionHandlers.create_or_update_records(
      { roomId: "client/a", records: [{ id: "shape:1", typeName: "shape", type: "geo" }] },
      context,
    );
    await boardActionHandlers.delete_records({ roomId: "client/a", recordIds: ["shape:1"] }, context);

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["GET", "https://board.example.com/api/boards"],
      ["GET", "https://board.example.com/api/boards/client%2Fa"],
      ["GET", "https://board.example.com/api/boards/client%2Fa/snapshot"],
      ["PATCH", "https://board.example.com/api/boards/client%2Fa"],
      ["POST", "https://board.example.com/api/boards/client%2Fa/records"],
      ["DELETE", "https://board.example.com/api/boards/client%2Fa/records"],
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer bd_board-token");
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ name: "Client A" });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      records: [{ id: "shape:1", typeName: "shape", type: "geo" }],
    });
    expect(JSON.parse(String(requests[5]?.init?.body))).toEqual({ recordIds: ["shape:1"] });
  });
});

function createFetcher(): { fetcher: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: input instanceof Request ? input.url : String(input), init });
    return Response.json({ boards: [] });
  };
  return { fetcher, requests };
}

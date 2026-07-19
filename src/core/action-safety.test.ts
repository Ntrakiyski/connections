import type { ActionDefinition } from "./types.ts";

import { describe, expect, it } from "vitest";
import {
  actionSafetyMetadata,
  inferActionRiskTags,
  normalizeSafetyConfigPatch,
  resolveWorkspaceSafetyConfig,
} from "./action-safety.ts";

const baseAction: ActionDefinition = {
  id: "example.get_item",
  service: "example",
  name: "Get item",
  description: "Get one item.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

describe("action safety metadata", () => {
  it("infers read and mutating action risk tags", () => {
    expect(inferActionRiskTags({ id: "gmail.search_messages", name: "Search messages" })).toEqual(["read"]);
    expect(inferActionRiskTags({ id: "gmail.send_message", name: "Send message" })).toEqual(["send"]);
    expect(inferActionRiskTags({ id: "github.delete_issue", name: "Delete issue" })).toEqual([
      "delete",
      "irreversible",
    ]);
  });

  it("honors explicit risk tags and idempotency metadata", () => {
    expect(
      actionSafetyMetadata({
        ...baseAction,
        riskTags: ["admin", "write"],
        idempotency: "required",
      }),
    ).toEqual({
      riskTags: ["admin", "write"],
      idempotency: "required",
      retryable: false,
    });
  });

  it("normalizes and resolves workspace plus provider config patches", () => {
    const workspace = normalizeSafetyConfigPatch({
      idempotency: { mode: "enforce" },
      retry: { mode: "enforce", maxAttempts: 4, baseDelayMs: 100, maxDelayMs: "bad" },
      rateLimit: { mode: "enforce", maxConcurrent: 6 },
    });
    const provider = normalizeSafetyConfigPatch({
      retry: { maxAttempts: 2 },
      scopePreflight: { mode: "enforce" },
    });

    expect(workspace).toEqual({
      idempotency: { mode: "enforce" },
      retry: { mode: "enforce", maxAttempts: 4, baseDelayMs: 100 },
      rateLimit: { mode: "enforce", maxConcurrent: 6 },
    });
    expect(resolveWorkspaceSafetyConfig(workspace, provider).resolved).toMatchObject({
      scopePreflight: { mode: "enforce" },
      idempotency: { mode: "enforce" },
      retry: { mode: "enforce", maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 2000 },
      rateLimit: { mode: "enforce", maxConcurrent: 6 },
    });
  });
});

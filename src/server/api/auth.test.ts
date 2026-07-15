import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createWorkspaceAuthMiddleware, getWorkspaceContext } from "./auth.ts";

describe("workspace auth", () => {
  it("sets the default admin workspace when local authentication is not configured", async () => {
    const app = new Hono();
    app.use("*", createWorkspaceAuthMiddleware({}));
    app.get("/private", (context) => context.json(getWorkspaceContext(context)));

    const response = await app.request("/private");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "default",
      userId: "admin",
      role: "admin",
    });
  });
});

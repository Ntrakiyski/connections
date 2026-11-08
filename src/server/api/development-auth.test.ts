import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDevelopmentAuthMiddleware } from "./development-auth.ts";
import { HttpRequestError } from "./http-utils.ts";

describe("explicit development authentication", () => {
  function app(): Hono {
    const app = new Hono();
    app.onError((error, context) =>
      context.json({ error: "denied" }, error instanceof HttpRequestError ? error.status : 500),
    );
    app.use("*", createDevelopmentAuthMiddleware());
    app.get("*", (context) => context.json(context.get("workspace")));
    return app;
  }
  it("retains the explicit local workspace for provider development", async () => {
    expect(await (await app().request("http://localhost/api/connections")).json()).toEqual({
      workspaceId: "default",
      userId: "local-dev",
      role: "admin",
    });
  });
  it.each(["/api/identity/get-session", "/api/account", "/api/companies", "/api/meetings"])(
    "does not synthesize a human session for %s",
    async (path) => {
      expect((await app().request("http://localhost" + path)).status).toBe(401);
    },
  );
});

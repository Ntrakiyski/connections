import type { CloudflareEnv } from "./cloudflare/cloudflare-env.ts";
import type { AuthMail } from "./human-auth.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./cloudflare.ts";
import { FixtureD1Database } from "./test-fixtures/sqlite-d1.ts";

const delivery = vi.hoisted(() => ({ mail: [] as AuthMail[] }));
vi.mock("./auth-mail.ts", () => ({
  createAuthMailDelivery: () => async (mail: AuthMail) => {
    delivery.mail.push(mail);
  },
}));
const databases: FixtureD1Database[] = [];
const origin = "https://connections-worker.example.test";
const execution = { waitUntil() {}, passThroughOnException() {} };

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
  delivery.mail.length = 0;
});

function environment(): CloudflareEnv {
  const database = new FixtureD1Database();
  databases.push(database);
  return {
    DB: database,
    TRANSIT_FILES: {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    },
    ASSETS: {
      async fetch() {
        return Response.json([]);
      },
    },
    BETTER_AUTH_SECRET: "synthetic-worker-auth-secret-at-least-32-characters",
    BETTER_AUTH_URL: origin,
    OOMOL_CONNECT_ENCRYPTION_KEY: "synthetic-worker-encryption-key",
    SMTP_URL: "smtp://localhost:1025",
    SMTP_FROM: "Connections <noreply@example.test>",
  };
}

function request(
  env: CloudflareEnv,
  path: string,
  body?: unknown,
  cookie = "",
  requestOrigin = origin,
): Promise<Response> {
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: requestOrigin, cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    execution,
  );
}

describe("Worker authentication entry point", () => {
  it("refuses incomplete production settings before accessing assets or database", async () => {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "OOMOL_CONNECT_ENCRYPTION_KEY",
      "SMTP_URL",
      "SMTP_FROM",
    ] as const) {
      const env = environment();
      env[key] = undefined;
      await expect(request(env, "/health")).rejects.toThrow(`${key} is required.`);
    }
    const env = environment();
    env.NODE_ENV = "development";
    env.HOST = "127.0.0.1";
    env.CONNECTIONS_DEV_AUTH_BYPASS = "true";
    await expect(request(env, "/health")).rejects.toThrow("loopback request URL");
  });

  it("serves verified secure-cookie sessions through the real Hono handler and D1 dialect", async () => {
    const env = environment();
    const credentials = { email: "operator@example.test", password: "synthetic-worker-password-12345" };
    expect((await request(env, "/api/identity/sign-up/email", { ...credentials, name: "Operator" })).status).toBe(200);
    expect((await request(env, "/api/identity/sign-in/email", credentials)).status).toBe(403);
    const message = delivery.mail.find((mail) => mail.subject === "Verify your Connections email");
    if (!message) throw new Error("Verification email was not delivered.");
    const verify = await worker.fetch(new Request(message.text.replace("Verify your email: ", "")), env, execution);
    expect(verify.status).toBe(302);
    const signIn = await request(env, "/api/identity/sign-in/email", credentials);
    expect(signIn.status).toBe(200);
    const setCookies = signIn.headers.getSetCookie();
    expect(
      setCookies.some(
        (cookie) =>
          cookie.includes("__Secure-better-auth.session_token=") &&
          cookie.includes("Secure") &&
          cookie.includes("HttpOnly"),
      ),
    ).toBe(true);
    const cookie = setCookies.map((header) => header.split(";")[0]).join("; ");
    const account = await request(env, "/api/account", undefined, cookie);
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ user: { email: credentials.email }, workspaces: [] });
    expect(
      (await request(env, "/api/identity/organization/create", { name: "Bypass", slug: "bypass" }, cookie)).status,
    ).toBe(403);
    expect((await request(env, "/api/auth/logout", {}, cookie, "https://attacker.example")).status).toBe(403);
    expect((await request(env, "/api/account", undefined, cookie)).status).toBe(200);
    expect((await request(env, "/api/auth/logout", {}, cookie)).status).toBe(200);
    expect((await request(env, "/api/account", undefined, cookie)).status).toBe(401);
  });
});

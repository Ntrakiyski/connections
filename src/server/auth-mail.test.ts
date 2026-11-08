import { afterEach, expect, it, vi } from "vitest";
import { readDeploymentAuthSettings } from "./auth-config.ts";
import { createAuthMailDelivery } from "./auth-mail.ts";

const settings = readDeploymentAuthSettings({
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
  BETTER_AUTH_URL: "https://connections.example.test",
  DATABASE_URL: "postgresql://synthetic@localhost/fixture",
  OOMOL_CONNECT_ENCRYPTION_KEY: "synthetic-encryption-key",
  AUTH_MAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "synthetic-private-resend-key",
  SMTP_FROM: "Connections <noreply@example.test>",
});
if (settings.kind !== "sessions") throw new Error("Expected session configuration");
const send = createAuthMailDelivery(settings);
const mail = {
  to: "recipient@example.test",
  subject: "Verify your email",
  text: "https://connections.example.test/verify",
};
afterEach(() => vi.unstubAllGlobals());

it("submits the original auth message to the fixed HTTPS provider and requires acknowledgment", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "synthetic-message-id" }));
  vi.stubGlobal("fetch", fetcher);
  await send(mail);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.resend.com/emails",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer synthetic-private-resend-key", "Content-Type": "application/json" },
      body: JSON.stringify({ from: settings.mailFrom, ...mail }),
    }),
  );
});

it.each([
  Response.json({ error: "synthetic-private-resend-key" }, { status: 403 }),
  Response.json({}),
  Response.json({ id: "" }),
  new Response("untrusted provider body"),
])("fails closed without exposing provider response data", async (response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(send(mail)).rejects.toThrow("Authentication email delivery failed.");
});

it("sanitizes network failure details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic-private-resend-key")));
  await expect(send(mail)).rejects.toThrow("Authentication email delivery failed.");
});

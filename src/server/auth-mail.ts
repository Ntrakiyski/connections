import type { SessionAuthSettings } from "./auth-config.ts";
import type { AuthMailDelivery } from "./human-auth.ts";

import nodemailer from "nodemailer";

/** Mail credentials stay server-only; delivery failures propagate without exposing provider responses. */
export function createAuthMailDelivery(settings: SessionAuthSettings): AuthMailDelivery {
  const delivery = settings.mail;
  if (delivery.kind === "resend") {
    return async (mail) => {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${delivery.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: settings.mailFrom, ...mail }),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Mail delivery rejected.");
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id) {
          throw new Error("Mail delivery was not acknowledged.");
        }
      } catch {
        throw new Error("Authentication email delivery failed.");
      }
    };
  }
  const transport = nodemailer.createTransport(delivery.url);
  return async (mail) => {
    await transport.sendMail({ from: settings.mailFrom, ...mail });
  };
}

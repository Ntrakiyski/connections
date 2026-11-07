import type { SessionAuthSettings } from "./auth-config.ts";
import type { AuthMailDelivery } from "./human-auth.ts";

import nodemailer from "nodemailer";

/** SMTP credentials remain server-only and delivery failures propagate to the auth flow. */
export function createAuthMailDelivery(settings: SessionAuthSettings): AuthMailDelivery {
  const transport = nodemailer.createTransport(settings.smtpURL);
  return async (mail) => {
    await transport.sendMail({ from: settings.mailFrom, ...mail });
  };
}

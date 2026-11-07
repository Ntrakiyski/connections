export interface SessionAuthSettings {
  kind: "sessions";
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  smtpURL: string;
  mailFrom: string;
}

export type DeploymentAuthSettings = SessionAuthSettings | { kind: "development-bypass" };

/** Parses server configuration before any listener or local-data initialization starts. */
export function readDeploymentAuthSettings(
  env: Record<string, string | undefined>,
  mode: "node" | "worker" = "node",
): DeploymentAuthSettings {
  const development = env.NODE_ENV === "development";
  const hostname = env.HOST ?? "127.0.0.1";
  if (env.CONNECTIONS_DEV_AUTH_BYPASS === "true") {
    if (!development || !["127.0.0.1", "::1", "localhost"].includes(hostname)) {
      throw new Error("The authentication bypass requires explicit development mode and a loopback listener.");
    }
    return { kind: "development-bypass" };
  }
  const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  const baseURL = required(env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
  const url = new URL(baseURL);
  if (url.origin !== baseURL || (!development && url.protocol !== "https:")) {
    throw new Error("BETTER_AUTH_URL must be an exact HTTPS origin for hosted deployments.");
  }
  if (env.OOMOL_CONNECT_ORIGIN && env.OOMOL_CONNECT_ORIGIN !== baseURL) {
    throw new Error("BETTER_AUTH_URL and OOMOL_CONNECT_ORIGIN must agree.");
  }
  if (!development) {
    if (mode === "node") {
      const databaseURL = new URL(required(env.DATABASE_URL, "DATABASE_URL"));
      if (!["postgres:", "postgresql:"].includes(databaseURL.protocol))
        throw new Error("Hosted Node sessions require a PostgreSQL DATABASE_URL.");
    }
    required(env.OOMOL_CONNECT_ENCRYPTION_KEY, "OOMOL_CONNECT_ENCRYPTION_KEY");
  }
  const trustedOrigins = [baseURL, ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? [])].map((value) => value.trim());
  for (const origin of trustedOrigins) {
    if (!origin || new URL(origin).origin !== origin || (!development && !origin.startsWith("https://"))) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS requires exact trusted origins.");
    }
  }
  return {
    kind: "sessions",
    secret,
    baseURL,
    trustedOrigins: [...new Set(trustedOrigins)],
    smtpURL: required(env.SMTP_URL, "SMTP_URL"),
    mailFrom: required(env.SMTP_FROM, "SMTP_FROM"),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}

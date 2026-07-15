/**
 * Makes PostgreSQL TLS handling explicit before passing a connection string to
 * pg. pg currently treats these modes as `verify-full` aliases and warns that
 * their behavior will change in its next major release.
 */
export function normalizePostgresConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "prefer" || sslmode === "require" || sslmode === "verify-ca") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

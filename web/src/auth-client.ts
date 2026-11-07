import { createAuthClient } from "better-auth/react";

/** Personal identity only. Company governance uses Connections application routes. */
export const authClient = createAuthClient({ basePath: "/api/identity" });

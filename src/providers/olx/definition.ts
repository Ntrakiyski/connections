import type { ProviderDefinition } from "../../core/types.ts";

import { olxActions } from "./actions.ts";
import { olxOAuthScopes } from "./scopes.ts";

const service = "olx";

export const provider: ProviderDefinition = {
  service,
  displayName: "OLX",
  description: "Manage OLX Partner API account data, regions, cities, categories, and adverts.",
  categories: ["Commerce"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://www.olx.bg/oauth/authorize",
      tokenUrl: "https://www.olx.bg/api/open/oauth/token",
      refreshTokenUrl: "https://www.olx.bg/api/open/oauth/token",
      scopes: olxOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
  homepageUrl: "https://www.olx.bg",
  actions: olxActions,
};

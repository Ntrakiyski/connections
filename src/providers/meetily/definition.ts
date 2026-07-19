import type { ProviderDefinition } from "../../core/types.ts";

import { meetilyActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "meetily",
  displayName: "Meetily",
  categories: ["AI", "Productivity"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Connections API Key",
      placeholder: "MEETILY_CONNECTIONS_API_KEY",
      description: "The dedicated Meetily API key configured for the Connections InsForge project.",
    },
  ],
  iconUrl: "/meetily-icon.png",
  homepageUrl: "https://github.com/Zackriya-Solutions/meetily",
  actions: meetilyActions,
};

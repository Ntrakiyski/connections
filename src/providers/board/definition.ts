import type { ProviderDefinition } from "../../core/types.ts";

import { boardActions } from "./actions.ts";

const service = "board";

/** Self-hosted collaborative tldraw boards exposed through the Board REST API. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Board",
  description: "Read and update collaborative tldraw boards hosted on your own Board server.",
  categories: ["Productivity", "Design & Media"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Board workspace token",
      placeholder: "bd_...",
      description:
        "A scoped Board workspace token created from the Board API while signed in with Clerk. The token only grants access to one Clerk organization workspace.",
      extraFields: [
        {
          key: "boardUrl",
          label: "Board URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://100.64.0.2:5421",
          description:
            "The root URL of the self-hosted Board server. Public addresses work by default; Tailscale and private-network targets require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the Connections runtime.",
        },
      ],
    },
  ],
  iconUrl: "/board-icon.png",
  homepageUrl: "https://github.com/Ntrakiyski/board",
  actions: boardActions,
};

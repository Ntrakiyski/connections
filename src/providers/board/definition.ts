import type { ProviderDefinition } from "../../core/types.ts";

import { boardActions } from "./actions.ts";

const service = "board";

/** Self-hosted collaborative tldraw boards exposed through the Board REST API. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Board",
  description: "Read and update collaborative tldraw boards hosted on your own Board server.",
  categories: ["Productivity", "Design & Media"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Board URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://100.64.0.2:5421",
          description:
            "The root URL of the self-hosted Board server. Public addresses work by default; Tailscale and private-network targets require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the Connections runtime. Loopback, reserved, and cloud-metadata targets remain blocked.",
        },
        {
          key: "bearerToken",
          label: "Bearer Token",
          inputType: "password",
          required: false,
          secret: true,
          placeholder: "Optional deployment access token",
          description:
            "Optional bearer token for Board deployments that require one. Leave blank when the server relies on private-network access without application authentication.",
        },
      ],
      testAction: { actionName: "list_boards", input: {} },
    },
  ],
  iconUrl: "/board-icon.png",
  homepageUrl: "https://github.com/Ntrakiyski/board",
  actions: boardActions,
};

import type { ProviderDefinition } from "../../core/types.ts";

import { googlePlacesActions } from "./actions.ts";

const service = "google_places";

export const provider: ProviderDefinition = {
  service,
  displayName: "Google Places API (New)",
  categories: ["Location", "Developer Tools"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "GOOGLE_MAPS_API_KEY",
      description:
        "Google Maps Platform API key with Places API (New) enabled. Create or manage it in the Google Cloud Console: https://developers.google.com/maps/documentation/places/web-service/get-api-key",
      extraFields: [],
    },
  ],
  homepageUrl: "https://developers.google.com/maps/documentation/places/web-service/overview",
  actions: googlePlacesActions,
};

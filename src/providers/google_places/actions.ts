import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "google_places";

const searchFieldMaskSchema = s.string({
  minLength: 1,
  pattern: "^\\S+$",
  description:
    "Google Places response fields without spaces, sent as the `X-Goog-FieldMask` header; for example `places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.reviews`.",
});
const detailsFieldMaskSchema = s.string({
  minLength: 1,
  pattern: "^\\S+$",
  description:
    "Place fields without spaces, sent as the `X-Goog-FieldMask` header; for example `id,displayName,formattedAddress,location,rating,userRatingCount,reviews`.",
});
const localizedTextSchema = s.looseObject(
  {
    text: s.string("Localized text."),
    languageCode: s.string("BCP-47 language code for the text."),
  },
  { description: "Google localized text." },
);
const latLngSchema = s.looseObject(
  {
    latitude: s.number("Latitude in degrees."),
    longitude: s.number("Longitude in degrees."),
  },
  { description: "A geographic coordinate." },
);
const latLngInputSchema = s.object("A geographic coordinate.", {
  latitude: s.number("Latitude in degrees.", { minimum: -90, maximum: 90 }),
  longitude: s.number("Longitude in degrees.", { minimum: -180, maximum: 180 }),
});
const reviewSchema = s.looseObject(
  {
    name: s.string("Review resource name."),
    rating: s.number("Review rating from 1 to 5."),
    text: localizedTextSchema,
    originalText: localizedTextSchema,
    relativePublishTimeDescription: s.string("Human-readable relative publication time."),
    publishTime: s.dateTime("Review publication time."),
    googleMapsUri: s.url("Google Maps URL for the review."),
  },
  { description: "A Google Places review." },
);
const placeSchema = s.looseObject(
  {
    name: s.string("Place resource name in `places/{place_id}` form."),
    id: s.string("Unique Google place ID."),
    displayName: localizedTextSchema,
    formattedAddress: s.string("Full human-readable address."),
    shortFormattedAddress: s.string("Short human-readable address."),
    location: latLngSchema,
    types: s.stringArray("Google place types.", { itemDescription: "One place type." }),
    primaryType: s.string("Primary Google place type."),
    businessStatus: s.string("Current business status."),
    rating: s.number("Average user rating from 1 to 5."),
    userRatingCount: s.integer("Number of user ratings."),
    reviews: s.array("Up to five reviews, sorted by relevance.", reviewSchema),
    priceLevel: s.string("Google price-level enum value."),
    nationalPhoneNumber: s.string("Phone number in national format."),
    internationalPhoneNumber: s.string("Phone number in international format."),
    websiteUri: s.url("Authoritative website for the place."),
    googleMapsUri: s.url("Google Maps URL for the place."),
    regularOpeningHours: upstreamObject("Regular opening hours."),
    currentOpeningHours: upstreamObject("Opening hours for the next seven days."),
  },
  { description: "A Google Places place resource." },
);
const searchOutputSchema = s.looseObject(
  {
    places: s.array("Places matching the search.", placeSchema),
    nextPageToken: s.string("Token for the next page of text-search results."),
    routingSummaries: s.array(
      "Optional routing summaries for returned places.",
      upstreamObject("One routing summary."),
    ),
    searchUri: s.url("Google Maps URL for the search."),
  },
  { description: "Google Places search response." },
);

const textSearchInputSchema = s.looseRequiredObject(
  "Input for Google Places API (New) Text Search.",
  {
    fieldMask: searchFieldMaskSchema,
    textQuery: s.nonEmptyString("Text query, such as `coffee in Sofia` or `Eiffel Tower`."),
    pageSize: s.integer("Maximum results per page.", { minimum: 1, maximum: 20 }),
    pageToken: s.string("Token returned by a previous text search."),
    languageCode: s.string("Preferred BCP-47 response language."),
    regionCode: s.string("Two-letter CLDR region code."),
    rankPreference: s.stringEnum("Text-search ranking preference.", ["DISTANCE", "RELEVANCE"]),
    includedType: s.string("Single Google place type to include."),
    strictTypeFiltering: s.boolean("Return only places matching includedType."),
    openNow: s.boolean("Return only places currently open."),
    minRating: s.number("Minimum average rating from 0 to 5.", { minimum: 0, maximum: 5 }),
    locationBias: upstreamObject("Optional location bias; cannot be combined with locationRestriction."),
    locationRestriction: upstreamObject("Optional location restriction; cannot be combined with locationBias."),
  },
  {
    optional: [
      "pageSize",
      "pageToken",
      "languageCode",
      "regionCode",
      "rankPreference",
      "includedType",
      "strictTypeFiltering",
      "openNow",
      "minRating",
      "locationBias",
      "locationRestriction",
    ],
  },
);
const nearbySearchInputSchema = s.looseRequiredObject(
  "Input for Google Places API (New) Nearby Search.",
  {
    fieldMask: searchFieldMaskSchema,
    locationRestriction: s.object("Circular area to search.", {
      circle: s.object("Search circle with a center and radius.", {
        center: latLngInputSchema,
        radius: s.number("Radius in meters, from 0 to 50000.", { minimum: 0, maximum: 50_000 }),
      }),
    }),
    includedTypes: s.stringArray("Place types to include.", {
      minItems: 1,
      maxItems: 50,
      itemDescription: "One place type.",
    }),
    excludedTypes: s.stringArray("Place types to exclude.", {
      minItems: 1,
      maxItems: 50,
      itemDescription: "One place type.",
    }),
    includedPrimaryTypes: s.stringArray("Primary place types to include.", {
      minItems: 1,
      maxItems: 50,
      itemDescription: "One primary place type.",
    }),
    excludedPrimaryTypes: s.stringArray("Primary place types to exclude.", {
      minItems: 1,
      maxItems: 50,
      itemDescription: "One primary place type.",
    }),
    maxResultCount: s.integer("Maximum results.", { minimum: 1, maximum: 20 }),
    rankPreference: s.stringEnum("Nearby-search ranking preference.", ["DISTANCE", "POPULARITY"]),
    languageCode: s.string("Preferred BCP-47 response language."),
    regionCode: s.string("Two-letter CLDR region code."),
  },
  {
    optional: [
      "includedTypes",
      "excludedTypes",
      "includedPrimaryTypes",
      "excludedPrimaryTypes",
      "maxResultCount",
      "rankPreference",
      "languageCode",
      "regionCode",
    ],
  },
);
const placeDetailsInputSchema = s.object(
  "Input for Google Places API (New) Place Details.",
  {
    fieldMask: detailsFieldMaskSchema,
    placeId: s.nonEmptyString("Google place ID returned by a search action."),
    languageCode: s.string("Preferred BCP-47 response language."),
    regionCode: s.string("Two-letter CLDR region code."),
    sessionToken: s.string({
      minLength: 1,
      maxLength: 36,
      pattern: "^[A-Za-z0-9_-]+$",
      description: "Optional Places Autocomplete session token for billing.",
    }),
  },
  { optional: ["languageCode", "regionCode", "sessionToken"] },
);

export const googlePlacesActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "search_text",
    description: "Search for places and locations using a natural-language text query.",
    inputSchema: textSearchInputSchema,
    outputSchema: searchOutputSchema,
  }),
  defineProviderAction(service, {
    name: "search_nearby",
    description: "Search for places within a circular area, optionally filtered by place type.",
    inputSchema: nearbySearchInputSchema,
    outputSchema: searchOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_place_details",
    description: "Get details, ratings, and reviews for a Google place ID.",
    inputSchema: placeDetailsInputSchema,
    outputSchema: placeSchema,
  }),
];

export type GooglePlacesActionName = "search_text" | "search_nearby" | "get_place_details";

function upstreamObject(description: string): JsonSchema {
  return s.record(description, s.unknown("A nested Google Places API JSON property value."));
}

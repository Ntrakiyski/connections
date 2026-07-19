import type { JsonSchema } from "../../core/types.ts";

import { olxReadScopes, olxWriteScopes } from "./scopes.ts";

export type OlxActionName =
  | "get_current_user"
  | "get_user"
  | "list_regions"
  | "get_region"
  | "list_cities"
  | "get_city"
  | "list_city_districts"
  | "list_districts"
  | "get_district"
  | "get_locations"
  | "list_languages"
  | "list_currencies"
  | "list_categories"
  | "get_category"
  | "list_category_attributes"
  | "suggest_categories"
  | "list_threads"
  | "get_thread"
  | "list_thread_messages"
  | "post_thread_message"
  | "get_thread_message"
  | "run_thread_command"
  | "list_paid_features"
  | "list_advert_paid_features"
  | "purchase_advert_paid_feature"
  | "list_adverts"
  | "create_advert"
  | "get_advert"
  | "update_advert"
  | "delete_advert"
  | "run_advert_command"
  | "get_advert_statistics"
  | "clear_advert_statistic"
  | "list_advert_logos"
  | "add_advert_logo"
  | "delete_advert_logo"
  | "get_account_balance"
  | "list_payment_methods"
  | "get_business_user"
  | "update_business_user"
  | "list_business_logos"
  | "set_business_logo"
  | "delete_business_logo"
  | "list_business_banners"
  | "set_business_banner"
  | "delete_business_banner"
  | "list_available_packets"
  | "list_location_zones"
  | "list_user_packets"
  | "purchase_user_packet"
  | "purchase_advert_packet"
  | "list_billing_entries"
  | "list_prepaid_invoices"
  | "list_postpaid_invoices";

export type OlxHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type OlxFieldType = "string" | "integer" | "number" | "boolean" | "integer_array" | "object" | "array";
export type OlxOutputKind = "object" | "array" | "data_array" | "empty";

export interface OlxFieldSpec {
  name: string;
  wireName?: string;
  type: OlxFieldType;
  description: string;
  required?: boolean;
  schema?: JsonSchema;
}

export interface OlxBodySpec {
  description: string;
  fields?: OlxFieldSpec[];
  requiredFields?: string[];
}

export interface OlxOperation {
  name: OlxActionName;
  method: OlxHttpMethod;
  path: string;
  description: string;
  requiredScopes: string[];
  pathParams?: OlxFieldSpec[];
  queryParams?: OlxFieldSpec[];
  body?: OlxBodySpec;
  outputKey: string;
  outputKind: OlxOutputKind;
}

const id = (name: string, description: string): OlxFieldSpec => ({
  name,
  type: "integer",
  description,
  required: true,
});
const stringId = (name: string, description: string): OlxFieldSpec => ({
  name,
  type: "string",
  description,
  required: true,
});
const optionalPage = [
  { name: "offset", type: "integer", description: "Starting element offset." },
  { name: "limit", type: "integer", description: "Maximum number of elements to return." },
] satisfies OlxFieldSpec[];
const page = [
  { name: "page", type: "integer", description: "Page number, starting from 1." },
  { name: "limit", type: "integer", description: "Number of results per page." },
] satisfies OlxFieldSpec[];
const imageUrl = {
  name: "url",
  type: "string",
  description: "Public image URL accepted by OLX.",
} satisfies OlxFieldSpec;

export const olxOperations: OlxOperation[] = [
  {
    name: "get_current_user",
    method: "GET",
    path: "/users/me",
    description: "Get the authenticated OLX Partner API user profile.",
    requiredScopes: olxReadScopes,
    outputKey: "user",
    outputKind: "object",
  },
  {
    name: "get_user",
    method: "GET",
    path: "/users/{id}",
    description: "Get an OLX user by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [id("id", "OLX user ID.")],
    outputKey: "user",
    outputKind: "object",
  },
  {
    name: "list_regions",
    method: "GET",
    path: "/regions",
    description: "List OLX country regions.",
    requiredScopes: olxReadScopes,
    outputKey: "regions",
    outputKind: "array",
  },
  {
    name: "get_region",
    method: "GET",
    path: "/regions/{regionId}",
    description: "Get one OLX region by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [id("regionId", "OLX region ID.")],
    outputKey: "region",
    outputKind: "object",
  },
  {
    name: "list_cities",
    method: "GET",
    path: "/cities",
    description: "List OLX cities with optional offset and limit pagination.",
    requiredScopes: olxReadScopes,
    queryParams: optionalPage,
    outputKey: "cities",
    outputKind: "array",
  },
  {
    name: "get_city",
    method: "GET",
    path: "/cities/{cityId}",
    description: "Get one OLX city by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [stringId("cityId", "OLX city ID.")],
    outputKey: "city",
    outputKind: "object",
  },
  {
    name: "list_city_districts",
    method: "GET",
    path: "/cities/{cityId}/districts",
    description: "List districts for one OLX city.",
    requiredScopes: olxReadScopes,
    pathParams: [stringId("cityId", "OLX city ID.")],
    outputKey: "districts",
    outputKind: "array",
  },
  {
    name: "list_districts",
    method: "GET",
    path: "/districts",
    description: "List OLX districts.",
    requiredScopes: olxReadScopes,
    outputKey: "districts",
    outputKind: "array",
  },
  {
    name: "get_district",
    method: "GET",
    path: "/districts/{districtId}",
    description: "Get one OLX district by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [stringId("districtId", "OLX district ID.")],
    outputKey: "district",
    outputKind: "object",
  },
  {
    name: "get_locations",
    method: "GET",
    path: "/locations",
    description: "Get OLX locations near a latitude and longitude.",
    requiredScopes: olxReadScopes,
    queryParams: [
      { name: "latitude", type: "number", required: true, description: "Location latitude." },
      { name: "longitude", type: "number", required: true, description: "Location longitude." },
    ],
    outputKey: "locations",
    outputKind: "array",
  },
  {
    name: "list_languages",
    method: "GET",
    path: "/languages",
    description: "List languages available in OLX Partner API.",
    requiredScopes: olxReadScopes,
    outputKey: "languages",
    outputKind: "array",
  },
  {
    name: "list_currencies",
    method: "GET",
    path: "/currencies",
    description: "List currencies available in OLX Partner API.",
    requiredScopes: olxReadScopes,
    outputKey: "currencies",
    outputKind: "array",
  },
  {
    name: "list_categories",
    method: "GET",
    path: "/categories",
    description: "List OLX categories, optionally filtered by parent category.",
    requiredScopes: olxReadScopes,
    queryParams: [{ name: "parentId", wireName: "parent_id", type: "integer", description: "Parent category ID." }],
    outputKey: "categories",
    outputKind: "array",
  },
  {
    name: "get_category",
    method: "GET",
    path: "/categories/{categoryId}",
    description: "Get one OLX category by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [id("categoryId", "OLX category ID.")],
    outputKey: "category",
    outputKind: "object",
  },
  {
    name: "list_category_attributes",
    method: "GET",
    path: "/categories/{categoryId}/attributes",
    description: "List attributes for one OLX category.",
    requiredScopes: olxReadScopes,
    pathParams: [id("categoryId", "OLX category ID.")],
    outputKey: "attributes",
    outputKind: "array",
  },
  {
    name: "suggest_categories",
    method: "GET",
    path: "/categories/suggestion",
    description: "Suggest OLX categories for an advert title.",
    requiredScopes: olxReadScopes,
    queryParams: [{ name: "q", type: "string", required: true, description: "Advert title search query." }],
    outputKey: "suggestions",
    outputKind: "array",
  },
  {
    name: "list_threads",
    method: "GET",
    path: "/threads",
    description: "List OLX message threads with optional advert, interlocutor, and pagination filters.",
    requiredScopes: olxReadScopes,
    queryParams: [
      { name: "advertId", wireName: "advert_id", type: "integer", description: "Advert ID." },
      { name: "interlocutorId", wireName: "interlocutor_id", type: "integer", description: "Interlocutor user ID." },
      ...optionalPage,
    ],
    outputKey: "threads",
    outputKind: "array",
  },
  {
    name: "get_thread",
    method: "GET",
    path: "/threads/{threadId}",
    description: "Get one OLX message thread by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [id("threadId", "OLX thread ID.")],
    outputKey: "thread",
    outputKind: "object",
  },
  {
    name: "list_thread_messages",
    method: "GET",
    path: "/threads/{threadId}/messages",
    description: "List messages in one OLX thread.",
    requiredScopes: olxReadScopes,
    pathParams: [id("threadId", "OLX thread ID.")],
    outputKey: "messages",
    outputKind: "array",
  },
  {
    name: "post_thread_message",
    method: "POST",
    path: "/threads/{threadId}/messages",
    description: "Post a message to an OLX thread.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("threadId", "OLX thread ID.")],
    body: {
      description: "OLX message payload.",
      requiredFields: ["text"],
      fields: [
        { name: "text", type: "string", description: "Message text." },
        { name: "attachments", type: "array", description: "Message attachments accepted by OLX." },
      ],
    },
    outputKey: "message",
    outputKind: "object",
  },
  {
    name: "get_thread_message",
    method: "GET",
    path: "/threads/{threadId}/messages/{messageId}",
    description: "Get one message from an OLX thread.",
    requiredScopes: olxReadScopes,
    pathParams: [id("threadId", "OLX thread ID."), id("messageId", "OLX message ID.")],
    outputKey: "message",
    outputKind: "object",
  },
  {
    name: "run_thread_command",
    method: "POST",
    path: "/threads/{threadId}/commands",
    description: "Take an OLX-supported action on a message thread.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("threadId", "OLX thread ID.")],
    body: {
      description: "OLX thread command payload.",
      requiredFields: ["command"],
      fields: [
        { name: "command", type: "string", description: "Thread command name accepted by OLX." },
        { name: "is_favourite", type: "boolean", description: "Whether the thread should be marked as favourite." },
      ],
    },
    outputKey: "result",
    outputKind: "object",
  },
  {
    name: "list_paid_features",
    method: "GET",
    path: "/paid-features",
    description: "List available OLX paid features.",
    requiredScopes: olxReadScopes,
    outputKey: "paidFeatures",
    outputKind: "array",
  },
  {
    name: "list_advert_paid_features",
    method: "GET",
    path: "/adverts/{advertId}/paid-features",
    description: "List active paid features for one OLX advert.",
    requiredScopes: olxReadScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    outputKey: "paidFeatures",
    outputKind: "array",
  },
  {
    name: "purchase_advert_paid_feature",
    method: "POST",
    path: "/adverts/{advertId}/paid-features",
    description: "Purchase a paid feature for one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    body: {
      description: "OLX paid feature purchase payload.",
      requiredFields: ["payment_method", "code"],
      fields: [
        { name: "payment_method", type: "string", description: "Payment method accepted by OLX." },
        { name: "code", type: "string", description: "Paid feature code." },
      ],
    },
    outputKey: "result",
    outputKind: "object",
  },
  {
    name: "list_adverts",
    method: "GET",
    path: "/adverts",
    description: "List adverts owned by the authenticated OLX user with optional pagination and filters.",
    requiredScopes: olxReadScopes,
    queryParams: [
      ...optionalPage,
      { name: "externalId", wireName: "external_id", type: "string", description: "Advert external ID." },
      {
        name: "categoryIds",
        wireName: "category_ids",
        type: "integer_array",
        description: "Category IDs used to filter adverts.",
      },
    ],
    outputKey: "adverts",
    outputKind: "data_array",
  },
  {
    name: "create_advert",
    method: "POST",
    path: "/adverts",
    description: "Create an OLX advert.",
    requiredScopes: olxWriteScopes,
    body: {
      description: "OLX advert creation payload.",
      requiredFields: ["title", "description", "category_id", "advertiser_type", "contact", "location"],
      fields: advertBodyFields(),
    },
    outputKey: "advert",
    outputKind: "object",
  },
  {
    name: "get_advert",
    method: "GET",
    path: "/adverts/{advertId}",
    description: "Get one OLX advert by ID.",
    requiredScopes: olxReadScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    outputKey: "advert",
    outputKind: "object",
  },
  {
    name: "update_advert",
    method: "PUT",
    path: "/adverts/{advertId}",
    description: "Update one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    body: {
      description: "OLX advert update payload.",
      fields: advertBodyFields(),
    },
    outputKey: "advert",
    outputKind: "object",
  },
  {
    name: "delete_advert",
    method: "DELETE",
    path: "/adverts/{advertId}",
    description: "Delete one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    outputKey: "result",
    outputKind: "empty",
  },
  {
    name: "run_advert_command",
    method: "POST",
    path: "/adverts/{advertId}/commands",
    description: "Take an OLX-supported action on one advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    body: {
      description: "OLX advert command payload.",
      requiredFields: ["command"],
      fields: [
        { name: "command", type: "string", description: "Advert command name accepted by OLX." },
        { name: "is_success", type: "boolean", description: "Whether the advert command succeeded." },
      ],
    },
    outputKey: "result",
    outputKind: "object",
  },
  {
    name: "get_advert_statistics",
    method: "GET",
    path: "/adverts/{advertId}/statistics",
    description: "Get OLX advert statistics.",
    requiredScopes: olxReadScopes,
    pathParams: [id("advertId", "OLX advert ID.")],
    outputKey: "statistics",
    outputKind: "object",
  },
  {
    name: "clear_advert_statistic",
    method: "DELETE",
    path: "/adverts/{advertId}/statistics/{statisticName}",
    description: "Clear one OLX advert statistic.",
    requiredScopes: olxWriteScopes,
    pathParams: [
      id("advertId", "OLX advert ID."),
      { name: "statisticName", type: "string", required: true, description: "Statistic name to clear." },
    ],
    outputKey: "result",
    outputKind: "empty",
  },
  {
    name: "list_advert_logos",
    method: "GET",
    path: "/adverts/{advertId}/logos",
    description: "List logos attached to one OLX advert.",
    requiredScopes: olxReadScopes,
    pathParams: [stringId("advertId", "OLX advert ID.")],
    outputKey: "logos",
    outputKind: "array",
  },
  {
    name: "add_advert_logo",
    method: "POST",
    path: "/adverts/{advertId}/logos",
    description: "Add a logo to one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [stringId("advertId", "OLX advert ID.")],
    body: { description: "OLX advert logo payload.", requiredFields: ["url"], fields: [imageUrl] },
    outputKey: "logo",
    outputKind: "object",
  },
  {
    name: "delete_advert_logo",
    method: "DELETE",
    path: "/adverts/{advertId}/logos/{logoId}",
    description: "Delete a logo from one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("advertId", "OLX advert ID."), id("logoId", "OLX logo ID.")],
    outputKey: "result",
    outputKind: "empty",
  },
  {
    name: "get_account_balance",
    method: "GET",
    path: "/users/me/account-balance",
    description: "Get the authenticated OLX user's account balance.",
    requiredScopes: olxReadScopes,
    outputKey: "accountBalance",
    outputKind: "object",
  },
  {
    name: "list_payment_methods",
    method: "GET",
    path: "/users/me/payment-methods",
    description: "List payment methods available for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    outputKey: "paymentMethods",
    outputKind: "array",
  },
  {
    name: "get_business_user",
    method: "GET",
    path: "/users-business/me",
    description: "Get business profile data for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    outputKey: "businessUser",
    outputKind: "object",
  },
  {
    name: "update_business_user",
    method: "PUT",
    path: "/users-business/me",
    description: "Update business profile data for the authenticated OLX user.",
    requiredScopes: olxWriteScopes,
    body: {
      description: "OLX business user update payload.",
      fields: [
        { name: "name", type: "string", description: "Business display name." },
        { name: "description", type: "string", description: "Business description." },
        { name: "subdomain", type: "string", description: "Business subdomain." },
        { name: "website_url", type: "string", description: "Business website URL." },
        { name: "address", type: "object", description: "Business address object accepted by OLX." },
        { name: "phones", type: "array", description: "Business phone values accepted by OLX." },
      ],
    },
    outputKey: "businessUser",
    outputKind: "object",
  },
  {
    name: "list_business_logos",
    method: "GET",
    path: "/users-business/me/logos",
    description: "List business logos for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    outputKey: "logos",
    outputKind: "array",
  },
  {
    name: "set_business_logo",
    method: "POST",
    path: "/users-business/me/logos",
    description: "Set a business logo for the authenticated OLX user.",
    requiredScopes: olxWriteScopes,
    body: { description: "OLX business logo payload.", requiredFields: ["url"], fields: [imageUrl] },
    outputKey: "logo",
    outputKind: "object",
  },
  {
    name: "delete_business_logo",
    method: "DELETE",
    path: "/users-business/me/logos/{logoId}",
    description: "Delete one business logo.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("logoId", "OLX business logo ID.")],
    outputKey: "result",
    outputKind: "empty",
  },
  {
    name: "list_business_banners",
    method: "GET",
    path: "/users-business/me/banners",
    description: "List business banners for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    outputKey: "banners",
    outputKind: "array",
  },
  {
    name: "set_business_banner",
    method: "POST",
    path: "/users-business/me/banners",
    description: "Set a business banner for the authenticated OLX user.",
    requiredScopes: olxWriteScopes,
    body: { description: "OLX business banner payload.", requiredFields: ["url"], fields: [imageUrl] },
    outputKey: "banner",
    outputKind: "object",
  },
  {
    name: "delete_business_banner",
    method: "DELETE",
    path: "/users-business/me/banners/{bannerId}",
    description: "Delete one business banner.",
    requiredScopes: olxWriteScopes,
    pathParams: [id("bannerId", "OLX business banner ID.")],
    outputKey: "result",
    outputKind: "empty",
  },
  {
    name: "list_available_packets",
    method: "GET",
    path: "/packets",
    description: "List OLX packets available for a category and payment method.",
    requiredScopes: olxReadScopes,
    queryParams: [
      { name: "categoryId", wireName: "category_id", type: "integer", required: true, description: "Category ID." },
      {
        name: "paymentMethod",
        wireName: "payment_method",
        type: "string",
        required: true,
        description: "Payment method.",
      },
      { name: "packetType", wireName: "type", type: "string", description: "Packet type, such as base or all." },
      { name: "withFeatures", wireName: "with_features", type: "integer", description: "Whether to include features." },
      { name: "zoneId", wireName: "zone_id", type: "string", description: "Location zone ID for regional pricing." },
    ],
    outputKey: "packets",
    outputKind: "array",
  },
  {
    name: "list_location_zones",
    method: "GET",
    path: "/zones",
    description: "List OLX location zones for a category.",
    requiredScopes: olxReadScopes,
    queryParams: [
      { name: "categoryId", wireName: "category_id", type: "integer", required: true, description: "Category ID." },
    ],
    outputKey: "zones",
    outputKind: "array",
  },
  {
    name: "list_user_packets",
    method: "GET",
    path: "/users/me/packets",
    description: "List packets bought by the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    queryParams: [
      ...optionalPage,
      { name: "availability", type: "string", description: "Packet availability filter." },
      { name: "sortBy", wireName: "sort_by", type: "string", description: "Packet sort order." },
    ],
    outputKey: "packets",
    outputKind: "array",
  },
  {
    name: "purchase_user_packet",
    method: "POST",
    path: "/users/me/packets",
    description: "Purchase an OLX packet for the authenticated user.",
    requiredScopes: olxWriteScopes,
    body: {
      description: "OLX packet purchase payload.",
      requiredFields: ["payment_method", "category_id", "size"],
      fields: [
        { name: "payment_method", type: "string", description: "Payment method accepted by OLX." },
        { name: "category_id", type: "integer", description: "Category ID." },
        { name: "size", type: "integer", description: "Packet size." },
        { name: "type", type: "string", description: "Packet type." },
        { name: "zone_id", type: "string", description: "Location zone ID for regional pricing." },
      ],
    },
    outputKey: "packet",
    outputKind: "object",
  },
  {
    name: "purchase_advert_packet",
    method: "POST",
    path: "/adverts/{advertId}/packets",
    description: "Purchase a packet for one OLX advert.",
    requiredScopes: olxWriteScopes,
    pathParams: [stringId("advertId", "OLX advert ID.")],
    body: {
      description: "OLX advert packet purchase payload.",
      requiredFields: ["payment_method"],
      fields: [
        { name: "payment_method", type: "string", description: "Payment method accepted by OLX." },
        { name: "is_premium", type: "boolean", description: "Whether to purchase a premium packet." },
      ],
    },
    outputKey: "packet",
    outputKind: "object",
  },
  {
    name: "list_billing_entries",
    method: "GET",
    path: "/users/me/billing",
    description: "List billing entries for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    queryParams: page,
    outputKey: "billing",
    outputKind: "object",
  },
  {
    name: "list_prepaid_invoices",
    method: "GET",
    path: "/users/me/prepaid-invoices",
    description: "List prepaid invoices for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    queryParams: page,
    outputKey: "invoices",
    outputKind: "object",
  },
  {
    name: "list_postpaid_invoices",
    method: "GET",
    path: "/users/me/postpaid-invoices",
    description: "List postpaid invoices for the authenticated OLX user.",
    requiredScopes: olxReadScopes,
    queryParams: page,
    outputKey: "invoices",
    outputKind: "object",
  },
];

function advertBodyFields(): OlxFieldSpec[] {
  return [
    { name: "title", type: "string", description: "Advert title." },
    { name: "description", type: "string", description: "Advert description." },
    { name: "category_id", type: "integer", description: "OLX category ID." },
    { name: "advertiser_type", type: "string", description: "Advertiser type accepted by OLX." },
    { name: "external_url", type: "string", description: "Advert URL in the origin system." },
    { name: "external_id", type: "string", description: "Advert ID in the origin system." },
    { name: "contact", type: "object", description: "Advert contact object accepted by OLX." },
    { name: "location", type: "object", description: "Advert location object accepted by OLX." },
    { name: "images", type: "array", description: "Advert image objects accepted by OLX." },
    { name: "price", type: "object", description: "Advert price object accepted by OLX." },
    { name: "salary", type: "object", description: "Advert salary object accepted by OLX." },
    { name: "attributes", type: "array", description: "Advert attribute objects accepted by OLX." },
    { name: "courier", type: "boolean", description: "Whether delivery is possible for this advert." },
    {
      name: "auto_extend_enabled",
      type: "boolean",
      description: "Whether OLX should automatically extend the advert.",
    },
    {
      name: "product_safety_regulation",
      type: "object",
      description: "Product safety regulation details accepted by OLX.",
    },
  ];
}

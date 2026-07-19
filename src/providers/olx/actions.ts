import type { ActionDefinition, JsonSchema } from "../../core/types.ts";
import type { OlxBodySpec, OlxFieldSpec } from "./operations.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { olxOperations } from "./operations.ts";

const service = "olx";

const objectRecord = s.record(true, { description: "OLX API object." });
const bodyRecord = s.record(true, { description: "OLX API request body." });

export type { OlxActionName } from "./operations.ts";

export const olxActions: ActionDefinition[] = olxOperations.map((operation) =>
  defineProviderAction(service, {
    name: operation.name,
    description: operation.description,
    requiredScopes: operation.requiredScopes,
    inputSchema: inputSchema(operation.pathParams ?? [], operation.queryParams ?? [], operation.body),
    outputSchema: outputSchema(operation.outputKey, operation.outputKind),
  }),
);

function inputSchema(
  pathParams: OlxFieldSpec[],
  queryParams: OlxFieldSpec[],
  body: OlxBodySpec | undefined,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of [...pathParams, ...queryParams]) {
    properties[field.name] = fieldSchema(field);
    if (field.required) {
      required.push(field.name);
    }
  }
  if (body) {
    properties.body = bodySchema(body);
    required.push("body");
  }
  return s.object(properties, {
    required,
    description: "The input payload for this OLX Partner API action.",
  });
}

function bodySchema(body: OlxBodySpec): JsonSchema {
  const fields = Object.fromEntries((body.fields ?? []).map((field) => [field.name, fieldSchema(field)]));
  return s.object(fields, {
    required: body.requiredFields,
    additionalProperties: true,
    description: body.description,
  });
}

function outputSchema(outputKey: string, outputKind: string): JsonSchema {
  const value =
    outputKind === "array" || outputKind === "data_array"
      ? s.array(objectRecord, { description: `OLX ${outputKey} returned by this action.` })
      : outputKind === "empty"
        ? s.object(
            {
              success: s.boolean({ description: "Whether the OLX operation completed successfully." }),
              result: s.nullable(bodyRecord),
            },
            { required: ["success"], description: "OLX empty-response operation result." },
          )
        : objectRecord;

  return outputKind === "empty"
    ? (value as JsonSchema)
    : s.object({ [outputKey]: value }, { required: [outputKey], description: `OLX ${outputKey} response.` });
}

function fieldSchema(field: OlxFieldSpec): JsonSchema {
  if (field.schema) {
    return field.schema;
  }
  if (field.type === "integer") {
    return s.integer({ minimum: 0, description: field.description });
  }
  if (field.type === "number") {
    return s.number({ description: field.description });
  }
  if (field.type === "boolean") {
    return s.boolean({ description: field.description });
  }
  if (field.type === "integer_array") {
    return s.array(s.integer({ minimum: 0, description: "OLX integer ID." }), {
      minItems: 1,
      description: field.description,
    });
  }
  if (field.type === "object") {
    return s.record(true, { description: field.description });
  }
  if (field.type === "array") {
    return s.array(bodyRecord, { description: field.description });
  }
  return s.string({ description: field.description });
}

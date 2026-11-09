import type { ActionDefinition, JsonSchema } from "./types.ts";

/**
 * Input for defining one provider action without repeating provider-level
 * fields in every action object.
 */
export type DefineProviderActionInput<TName extends string = string> = {
  name: TName;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  operationType?: ActionDefinition["operationType"];
  requiredScopes?: readonly string[];
  providerPermissions?: readonly string[];
  riskTags?: ActionDefinition["riskTags"];
  idempotency?: ActionDefinition["idempotency"];
  followUpActions?: readonly string[];
  asyncLifecycle?: ActionDefinition["asyncLifecycle"];
};

export type ProviderActionDefinition<TName extends string = string> = ActionDefinition & { name: TName };

/**
 * Create a full action definition for one provider.
 *
 * Provider modules use this helper so definitions read as business action
 * declarations instead of generated catalog JSON.
 */
export function defineProviderAction<TName extends string>(
  service: string,
  input: DefineProviderActionInput<TName>,
): ProviderActionDefinition<TName> {
  return {
    id: `${service}.${input.name}`,
    service,
    name: input.name,
    description: input.description,
    ...(input.operationType ? { operationType: input.operationType } : {}),
    requiredScopes: input.requiredScopes ? [...input.requiredScopes] : [],
    providerPermissions: input.providerPermissions ? [...input.providerPermissions] : [],
    riskTags: input.riskTags,
    idempotency: input.idempotency,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    followUpActions: input.followUpActions ? [...input.followUpActions] : undefined,
    asyncLifecycle: input.asyncLifecycle,
  };
}

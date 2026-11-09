import type { ProviderActionNames } from "./registry.action-contracts.generated.ts";

export type {
  ApiKeyProviderContext,
  BearerProviderContext,
  OAuthProviderContext,
  ProviderRuntimeHandler,
} from "./provider-runtime.ts";
export {
  defineApiKeyProviderExecutors,
  defineBearerProviderExecutors,
  defineOAuthProviderExecutors,
  defineProviderExecutors,
} from "./provider-runtime.ts";

export type ProviderActionName<TService extends keyof ProviderActionNames> = ProviderActionNames[TService];

export type ProviderActionHandlers<TService extends keyof ProviderActionNames, THandler> = Record<
  ProviderActionName<TService>,
  THandler
>;

export type ProviderActionHandlerSubset<TService extends keyof ProviderActionNames, THandler> = Partial<
  ProviderActionHandlers<TService, THandler>
>;

export type ProviderActionSources<TService extends keyof ProviderActionNames, TSource> = Record<
  ProviderActionName<TService>,
  TSource
>;

interface NamedActionSource {
  name: string;
}

/**
 * Build handlers from the same complete source list used to define a provider's actions.
 */
export function mapProviderActionHandlers<
  const TService extends keyof ProviderActionNames,
  TSource extends NamedActionSource,
  THandler,
>(
  _service: TService,
  sources: readonly TSource[],
  createHandler: (source: TSource, name: ProviderActionName<TService>) => THandler,
): ProviderActionHandlers<TService, THandler> {
  return Object.fromEntries(
    sources.map((source) => [source.name, createHandler(source, source.name as ProviderActionName<TService>)]),
  ) as ProviderActionHandlers<TService, THandler>;
}

/**
 * Build handlers from the complete action-name list used by a provider definition.
 */
export function mapProviderActionNames<const TService extends keyof ProviderActionNames, THandler>(
  _service: TService,
  names: readonly string[],
  createHandler: (name: ProviderActionName<TService>) => THandler,
): ProviderActionHandlers<TService, THandler> {
  return Object.fromEntries(
    names.map((name) => [name, createHandler(name as ProviderActionName<TService>)]),
  ) as ProviderActionHandlers<TService, THandler>;
}

/**
 * Build handlers from an action-keyed source record checked against the generated contract.
 */
export function mapProviderActionSources<
  const TService extends keyof ProviderActionNames,
  TSources extends ProviderActionSources<TService, unknown>,
  THandler,
>(
  _service: TService,
  sources: TSources,
  createHandler: (name: ProviderActionName<TService>, source: TSources[ProviderActionName<TService>]) => THandler,
): ProviderActionHandlers<TService, THandler> {
  return Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      createHandler(name as ProviderActionName<TService>, source as TSources[ProviderActionName<TService>]),
    ]),
  ) as ProviderActionHandlers<TService, THandler>;
}

/** Combine handler fragments whose completeness is checked by the final generated contract. */
export function combineProviderActionHandlers<const TService extends keyof ProviderActionNames, THandler>(
  _service: TService,
  ...parts: readonly ProviderActionHandlerSubset<TService, THandler>[]
): ProviderActionHandlers<TService, THandler> {
  return Object.assign({}, ...parts) as ProviderActionHandlers<TService, THandler>;
}

/** Look up a generated-contract handler at a runtime string boundary. */
export function getProviderActionHandler<THandlers extends object>(
  handlers: THandlers,
  name: string,
): THandlers[keyof THandlers] | undefined {
  return handlers[name as keyof THandlers];
}

export interface ApiKeyActionRequest {
  apiKey: string;
  actionName: string;
  input: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  values?: Record<string, string>;
}

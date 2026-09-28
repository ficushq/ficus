import { getModel, getModels, getProviders } from '@earendil-works/pi-ai/compat'
import { type Api, type Model } from '@earendil-works/pi-ai'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { tryGetModelRuntime } from '../../services/agent/auth-backend'
import { openRouterEndpointForModelId } from '@ficus/shared/openrouter-tier-expansion'

const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkingLevel[]

export interface ParsedModelSpec {
  provider: string
  modelId: string
  thinkingLevel?: ThinkingLevel
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel)
}

function splitThinkingLevel(value: string): { modelSpec: string; thinkingLevel?: ThinkingLevel } {
  const lastColonIndex = value.lastIndexOf(':')
  if (lastColonIndex <= 0) return { modelSpec: value }

  const suffix = value.slice(lastColonIndex + 1).trim()
  if (!suffix) return { modelSpec: value }

  if (!isThinkingLevel(suffix)) return { modelSpec: value }
  return { modelSpec: value.slice(0, lastColonIndex).trim(), thinkingLevel: suffix }
}

function splitModelSpec(modelSpec: string): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } {
  const value = modelSpec.trim()

  if (!value) {
    throw new Error('Model must be a non-empty string')
  }

  const { modelSpec: modelSpecWithoutThinking, thinkingLevel } = splitThinkingLevel(value)

  const slashIndex = modelSpecWithoutThinking.indexOf('/')
  const colonIndex = modelSpecWithoutThinking.indexOf(':')
  // Prefer provider:model when its separator comes first. OpenRouter model ids
  // themselves contain a slash (openrouter:vendor/model), which must remain in
  // modelId rather than becoming part of the provider name.
  if (colonIndex > 0 && (slashIndex === -1 || colonIndex < slashIndex)) {
    return {
      provider: modelSpecWithoutThinking.slice(0, colonIndex).trim().toLowerCase(),
      modelId: modelSpecWithoutThinking.slice(colonIndex + 1).trim(),
      thinkingLevel,
    }
  }

  if (slashIndex > 0) {
    return {
      provider: modelSpecWithoutThinking.slice(0, slashIndex).trim().toLowerCase(),
      modelId: modelSpecWithoutThinking.slice(slashIndex + 1).trim(),
      thinkingLevel,
    }
  }

  throw new Error(`Invalid model '${modelSpec}': must be 'provider:model-id' (preferred) or 'provider/model-id'`)
}

export function parseModelSpec(modelSpec: string): ParsedModelSpec {
  const { provider, modelId, thinkingLevel } = splitModelSpec(modelSpec)

  if (!provider) {
    throw new Error(`Invalid model '${modelSpec}': provider is empty`)
  }
  if (!modelId) {
    throw new Error(`Invalid model '${modelSpec}': model id is empty`)
  }

  return {
    provider,
    modelId,
    thinkingLevel,
  }
}

export interface DynamicModelCatalog {
  getModel(provider: string, modelId: string): Model<Api> | undefined
  getProviders(): readonly { id: string }[]
}
export function validateModelSpec(
  modelSpec: string,
  dynamicCatalog: DynamicModelCatalog | undefined = tryGetModelRuntime()
): ParsedModelSpec {
  const parsed = parseModelSpec(modelSpec)
  const runtime = dynamicCatalog
  if (runtime?.getModel(parsed.provider, parsed.modelId)) return parsed
  const providers = getProviders()
  if (!providers.includes(parsed.provider as any)) {
    const available = [...new Set([...providers, ...(runtime?.getProviders().map((provider) => provider.id) ?? [])])]
    throw new Error(`Unknown provider '${parsed.provider}'. Available providers: ${available.join(', ')}`)
  }
  const providerModels = getModels(parsed.provider as any)
  if (!providerModels.some((model) => model.id === parsed.modelId))
    throw new Error(`Unknown model '${parsed.modelId}' for provider '${parsed.provider}'`)
  return parsed
}

export function resolveModelSpec(
  modelSpec: string,
  dynamicCatalog: DynamicModelCatalog | undefined = tryGetModelRuntime()
): Model<Api> {
  const { provider, modelId } = validateModelSpec(modelSpec, dynamicCatalog)
  return dynamicCatalog?.getModel(provider, modelId) ?? getModel(provider as any, modelId as any)
}

export function resolveAgentModelSpec(
  modelSpec: string,
  dynamicCatalog: DynamicModelCatalog | undefined = tryGetModelRuntime()
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } {
  const { provider, modelId, thinkingLevel } = validateModelSpec(modelSpec, dynamicCatalog)
  const model = dynamicCatalog?.getModel(provider, modelId) ?? getModel(provider as any, modelId as any)
  return {
    model: pinOpenRouterBackend(model),
    thinkingLevel,
  }
}

/** Pin OpenRouter to the model creator's backend family and require full tool/parameter support. */
function pinOpenRouterBackend(model: Model<Api>): Model<Api> {
  if (model.provider !== 'openrouter') return model
  const endpoint = openRouterEndpointForModelId(model.id)
  if (!endpoint) return model
  return {
    ...model,
    compat: {
      ...model.compat,
      openRouterRouting: {
        only: [endpoint],
        order: [endpoint],
        allow_fallbacks: false,
        require_parameters: true,
      },
    },
  }
}

/** Returns whether a single, selected model spec accepts image input according to the Pi registry. */
export function supportsImageInput(modelSpec: string): boolean {
  const { model } = resolveAgentModelSpec(modelSpec)
  return Array.isArray(model.input) && model.input.includes('image')
}

/**
 * Split a comma-separated model priority list into trimmed, non-empty specs.
 * A single spec is returned as a one-element list (backward compatible).
 * @throws if the list contains no non-empty specs.
 */
export function splitModelPriorityList(spec: string): string[] {
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    throw new Error('Model must be a non-empty string')
  }
  return parts
}

/** Parse every candidate in a (possibly comma-separated) priority list. */
export function parseModelPriorityList(spec: string): ParsedModelSpec[] {
  return splitModelPriorityList(spec).map(parseModelSpec)
}

/**
 * Structurally validate every candidate in a priority list (provider + model
 * known in the Pi registry). Does NOT check auth/disabled state — that happens
 * at selection time. A single spec is validated as a one-element list.
 */
export function validateModelSpecList(spec: string, dynamicCatalog?: DynamicModelCatalog): ParsedModelSpec[] {
  return splitModelPriorityList(spec).map((candidate) => validateModelSpec(candidate, dynamicCatalog))
}

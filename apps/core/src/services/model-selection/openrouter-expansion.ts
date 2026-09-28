import { getModels } from '@earendil-works/pi-ai/compat'
import {
  deriveOpenRouterFallbackEntries,
  openRouterEndpointForDirectProvider,
  openRouterEndpointForModelId,
  openRouterSpecForDirect,
} from '@ficus/shared/openrouter-tier-expansion'
import type { DynamicModelCatalog } from '../../lib/utils/model-spec'

export { openRouterSpecForDirect }

interface ExpansionOptions {
  enabled: boolean
  routeReady: boolean
}

export interface InvalidOpenRouterFallback {
  source: string
  modelId?: string
  reason: 'malformed' | 'unavailable'
}

export function invalidOpenRouterFallbackWarning(entry: InvalidOpenRouterFallback): string {
  return entry.reason === 'malformed'
    ? `malformed legacy entry '${entry.source}'`
    : `${entry.modelId} is not in the Pi catalog or has no verified endpoint mapping`
}

/** Validate the mechanical mapping against Pi and return only safe runtime candidates. */
export function inspectOpenRouterFallbacks(
  chain: string,
  dynamicCatalog?: DynamicModelCatalog
): { fallbacks: string[]; invalid: InvalidOpenRouterFallback[] } {
  const staticIds = new Set(getModels('openrouter').map((model) => model.id))
  const fallbacks: string[] = []
  const invalid: InvalidOpenRouterFallback[] = []
  for (const entry of deriveOpenRouterFallbackEntries(chain)) {
    if ('error' in entry) {
      invalid.push({ source: entry.source, reason: 'malformed' })
      continue
    }
    const catalogued = dynamicCatalog?.getModel('openrouter', entry.modelId) || staticIds.has(entry.modelId)
    if (
      catalogued &&
      openRouterEndpointForDirectProvider(entry.provider) &&
      openRouterEndpointForModelId(entry.modelId)
    )
      fallbacks.push(entry.fallback)
    else invalid.push({ source: entry.source, modelId: entry.modelId, reason: 'unavailable' })
  }
  return { fallbacks, invalid }
}

/** Expand only at resolution time; disabled/unavailable paths return the exact authored string. */
export function expandOpenRouterFallbacks(chain: string, options: ExpansionOptions): string {
  if (!options.enabled || !options.routeReady) return chain
  const { fallbacks } = inspectOpenRouterFallbacks(chain)
  return fallbacks.length ? `${chain},${fallbacks.join(',')}` : chain
}

import {
  deriveOpenRouterFallbackEntries,
  openRouterEndpointForDirectProvider,
  openRouterEndpointForModelId,
} from '@ficus/shared/openrouter-tier-expansion'
import type { AgentTypeConfig } from '../../api/config'
import type { OpenRouterRoutingSummary, ProviderAuthEntry } from '../../api/providerAuth'
export function formatResolvedModel(
  agentType: Pick<AgentTypeConfig, 'tier' | 'model' | 'resolvedChain' | 'provenance'>,
  tierLabel?: string
): string {
  if (agentType.provenance?.startsWith('via tier:')) {
    const provenanceTier = agentType.provenance.slice('via tier:'.length).trim()
    return `Model tier: ${tierLabel?.trim() || agentType.tier || provenanceTier}`
  }

  return `Model: ${agentType.resolvedChain || agentType.model}${agentType.provenance ? ` (${agentType.provenance})` : ''}`
}
export const NO_USABLE_PROVIDER_WARNING =
  'No usable provider in this chain: every entry is disabled, unauthenticated or unhealthy'

/**
 * Warnings for one model chain (`provider:model[:effort],…`).
 *
 * A provider the user disabled is a choice, not a fault: its entries produce no warning of
 * their own, since routing simply skips them. "Unhealthy" is reserved for an enabled provider
 * with a real health problem (exhausted). The one chain-level warning is raised when every
 * entry is unusable (disabled, unauthenticated or unhealthy), because then nothing can run.
 *
 * `providers` lists every provider with stored accounts or environment/runtime auth, so once it
 * has loaded, a provider missing from it is one nobody has signed in to. While it is still
 * loading (or unavailable), pass `undefined`: authentication is then unknown and not judged.
 *
 * When the OpenRouter universal fallback is active, an entry it can shadow still runs through
 * OpenRouter, so it counts as usable even if its own provider cannot run. This mirrors Core's
 * expansion except for the OpenRouter catalog check, so it errs towards no warning.
 */
export function modelChainWarnings(
  chain: string,
  providers: ProviderAuthEntry[] | undefined,
  openRouter?: Pick<OpenRouterRoutingSummary, 'active' | 'health'>
): string[] {
  const warnings: string[] = []
  const entries = chain
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const shadowed = openRouterShadowedEntries(chain, openRouter)
  let usableEntries = 0
  for (const entry of entries) {
    const [provider, model] = entry.split(':')
    const state = providers?.find((item) => item.provider === provider)
    const viaOpenRouter = shadowed.has(entry)
    if (state?.disabled) {
      if (viaOpenRouter) usableEntries++
      continue
    }
    const unhealthy = state?.health === 'exhausted'
    if (unhealthy) warnings.push(`${provider}:${model} provider is unhealthy`)
    const authenticated = providers === undefined || (state !== undefined && state.configured !== false)
    if ((!unhealthy && authenticated) || viaOpenRouter) usableEntries++
    const account = state?.accounts?.find((item) => !item.model || item.model === model)
    if (account?.capabilities && !account.capabilities.tools)
      warnings.push(`${provider}:${model} lacks tool capability`)
  }
  if (entries.length > 0 && usableEntries === 0) warnings.push(NO_USABLE_PROVIDER_WARNING)
  return warnings
}

/** Chain entries the active OpenRouter universal fallback would also try through OpenRouter. */
function openRouterShadowedEntries(
  chain: string,
  openRouter: Pick<OpenRouterRoutingSummary, 'active' | 'health'> | undefined
): Set<string> {
  if (!openRouter?.active || openRouter.health === 'exhausted') return new Set()
  return new Set(
    deriveOpenRouterFallbackEntries(chain).flatMap((item) =>
      'fallback' in item &&
      openRouterEndpointForDirectProvider(item.provider) &&
      openRouterEndpointForModelId(item.modelId)
        ? [item.source]
        : []
    )
  )
}

/** Providers the user turned off globally, for showing their chain entries muted. */
export function disabledProviderIds(providers: ProviderAuthEntry[]): string[] {
  return providers.filter((item) => item.disabled).map((item) => item.provider)
}
export function withTierPosition(chain: string, spec: string, position: 'primary' | 'fallback'): string {
  const entries = chain
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== spec)
  return position === 'primary' ? [spec, ...entries].join(',') : [...entries, spec].join(',')
}
export async function assignCompatibleProvider<T extends { slug: string; chain: string }>(input: {
  tiers: T[]
  spec: string
  position: 'primary' | 'fallback'
  add: () => Promise<unknown>
  update: (tier: T) => Promise<unknown>
  rollbackProvider: () => Promise<unknown>
}): Promise<void> {
  let providerAdded = false
  try {
    await input.add()
    providerAdded = true
    for (const tier of input.tiers)
      await input.update({ ...tier, chain: withTierPosition(tier.chain, input.spec, input.position) })
  } catch (cause) {
    if (!providerAdded) throw cause
    const restorations = await Promise.allSettled(input.tiers.map(input.update))
    const failedTiers = restorations.flatMap((result, index) =>
      result.status === 'rejected' ? [input.tiers[index].slug] : []
    )
    if (failedTiers.length)
      throw new Error(
        `Assignment failed; rollback incomplete: tiers ${failedTiers.join(', ')} could not be restored; provider retained`,
        { cause }
      )
    try {
      await input.rollbackProvider()
    } catch (rollbackCause) {
      throw new Error('Assignment failed; tiers were restored but provider removal failed; provider retained', {
        cause: rollbackCause,
      })
    }
    throw new Error(
      `Assignment failed and was fully rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  }
}

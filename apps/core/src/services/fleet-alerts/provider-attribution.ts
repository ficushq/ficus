import {
  resolveProviderHealthRecord,
  routeDecision,
  type ProviderHealthRecord,
  type ProviderRoute,
} from '@ficus/shared/provider-health'
import { Agent } from '../../entities/Agent'
import { tryGetModelRuntime } from '../agent'
import { listAccounts, readAccountStore, type AccountStoreV1 } from '../agent/account-store'
import { ModelSelectionError, selectModelSpecForCurrentEnv } from '../model-selection'
import { buildProviderChains } from './provider-chains'
import type { SquadDemandSnapshot } from './demand'

/** Resolve exactly the chain a new runner would use, including flow snapshots and overrides. */
export async function getDemandProviderChains(
  snapshot: SquadDemandSnapshot,
  adapter: {
    selectModel?: typeof selectModelSpecForCurrentEnv
    accountStore?: AccountStoreV1
    hasConfiguredAuth?: (provider: string) => boolean
  } = {}
): Promise<ProviderRoute[][]> {
  if (!snapshot.agentIds?.length) return []
  const { flowAgentType } = await import('../workflows/execution')
  const specs: string[] = []
  const selectModel = adapter.selectModel ?? selectModelSpecForCurrentEnv
  try {
    for (const id of snapshot.agentIds) {
      const agent = await Agent.mustFind(id)
      const type = (await flowAgentType(id)) ?? (await agent.mustGetAgentType())
      const spec = await agent.getEffectiveModelSpec(type.model)
      try {
        // The actual selector includes valid models, disabled providers, and
        // derived OpenRouter fallbacks. A selectable route disproves blockage.
        selectModel(spec)
        return []
      } catch (error) {
        if (!(error instanceof ModelSelectionError)) return []
        const blocked = error.candidates.filter((candidate) => candidate.reason === 'provider-exhausted')
        if (!blocked.length) return []
        specs.push(blocked.map((candidate) => candidate.spec).join(','))
      }
    }
  } catch {
    // A missing/disabled type or unresolved chain cannot prove provider causality.
    return []
  }
  const runtime = tryGetModelRuntime()
  const store = adapter.accountStore ?? readAccountStore()
  const hasAuth = adapter.hasConfiguredAuth ?? ((provider: string) => runtime?.hasConfiguredAuth(provider) ?? false)
  // Configured but unusable accounts do not create a runtime-auth escape route
  // in providerRouteDecision. Keep the demand chain equally conservative.
  return buildProviderChains(
    specs,
    store,
    (provider) => listAccounts(store, provider).length === 0 && hasAuth(provider)
  )
}

/**
 * A single cause is defensible only when every demand chain has usable routes,
 * all are currently cooling down, and the same failure explains them all.
 * Ready fallbacks, other accounts, unknown routes, and expired retry deadlines
 * deliberately leave the stall unattributed. Health records remain untouched.
 */
export function blockedDemandProvider(
  chains: readonly (readonly ProviderRoute[])[],
  records: readonly ProviderHealthRecord[],
  now: number
): ProviderHealthRecord | undefined {
  if (!chains.length) return undefined
  let cause: ProviderHealthRecord | undefined
  for (const chain of chains) {
    const routes = chain.filter((route) => route.credentialUsable)
    if (!routes.length) return undefined
    for (const route of routes) {
      if (routeDecision(route, records, now).state !== 'cooldown') return undefined
      const record = resolveProviderHealthRecord(route, records)
      if (!record || (cause && (cause.provider !== record.provider || cause.accountId !== record.accountId)))
        return undefined
      cause = record
    }
  }
  return cause
}

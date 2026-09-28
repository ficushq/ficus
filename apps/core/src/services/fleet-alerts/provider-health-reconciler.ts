import { and, eq, isNull } from 'drizzle-orm'
import {
  fleetStarved,
  resolveProviderHealthRecord,
  type ProviderHealthRecord,
  type ProviderRoute,
} from '@ficus/shared/provider-health'
import { db } from '../../db'
import { fleetIncidents } from '../../db/schema'
import { observeProvider } from './store'

export interface ReconcileProviderHealthInput {
  records: readonly ProviderHealthRecord[]
  enabledChains: readonly (readonly ProviderRoute[])[]
  now: Date
}

const accountSentinel = (accountId?: string) => accountId ?? '__provider__'
const recordScope = (record: Pick<ProviderHealthRecord, 'provider' | 'accountId'>) =>
  `provider:${record.provider}:account:${accountSentinel(record.accountId)}`

/** Reconcile durable alert episodes from the exact configured routes and shared resolver used by provider status. */
export async function reconcileProviderHealthRecords(
  input: ReconcileProviderHealthInput
): Promise<{ fleetStarved: boolean }> {
  const routes = new Map<string, ProviderRoute>()
  for (const chain of input.enabledChains) {
    for (const route of chain) {
      const key = `${route.provider}\u0000${route.accountId ?? ''}`
      const prior = routes.get(key)
      routes.set(key, prior ? { ...route, credentialUsable: prior.credentialUsable || route.credentialUsable } : route)
    }
  }

  // A raw record is alertable only when it actually resolves at least one
  // configured credential-usable route. This prevents stale/unused records
  // from diverging from fleetStarved.
  const applicable = new Map<string, ProviderHealthRecord>()
  for (const route of routes.values()) {
    if (!route.credentialUsable) continue
    const record = resolveProviderHealthRecord(route, input.records)
    if (record) applicable.set(recordScope(record), record)
  }
  for (const record of applicable.values()) {
    await observeProvider({ status: 'unhealthy', record, now: input.now })
  }

  const openClassified = await db
    .select({
      provider: fleetIncidents.provider,
      accountId: fleetIncidents.accountId,
      scopeKey: fleetIncidents.scopeKey,
    })
    .from(fleetIncidents)
    .where(and(eq(fleetIncidents.kind, 'provider_unhealthy'), isNull(fleetIncidents.resolvedAt)))
  for (const incident of openClassified) {
    if (!incident.provider || incident.scopeKey.startsWith('provider-null:') || applicable.has(incident.scopeKey))
      continue
    await observeProvider({
      status: 'healthy',
      provider: incident.provider,
      accountId: incident.accountId ?? undefined,
      now: input.now,
    })
  }

  return { fleetStarved: fleetStarved(input.enabledChains, input.records) }
}

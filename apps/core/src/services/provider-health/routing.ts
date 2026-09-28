import {
  routeDecision,
  type ProviderHealthRecord,
  type ProviderRoute,
  type RouteDecision,
} from '@ficus/shared/provider-health'
import { listAccounts, type AccountStoreV1 } from '../agent/account-store'

/** Build and aggregate a provider's configured concrete routes. */
export function providerRouteDecision(
  provider: string,
  store: AccountStoreV1,
  records: readonly ProviderHealthRecord[],
  runtimeAuthConfigured: boolean,
  now = Date.now()
): RouteDecision | null {
  const accounts = listAccounts(store, provider)
  const routes: ProviderRoute[] =
    accounts.length > 0
      ? accounts.map((account) => ({
          provider,
          accountId: account.id,
          credentialUsable: account.enabled && account.credential != null,
        }))
      : [{ provider, credentialUsable: runtimeAuthConfigured }]
  return aggregateRouteDecision(routes, records, now)
}

export function providerSwitchBackEligible(
  provider: string,
  store: AccountStoreV1,
  records: readonly ProviderHealthRecord[],
  runtimeAuthConfigured: boolean,
  windowMs: number,
  now = Date.now()
): boolean {
  const accounts = listAccounts(store, provider)
  const routes: ProviderRoute[] =
    accounts.length > 0
      ? accounts.map((account) => ({
          provider,
          accountId: account.id,
          credentialUsable: account.enabled && account.credential != null,
        }))
      : [{ provider, credentialUsable: runtimeAuthConfigured }]
  return routeSwitchBackEligible(routes, records, windowMs, now)
}

/** Aggregate concrete credential routes without confusing missing auth with exhaustion. */
export function aggregateRouteDecision(
  routes: readonly ProviderRoute[],
  records: readonly ProviderHealthRecord[],
  now = Date.now()
): RouteDecision | null {
  const usable = routes.filter((route) => route.credentialUsable)
  if (usable.length === 0) return null

  const decisions = usable.map((route) => routeDecision(route, records, now))
  if (decisions.some((decision) => decision.state === 'ready')) return { state: 'ready' }
  const cooldowns = decisions.filter((decision) => decision.state === 'cooldown')
  return { state: 'cooldown', retryAt: Math.min(...cooldowns.map((decision) => decision.retryAt)) }
}

/** Evaluate the anti-flap delay for each concrete ready route. */
export function routeSwitchBackEligible(
  routes: readonly ProviderRoute[],
  records: readonly ProviderHealthRecord[],
  windowMs: number,
  now = Date.now()
): boolean {
  return routes.some((route) => {
    if (!route.credentialUsable || routeDecision(route, records, now).state !== 'ready') return false
    const exact = route.accountId
      ? records.find((record) => record.provider === route.provider && record.accountId === route.accountId)
      : undefined
    const record =
      exact ?? records.find((candidate) => candidate.provider === route.provider && candidate.accountId == null)
    if (
      record == null ||
      record.kind === 'invalid-credential' ||
      record.kind === 'expired-oauth' ||
      !Number.isFinite(record.retryAt) ||
      (record.lastSuccessAt != null && record.lastSuccessAt > record.since)
    ) {
      return true
    }
    return now >= record.retryAt! + windowMs
  })
}

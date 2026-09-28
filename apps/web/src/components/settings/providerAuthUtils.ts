import type { QueryClient } from '@tanstack/react-query'
import type { ProviderHealthKind } from '@ficus/shared'
import type { ProviderAuthEntry } from '../../api/providerAuth'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'

export interface CatalogEntryLike {
  id: string
  label: string
}

/** Catalog providers that are not already shown as cards or configured. */
export function selectableProviders<T extends CatalogEntryLike>(catalog: T[], hiddenIds: Set<string>): T[] {
  return catalog.filter((p) => !hiddenIds.has(p.id))
}

/**
 * Sort rank for provider cards: providers with a usable account first, then
 * providers whose stored accounts are all disabled, then providers with no
 * accounts. The order within each group remains the registry/catalog order.
 */
export function providerActivityRank(entries: Array<ProviderAuthEntry | undefined>): 0 | 1 | 2 {
  const presentEntries = entries.filter((entry): entry is ProviderAuthEntry => entry !== undefined)
  const hasEnabledAccount = presentEntries.some((entry) => {
    if (entry.disabled) return false
    if (entry.accounts !== undefined) {
      return entry.accounts.some((account) => account.enabled && account.hasCredential !== false)
    }
    return entry.hasCredential
  })

  if (hasEnabledAccount) return 0
  if (presentEntries.some((entry) => (entry.accounts?.length ?? 0) > 0 || entry.hasCredential)) return 1
  return 2
}

export function extractOAuthCode(input: string): string {
  const value = input.trim()
  if (!value) return ''

  try {
    const url = new URL(value)
    return url.searchParams.get('code')?.trim() || value
  } catch {
    return value
  }
}

/** Refresh auth cards and any derived model-tier rows after a credential mutation. */
export function invalidateProviderRoutingQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providerAuth.all }),
    queryClient.invalidateQueries({ queryKey: ['model-tiers'] }),
  ])
}

const HEALTH_REASON_LABELS: Record<ProviderHealthKind, string> = {
  'rate-limit': 'rate limit',
  'plan-credit': 'plan limit',
  capacity: 'capacity',
  network: 'connection',
  error: 'error',
  'invalid-credential': 'invalid credential',
  'expired-oauth': 'expired sign-in',
}

const CREDENTIAL_HEALTH_KINDS: readonly ProviderHealthKind[] = ['invalid-credential', 'expired-oauth']

/**
 * True for the health kinds a reset cannot fix. Routing already treats these as
 * ready, so the record exists only to tell the operator to re-authorize —
 * clearing it would hide the remediation instead of performing it.
 */
export function isCredentialHealthReason(reason: ProviderHealthKind | undefined): boolean {
  return reason != null && CREDENTIAL_HEALTH_KINDS.includes(reason)
}

/** Operator-readable label for a health record's kind; `null` when unknown. */
export function healthReasonLabel(reason: ProviderHealthKind | undefined): string | null {
  return reason ? (HEALTH_REASON_LABELS[reason] ?? null) : null
}

/**
 * Approximate time until an exhausted record recovers, e.g. `~45s`, `~12m`,
 * `~4h 12m`, `~2d 3h`. Deliberately coarse — the underlying `retryAt` is an
 * estimate, and a to-the-second countdown would overstate it. `null` when there
 * is no reset or it has already elapsed (the row is about to recover anyway).
 */
export function formatRetryIn(retryAt: number | undefined, now: number = Date.now()): string | null {
  if (retryAt == null || !Number.isFinite(retryAt)) return null
  const seconds = Math.round((retryAt - now) / 1000)
  if (seconds <= 0) return null
  if (seconds < 60) return `~${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const remainder = minutes % 60
    return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainderHours = hours % 24
  return remainderHours ? `~${days}d ${remainderHours}h` : `~${days}d`
}

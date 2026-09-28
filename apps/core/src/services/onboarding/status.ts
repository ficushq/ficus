import { and, eq, isNotNull } from 'drizzle-orm'
import { db, integrationConnections } from '../../db'
import { integrationEnabledPredicate } from '../integrations/provider-state'
import { resolveOAuthAuthority } from '../integrations/authorization/authority'
import { parseGitHubConfiguration } from '@ficus/shared/oauth-providers/github/config'
/**
 * Onboarding status: a fresh tau instance's setup checklist.
 *
 * Every item's state is DERIVED from a live signal on every read — item
 * completion is never stored. Only the admin's explicit "skip this optional
 * item" decision is persisted (one JSON document in the existing `settings`
 * KV store). A skipped item whose signal later becomes true reads `done` —
 * completion always outranks a skip, and un-skipping is implicit.
 *
 * See docs/history/superpowers/specs/2026-08-05-onboarding-checklist-design.md §2.
 */
import { tryGetModelRuntime } from '../agent'
import { readAccountStore } from '../agent/account-store'
import { Squad } from '../../entities/Squad'
import { KeyedSerialQueue } from '../../lib/infra/inflight'
import { isProviderConfigured } from '../../routes/provider-auth'
import { getSettingsStore } from '../settings'

export type OnboardingItemId = 'ai_provider' | 'first_squad' | 'github'

export type OnboardingItemState = 'todo' | 'done' | 'skipped'

export interface OnboardingItem {
  id: OnboardingItemId
  required: boolean
  state: OnboardingItemState
}

export interface OnboardingStatus {
  ready: boolean
  items: OnboardingItem[]
}

/** Item ids in the order the design's response table lists them — the response's item order. */
export const ONBOARDING_ITEM_ORDER: readonly OnboardingItemId[] = ['ai_provider', 'github', 'first_squad']

const REQUIRED_ITEM_IDS: ReadonlySet<OnboardingItemId> = new Set(['ai_provider', 'first_squad'])

export function isOnboardingItemId(value: string): value is OnboardingItemId {
  return (ONBOARDING_ITEM_ORDER as readonly string[]).includes(value)
}

export function isRequiredOnboardingItem(id: OnboardingItemId): boolean {
  return REQUIRED_ITEM_IDS.has(id)
}

/** Thrown by {@link setItemSkipped} when asked to skip a required item. */
export class OnboardingRequiredItemError extends Error {}

const ONBOARDING_SKIPS_KEY = 'onboarding.skips'

/** Read the persisted skip-flag document. Malformed/absent reads as "nothing skipped". */
function readSkipSet(): Set<OnboardingItemId> {
  const raw = getSettingsStore().get(ONBOARDING_SKIPS_KEY)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is OnboardingItemId => typeof id === 'string' && isOnboardingItemId(id)))
  } catch {
    return new Set()
  }
}

/**
 * Pure state-derivation algebra: given the live true/false signal for every
 * item and the set of ids an admin has explicitly skipped, compute each
 * item's displayed state and overall readiness.
 *
 * Completion always outranks a skip: a `done` signal wins regardless of the
 * skip set, so a skip on an item whose signal later becomes true — or was
 * already true — reads `done`. Skip only ever applies to optional items;
 * `signals`/`skippedIds` for a required id are irrelevant to whether it can
 * be marked skipped (that's enforced in {@link setItemSkipped}), but a stray
 * skip entry for a required id is still ignored here for safety.
 *
 * `ready` = every required item `done` AND every optional item `done` or
 * `skipped` — nothing silently disappears.
 */
export function computeOnboardingStatus(
  signals: Record<OnboardingItemId, boolean>,
  skippedIds: ReadonlySet<OnboardingItemId>
): OnboardingStatus {
  const items: OnboardingItem[] = ONBOARDING_ITEM_ORDER.map((id) => {
    const required = REQUIRED_ITEM_IDS.has(id)
    const done = signals[id]
    const state: OnboardingItemState = done ? 'done' : !required && skippedIds.has(id) ? 'skipped' : 'todo'
    return { id, required, state }
  })
  const ready = items.every((item) => item.state === 'done' || item.state === 'skipped')
  return { ready, items }
}

// --- Live signal sources ------------------------------------------------
// Every function here reads live state — nothing here is cached beyond the
// underlying store's own request-scoped cache, and nothing here is written.

/**
 * Whether ANY provider currently has usable auth — a stored+enabled account
 * credential, or env/runtime fallback auth. Reuses `isProviderConfigured`
 * (routes/provider-auth.ts) — the same predicate the provider-auth UI's
 * `configured` flag uses — over every provider with a stored account plus
 * every provider currently registered with the model runtime, so an
 * env-var-only provider (no stored account row) still counts.
 */
function isAnyProviderConfigured(): boolean {
  const providerIds = new Set<string>(Object.keys(readAccountStore().accounts))
  const runtime = tryGetModelRuntime()
  if (runtime) {
    for (const id of runtime.getRegisteredProviderIds()) providerIds.add(id)
  }
  for (const provider of providerIds) {
    if (isProviderConfigured(provider)) return true
  }
  return false
}

async function hasGithubConnection(): Promise<boolean> {
  // Setup is about an established account, not its short-lived runtime lease.
  // Refresh/validation failures stay visible in Integrations; they must not restart
  // onboarding. Pending accounts and removed/disabled integrations still need setup.
  const rows = await db
    .select({ configuration: integrationConnections.configuration })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.adapterVersion, 1),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.clientAuthority, resolveOAuthAuthority()),
        isNotNull(integrationConnections.validatedAt)
      )
    )
  return rows.some((row) => {
    try {
      return Boolean(parseGitHubConfiguration(row.configuration).login)
    } catch {
      return false
    }
  })
}

/** Only the three main setup steps contribute to onboarding progress. */
async function getLiveSignals(): Promise<Record<OnboardingItemId, boolean>> {
  const [firstSquad, github] = await Promise.all([Squad.exists(), hasGithubConnection()])
  return {
    ai_provider: isAnyProviderConfigured(),
    first_squad: firstSquad,
    github,
  }
}

/** Derive the full onboarding status from live signals plus persisted skip flags. */
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const signals = await getLiveSignals()
  const skippedIds = readSkipSet()
  return computeOnboardingStatus(signals, skippedIds)
}

// Serializes the onboarding.skips read-modify-write in-process, the same
// remedy `mutateAccountStore` (services/agent/account-store.ts) uses for the
// identical shape of bug: two concurrent read-then-await-write cycles both
// read the same stale set, and whichever write lands last silently drops the
// other's update. This is admin-only, single-process state (no worker/API
// cross-process writer, unlike the account store), so in-process
// serialization alone is sufficient — no row-lock/transaction needed.
const skipMutationQueue = new KeyedSerialQueue()

/**
 * Set or clear the skip flag for an optional item. Throws
 * {@link OnboardingRequiredItemError} for a required id — required items can
 * never be skipped. Idempotent: skipping an already-skipped (or
 * already-done) item still writes, but the write is a no-op as far as the
 * displayed state goes — completion outranks the flag, and un-skipping is
 * implicit once the signal goes true.
 */
export async function setItemSkipped(id: OnboardingItemId, skipped: boolean, actor: string): Promise<void> {
  if (REQUIRED_ITEM_IDS.has(id)) {
    throw new OnboardingRequiredItemError(`'${id}' is a required onboarding item and cannot be skipped`)
  }
  await skipMutationQueue.run(ONBOARDING_SKIPS_KEY, async () => {
    const current = readSkipSet()
    if (skipped) current.add(id)
    else current.delete(id)
    await getSettingsStore().set(ONBOARDING_SKIPS_KEY, JSON.stringify([...current]), actor)
  })
}

/**
 * Operator resets of provider health, carried from the API to the worker.
 *
 * The worker is the only writer of provider health (see registry.ts). The API
 * holds a read-only replica that is replaced at every hydration, so a reset
 * applied to the replica alone is undone within one settings refresh and never
 * reaches the worker, which is where routing decides whether an account may be
 * used. The API therefore records each reset in a setting; the worker applies
 * it to the state it owns and persists the result, which the API hydrates.
 *
 * A request carries the time it was made and clears only an episode that
 * began before then. The worker reads the stored requests at startup, on each
 * change and at each periodic settings refresh, so the same request is seen
 * many times: a failure observed after the reset must stay recorded.
 */

import { createLogger } from '../../lib/infra/logger'
import { getSettingsStore } from '../settings'
import { providerHealth, type ProviderHealthPersistence, type ProviderHealthRegistry } from './registry'

const log = createLogger('provider-health')

export const PROVIDER_HEALTH_RESET_REQUESTS_KEY = 'PROVIDER_HEALTH_RESET_REQUESTS'

/**
 * How long a request stays stored. The worker applies one within a settings
 * refresh interval (or at its next start), so a day is ample; pruning on write
 * keeps the value small.
 */
const REQUEST_RETENTION_MS = 24 * 60 * 60_000

export interface ProviderHealthResetTarget {
  provider: string
  accountId?: string
}

export interface ProviderHealthResetRequest extends ProviderHealthResetTarget {
  /** Epoch ms when the operator asked. Only an episode that began at or before this is cleared. */
  requestedAt: number
}

interface ResetRequestOptions {
  /** Registry of the calling process, updated at once so its own responses reflect the reset. */
  registry?: ProviderHealthRegistry
  store?: ProviderHealthPersistence
  now?: () => number
}

const settingsPersistence: ProviderHealthPersistence = {
  get: (key) => getSettingsStore().getStoredValue(key),
  set: async (key, value) => getSettingsStore().set(key, value, 'admin'),
}

export function parseProviderHealthResetRequests(raw: string | undefined): ProviderHealthResetRequest[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const { version, requests } = parsed as { version?: unknown; requests?: unknown }
    if (version !== 1 || !Array.isArray(requests)) return []
    return requests.flatMap((value): ProviderHealthResetRequest[] => {
      if (value == null || typeof value !== 'object') return []
      const { provider, accountId, requestedAt } = value as Record<string, unknown>
      if (
        typeof provider !== 'string' ||
        provider.length === 0 ||
        provider.length > 200 ||
        (accountId != null && (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 200)) ||
        typeof requestedAt !== 'number' ||
        !Number.isFinite(requestedAt)
      ) {
        return []
      }
      return [{ provider, ...(accountId ? { accountId: accountId as string } : {}), requestedAt }]
    })
  } catch {
    return []
  }
}

function targetKey(target: ProviderHealthResetTarget): string {
  return target.accountId ? `${target.provider}::${target.accountId}` : target.provider
}

// The stored value is read, merged and written back; serialize so two resets
// handled at the same time cannot drop each other's request.
let pendingWrite: Promise<void> = Promise.resolve()

/**
 * Record an operator reset for the worker to apply, then reflect it in this
 * process's registry. Rejects when the request could not be stored, so a reset
 * that will not take effect is never reported as done.
 */
export function requestProviderHealthReset(
  targets: readonly ProviderHealthResetTarget[],
  opts: ResetRequestOptions = {}
): Promise<void> {
  const store = opts.store ?? settingsPersistence
  const now = opts.now ?? Date.now
  const registry = opts.registry ?? providerHealth
  const write = pendingWrite.then(async () => {
    if (targets.length === 0) return
    const requestedAt = now()
    const requests = new Map<string, ProviderHealthResetRequest>()
    for (const request of parseProviderHealthResetRequests(store.get(PROVIDER_HEALTH_RESET_REQUESTS_KEY))) {
      if (requestedAt - request.requestedAt < REQUEST_RETENTION_MS) requests.set(targetKey(request), request)
    }
    for (const target of targets) {
      requests.set(targetKey(target), {
        provider: target.provider,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        requestedAt,
      })
    }
    await store.set(
      PROVIDER_HEALTH_RESET_REQUESTS_KEY,
      JSON.stringify({ version: 1, requests: [...requests.values()] })
    )
    for (const target of targets) registry.applyReset(target.provider, target.accountId, requestedAt)
  })
  pendingWrite = write.catch(() => {})
  return write
}

/**
 * Worker side: apply every stored request to the registry. Returns how many
 * episodes were cleared; a request that was already applied, or whose episode
 * began after it, clears nothing.
 */
export function applyProviderHealthResetRequests(
  opts: { registry?: ProviderHealthRegistry; store?: ProviderHealthPersistence } = {}
): number {
  const store = opts.store ?? settingsPersistence
  const registry = opts.registry ?? providerHealth
  let applied = 0
  for (const request of parseProviderHealthResetRequests(store.get(PROVIDER_HEALTH_RESET_REQUESTS_KEY))) {
    if (!registry.applyReset(request.provider, request.accountId, request.requestedAt)) continue
    applied++
    log.info(`Operator reset cleared provider health for ${targetKey(request)}`)
  }
  return applied
}

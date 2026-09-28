/**
 * Shared provider-health observation registry.
 *
 * `records` retains unresolved provider/account episodes for operator-facing
 * consumers even after cooldown expiry. Routing consumers use the shared route
 * decision helpers: `retryAt` grants a recovery attempt but is not evidence of
 * observed recovery. The legacy `ProviderHealth` map and `is*Healthy` methods
 * remain only as compatibility projections.
 *
 * The worker is the sole observation writer. It persists records and episode
 * revisions atomically under `PROVIDER_HEALTH_STATE`; a serialized, coalescing,
 * retrying drain keeps failure recording non-blocking and prevents stale writes
 * from overtaking newer snapshots. API processes hydrate that setting as
 * read-only replicas. The old `PROVIDER_HEALTH` array is read only for legacy
 * migration compatibility.
 *
 * Observations come from settled request errors, proactive response-header
 * signals, and affirmative results from registered three-state probes.
 */

import type { ProviderHealthKind, ProviderHealthRecord } from '@ficus/shared/provider-health'
import { getSettingsStore } from '../settings'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('provider-health')

export type HealthState = 'available' | 'exhausted'

/**
 * Why a provider was marked exhausted. Drives the cooldown policy and is
 * surfaced to the UI/API.
 */
export type ExhaustionReason = 'rate-limit' | 'plan-credit' | 'capacity' | 'error'
export type ProviderFailureClassification = { kind: ProviderHealthKind; retryAt?: number; status?: number }

export interface ProviderHealthAttempt {
  readonly provider: string
  readonly accountId?: string
  /** Concrete route receiving a failure/recovery tombstone. */
  readonly writeKey: string
  /** Applicable episode whose revision condition guards settlement. */
  readonly applicableKey: string
  readonly revision: number
  readonly hadActiveFailure: boolean
}

export interface ProviderHealth {
  provider: string
  accountId?: string
  state: HealthState
  reason?: ExhaustionReason
  /** Epoch ms when the state last changed (set when first marked exhausted). */
  since: number
  /** Epoch ms when to consider the provider available again (auto-recover). */
  retryAt?: number
  /** Last observed HTTP status accompanying the exhaustion signal, if any. */
  lastObservedStatus?: number
}

/**
 * Shape persisted to the settings DB. Only exhausted entries are stored
 * (available = absence). `lastObservedStatus` is ephemeral and not persisted.
 */
interface PersistedHealthEntry {
  provider: string
  accountId?: string
  reason: ExhaustionReason
  since: number
  retryAt: number
}

/**
 * Default cooldown (ms) per reason. Credits don't refill fast, so plan-credit
 * gets a much longer window than a transient rate limit. Valid explicit
 * provider reset timestamps remain authoritative and are intentionally uncapped.
 */
const DEFAULT_COOLDOWN_MS: Record<ProviderHealthKind, number> = {
  'rate-limit': 60_000,
  'plan-credit': 30 * 60_000,
  capacity: 5 * 60_000,
  error: 60_000,
  network: 60_000,
  'invalid-credential': 60_000,
  'expired-oauth': 60_000,
}

const HEALTH_SUMMARY: Record<ProviderHealthKind, string> = {
  'rate-limit': 'Provider rate limit reached.',
  'plan-credit': 'Provider plan credit exhausted.',
  capacity: 'Provider capacity unavailable.',
  error: 'Provider request failed.',
  network: 'Provider network unavailable.',
  'invalid-credential': 'Provider credential is invalid.',
  'expired-oauth': 'Provider OAuth credential expired.',
}

/** Settings key for persisted provider health. */
const PROVIDER_HEALTH_KEY = 'PROVIDER_HEALTH'
export const PROVIDER_HEALTH_STATE_KEY = 'PROVIDER_HEALTH_STATE'

export interface ProviderHealthPersistence {
  get(key: string): string | undefined
  set(key: string, value: string): Promise<void>
}

interface PersistedProviderHealthStateV1 {
  version: 1
  records: ProviderHealthRecord[]
  revisions: Record<string, number>
}

/**
 * In-memory observational records plus a legacy compatibility health map.
 * Cooldown expiry changes only compatibility route eligibility; it never
 * resolves or deletes the shared record. Matching revision-guarded success is
 * the normal recovery signal.
 *
 * When persistence is enabled by the worker, mutations enqueue complete
 * versioned snapshots on the ordered drain. API replicas leave persistence
 * disabled and refresh by hydrating settings changes.
 */
export class ProviderHealthRegistry {
  private map = new Map<string, ProviderHealth>()
  private records = new Map<string, ProviderHealthRecord>()
  private revisions = new Map<string, number>()
  private readonly now: () => number
  private readonly persistence: ProviderHealthPersistence
  private readonly sleep: (ms: number) => Promise<void>
  private pendingSnapshot?: string
  private persistenceDrain?: Promise<void>

  constructor(
    opts: {
      now?: () => number
      persistence?: ProviderHealthPersistence
      sleep?: (ms: number) => Promise<void>
    } = {}
  ) {
    this.now = opts.now ?? Date.now
    this.persistence = opts.persistence ?? {
      get: (key) => getSettingsStore().get(key),
      set: async (key, value) => getSettingsStore().set(key, value, 'admin'),
    }
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }
  /**
   * Most recent compatibility cooldown boundary, retained so legacy
   * {@link isStablyHealthy} callers can enforce a post-cooldown window.
   */
  private lastExhaustionRetryAt = new Map<string, number>()
  private persistenceEnabled = false

  /** Enable worker-owned ordered persistence of complete versioned snapshots. */
  enablePersistence(): void {
    this.persistenceEnabled = true
  }

  /** Disable persistence (test helper). */
  disablePersistence(): void {
    this.persistenceEnabled = false
  }

  /**
   * Replace in-memory state from the versioned settings snapshot. Elapsed
   * unresolved records are retained; malformed transient records are repaired
   * with their kind default and the worker persists the repaired invariant.
   */
  async hydrateFromPersistence(): Promise<void> {
    this.map.clear()
    this.records.clear()
    this.revisions.clear()
    this.lastExhaustionRetryAt.clear()

    const state = parsePersistedState(this.persistence.get(PROVIDER_HEALTH_STATE_KEY))
    if (state) {
      let repaired = false
      for (const record of state.records)
        repaired =
          this.hydrateRecord(record, state.revisions[healthKey(record.provider, record.accountId)] ?? 0) || repaired
      this.pruneRecoveredExactTombstones()
      if (repaired) this.persist()
      log.info(`Hydrated ${this.records.size} provider health record(s) from DB`)
      return
    }

    let repaired = false
    for (const entry of readPersistedEntries(this.persistence.get(PROVIDER_HEALTH_KEY))) {
      const kind = entry.reason
      repaired =
        this.hydrateRecord(
          {
            provider: entry.provider,
            ...(entry.accountId ? { accountId: entry.accountId } : {}),
            kind,
            message: HEALTH_SUMMARY[kind],
            since: entry.since,
            retryAt: entry.retryAt,
          },
          1
        ) || repaired
    }
    if (repaired) this.persist()
  }

  private hydrateRecord(record: ProviderHealthRecord, revision: number): boolean {
    const transient = record.kind !== 'invalid-credential' && record.kind !== 'expired-oauth'
    const needsRepair =
      record.lastSuccessAt == null && transient && (!Number.isFinite(record.retryAt) || record.retryAt == null)
    const hydrated = needsRepair ? { ...record, retryAt: this.now() + DEFAULT_COOLDOWN_MS[record.kind] } : record
    const key = healthKey(hydrated.provider, hydrated.accountId)
    this.records.set(key, hydrated)
    this.revisions.set(key, revision)
    if (hydrated.lastSuccessAt != null && hydrated.lastSuccessAt > hydrated.since) return needsRepair
    const reason: ExhaustionReason =
      hydrated.kind === 'network' || hydrated.kind === 'invalid-credential' || hydrated.kind === 'expired-oauth'
        ? 'error'
        : hydrated.kind
    this.map.set(key, {
      provider: hydrated.provider,
      accountId: hydrated.accountId,
      state: 'exhausted',
      reason,
      since: hydrated.since,
      retryAt: hydrated.retryAt,
    })
    if (hydrated.retryAt != null) this.lastExhaustionRetryAt.set(key, hydrated.retryAt)
    return needsRepair
  }

  captureAttempt(provider: string, accountId?: string): ProviderHealthAttempt {
    const writeKey = healthKey(provider, accountId)
    const providerKey = healthKey(provider)
    const exact = accountId ? this.records.get(writeKey) : undefined
    // A recovered exact tombstone intentionally masks provider-wide history.
    const applicableKey = exact ? writeKey : this.records.has(providerKey) ? providerKey : writeKey
    const applicable = this.records.get(applicableKey)
    return Object.freeze({
      provider,
      ...(accountId ? { accountId } : {}),
      writeKey,
      applicableKey,
      revision: this.revisions.get(applicableKey) ?? 0,
      hadActiveFailure: applicable != null && !recordRecovered(applicable),
    })
  }

  getRecord(provider: string, accountId?: string): ProviderHealthRecord | undefined {
    return this.records.get(healthKey(provider, accountId))
  }

  snapshotRecords(): ProviderHealthRecord[] {
    return [...this.records.values()]
  }

  recordFailure(attempt: ProviderHealthAttempt, failure: ProviderFailureClassification): boolean {
    if ((this.revisions.get(attempt.applicableKey) ?? 0) !== attempt.revision) return false
    const existing = this.records.get(attempt.writeKey)
    const activeExisting = existing && !recordRecovered(existing) ? existing : undefined
    const now = this.now()
    const credentialKind = failure.kind === 'invalid-credential' || failure.kind === 'expired-oauth'
    const suppliedRetry = Number.isFinite(failure.retryAt) && failure.retryAt! > now ? failure.retryAt! : undefined
    let kind = failure.kind
    if (
      activeExisting &&
      ((activeExisting.kind === 'plan-credit' && failure.kind !== 'plan-credit' && !credentialKind) ||
        ((activeExisting.kind === 'invalid-credential' || activeExisting.kind === 'expired-oauth') && !credentialKind))
    ) {
      kind = activeExisting.kind
    }
    const transient = kind !== 'invalid-credential' && kind !== 'expired-oauth'
    const retryAt = transient
      ? Math.max(activeExisting?.retryAt ?? 0, suppliedRetry ?? now + DEFAULT_COOLDOWN_MS[kind])
      : undefined
    const record: ProviderHealthRecord = {
      provider: attempt.provider,
      ...(attempt.accountId ? { accountId: attempt.accountId } : {}),
      kind,
      message: HEALTH_SUMMARY[kind],
      since: activeExisting?.since ?? now,
      ...(retryAt != null ? { retryAt } : {}),
    }
    this.records.set(attempt.writeKey, record)
    this.revisions.set(attempt.applicableKey, attempt.revision + 1)
    if (attempt.writeKey !== attempt.applicableKey) {
      this.revisions.set(attempt.writeKey, (this.revisions.get(attempt.writeKey) ?? 0) + 1)
    }
    this.map.set(attempt.writeKey, {
      provider: record.provider,
      accountId: record.accountId,
      state: 'exhausted',
      reason: kind === 'network' || kind === 'invalid-credential' || kind === 'expired-oauth' ? 'error' : kind,
      since: record.since,
      retryAt: record.retryAt,
      lastObservedStatus: failure.status ?? this.map.get(attempt.writeKey)?.lastObservedStatus,
    })
    if (retryAt != null) this.lastExhaustionRetryAt.set(attempt.writeKey, retryAt)
    if (!attempt.accountId) this.pruneRecoveredExactTombstones(attempt.provider)
    this.persist()
    return true
  }

  recordSuccess(attempt: ProviderHealthAttempt): boolean {
    if (!attempt.hadActiveFailure || (this.revisions.get(attempt.applicableKey) ?? 0) !== attempt.revision) return false
    const applicable = this.records.get(attempt.applicableKey)
    if (!applicable || recordRecovered(applicable)) return false
    const successKey = attempt.writeKey
    this.records.set(successKey, {
      ...applicable,
      provider: attempt.provider,
      ...(attempt.accountId ? { accountId: attempt.accountId } : { accountId: undefined }),
      lastSuccessAt: Math.max(this.now(), applicable.since + 1),
    })
    this.revisions.set(attempt.applicableKey, attempt.revision + 1)
    if (successKey !== attempt.applicableKey) {
      this.revisions.set(successKey, (this.revisions.get(successKey) ?? 0) + 1)
    }
    this.map.delete(successKey)
    if (!attempt.accountId) this.pruneRecoveredExactTombstones(attempt.provider)
    this.persist()
    return true
  }

  /** Health for a provider; defaults to `available` when unseen. */
  getHealth(provider: string): ProviderHealth {
    return this.getHealthForKey(provider)
  }

  /** Health for a specific provider account; defaults to `available` when unseen. */
  getAccountHealth(provider: string, accountId: string): ProviderHealth {
    return this.getHealthForKey(provider, accountId)
  }

  /**
   * Whether the provider is currently considered healthy (usable for new
   * sessions). `true` for available providers, and for exhausted providers
   * whose cooldown has elapsed (auto-recover).
   */
  isProviderHealthy(provider: string): boolean {
    return this.isHealthyForKey(provider)
  }

  /** Whether the provider account is currently considered healthy. */
  isAccountHealthy(provider: string, accountId: string): boolean {
    return this.isHealthyForKey(provider, accountId)
  }

  /**
   * Whether a provider is healthy AND has been recovered long enough to
   * proactively switch BACK to (anti-flap gate). Stricter than
   * {@link isProviderHealthy}: requires `windowMs` to have elapsed past the
   * last exhaustion's `retryAt`. Providers that were never exhausted are always
   * stable.
   */
  isStablyHealthy(provider: string, windowMs: number): boolean {
    if (!this.isProviderHealthy(provider)) return false
    const retryAt = this.lastExhaustionRetryAt.get(provider)
    if (retryAt == null) return true
    return this.now() >= retryAt + windowMs
  }

  /**
   * Mark a provider exhausted, extending the cooldown if one is already active.
   * Never shortens an existing cooldown — the maximum of the new and existing
   * `retryAt` wins. Preserves the original `since` for already-exhausted
   * providers.
   */
  markExhausted(provider: string, opts: { reason?: ExhaustionReason; retryAt?: number; status?: number } = {}): void {
    this.markExhaustedForKey(provider, undefined, opts)
  }

  /** Mark a provider account exhausted, extending its cooldown if one is already active. */
  markAccountExhausted(
    provider: string,
    accountId: string,
    opts: { reason?: ExhaustionReason; retryAt?: number; status?: number } = {}
  ): void {
    this.markExhaustedForKey(provider, accountId, opts)
  }

  /** Mark a provider available again (clears the entry). */
  markAvailable(provider: string): void {
    this.recordSuccess(this.captureAttempt(provider))
  }

  /** Mark a provider account available again (records an exact recovery tombstone). */
  markAccountAvailable(provider: string, accountId: string): void {
    this.recordSuccess(this.captureAttempt(provider, accountId))
  }

  /** Clear all entries (test/utility helper). */
  clear(): void {
    this.map.clear()
    this.records.clear()
    this.revisions.clear()
    this.lastExhaustionRetryAt.clear()
  }

  /**
   * Snapshot of currently-exhausted providers. Expired cooldowns are dropped
   * so the snapshot reflects recovered state.
   */
  snapshot(): ProviderHealth[] {
    const now = this.now()
    for (const [k, h] of this.map) {
      if (h.state === 'exhausted' && h.retryAt != null && now >= h.retryAt) this.map.delete(k)
    }
    return Array.from(this.map.values())
  }

  /**
   * Fire-and-forget write of the current exhausted entries to the settings DB.
   * Never blocks the caller — errors are logged but not thrown.
   */
  private persist(): void {
    if (!this.persistenceEnabled) return
    const state: PersistedProviderHealthStateV1 = {
      version: 1,
      records: this.snapshotRecords(),
      revisions: Object.fromEntries(this.revisions),
    }
    this.pendingSnapshot = JSON.stringify(state)
    this.persistenceDrain ??= this.drainPersistence().finally(() => {
      this.persistenceDrain = undefined
      if (this.pendingSnapshot != null) this.persist()
    })
  }

  private async drainPersistence(): Promise<void> {
    let failures = 0
    while (this.pendingSnapshot != null) {
      const snapshot = this.pendingSnapshot
      try {
        await this.persistence.set(PROVIDER_HEALTH_STATE_KEY, snapshot)
        if (this.pendingSnapshot === snapshot) this.pendingSnapshot = undefined
        failures = 0
      } catch (error) {
        failures++
        log.error('Failed to persist provider health to DB:', error)
        await this.sleep(Math.min(100 * 2 ** (failures - 1), 5_000))
      }
    }
  }

  async flushPersistence(timeoutMs?: number): Promise<void> {
    const flush = async () => {
      while (this.persistenceDrain) await this.persistenceDrain
    }
    if (timeoutMs == null) return flush()
    await Promise.race([flush(), this.sleep(timeoutMs)])
  }

  private getHealthForKey(provider: string, accountId?: string): ProviderHealth {
    return (
      this.map.get(healthKey(provider, accountId)) ?? { provider, accountId, state: 'available', since: this.now() }
    )
  }

  private isHealthyForKey(provider: string, accountId?: string): boolean {
    const h = this.getHealthForKey(provider, accountId)
    if (h.state === 'available') return true
    // Auto-recover: exhausted but retryAt has passed.
    if (h.retryAt != null && this.now() >= h.retryAt) return true
    return false
  }

  private pruneRecoveredExactTombstones(provider?: string): void {
    for (const [key, record] of this.records) {
      if (!record.accountId || !recordRecovered(record) || (provider != null && record.provider !== provider)) continue
      const providerRecord = this.records.get(healthKey(record.provider))
      const masksOlderProviderFailure =
        providerRecord != null && !recordRecovered(providerRecord) && providerRecord.since < record.lastSuccessAt!
      if (masksOlderProviderFailure) continue
      this.records.delete(key)
      this.revisions.delete(key)
      this.map.delete(key)
    }
  }

  private markExhaustedForKey(
    provider: string,
    accountId: string | undefined,
    opts: { reason?: ExhaustionReason; retryAt?: number; status?: number }
  ): void {
    this.recordFailure(this.captureAttempt(provider, accountId), {
      kind: opts.reason ?? 'error',
      retryAt: opts.retryAt,
      status: opts.status,
    })
  }
}

function recordRecovered(record: ProviderHealthRecord): boolean {
  return record.lastSuccessAt != null && record.lastSuccessAt > record.since
}

function healthKey(provider: string, accountId?: string): string {
  return accountId ? `${provider}::${accountId}` : provider
}

// --- Settings DB read/write helpers ---

function readPersistedEntries(raw: string | undefined): PersistedHealthEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is PersistedHealthEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof e.provider === 'string' &&
        typeof e.reason === 'string' &&
        typeof e.since === 'number' &&
        typeof e.retryAt === 'number'
    )
  } catch {
    return []
  }
}

function parsePersistedState(raw: string | undefined): PersistedProviderHealthStateV1 | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isPlainObject(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.records) ||
      !isPlainObject(parsed.revisions)
    ) {
      return undefined
    }
    const records = parsed.records.flatMap((value): ProviderHealthRecord[] => {
      if (!isPlainObject(value)) return []
      const { provider, accountId, kind, since, retryAt, lastSuccessAt } = value
      if (
        typeof provider !== 'string' ||
        provider.length === 0 ||
        provider.length > 200 ||
        (accountId != null && (typeof accountId !== 'string' || accountId.length > 200)) ||
        typeof kind !== 'string' ||
        !(kind in HEALTH_SUMMARY) ||
        !Number.isFinite(since) ||
        (retryAt != null && !Number.isFinite(retryAt)) ||
        (lastSuccessAt != null && !Number.isFinite(lastSuccessAt))
      ) {
        return []
      }
      return [
        {
          provider,
          ...(accountId ? { accountId } : {}),
          kind: kind as ProviderHealthKind,
          message: HEALTH_SUMMARY[kind as ProviderHealthKind],
          since: since as number,
          ...(retryAt != null ? { retryAt: retryAt as number } : {}),
          ...(lastSuccessAt != null ? { lastSuccessAt: lastSuccessAt as number } : {}),
        },
      ]
    })
    const revisions: Record<string, number> = {}
    for (const [key, revision] of Object.entries(parsed.revisions)) {
      if (Number.isSafeInteger(revision) && (revision as number) >= 0) revisions[key] = revision as number
    }
    return { version: 1, records, revisions }
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Factory for tests / isolated instances (pure in-memory, no persistence). */
export function createProviderHealthRegistry(
  opts: {
    now?: () => number
    persistence?: ProviderHealthPersistence
    sleep?: (ms: number) => Promise<void>
  } = {}
): ProviderHealthRegistry {
  return new ProviderHealthRegistry(opts)
}

/**
 * Process-wide singleton. Used by production code paths (selection chokepoint,
 * runtime failover, the provider-auth API). Tests should prefer
 * {@link createProviderHealthRegistry} or call {@link resetProviderHealthForTests}
 * before touching the singleton.
 *
 * Persistence is enabled by the worker on startup via
 * `providerHealth.enablePersistence()` + `hydrateFromPersistence()`.
 */
export const providerHealth: ProviderHealthRegistry = createProviderHealthRegistry()

/** Reset the singleton's state between tests. */
export function resetProviderHealthForTests(): void {
  providerHealth.clear()
  providerHealth.disablePersistence()
}

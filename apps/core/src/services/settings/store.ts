import { eq } from 'drizzle-orm'
import { decisionFeatureSwitchesSchema, decisionRoutingSchema } from '@ficus/shared'
import { db, settings } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { listen, notify } from '../../lib/infra/local-events'
import { DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS } from '../updates/types'
import {
  MAX_CONCURRENT_AGENTS_SETTING_KEY,
  MAX_MAX_CONCURRENT_AGENTS,
  MIN_MAX_CONCURRENT_AGENTS,
  envMaxConcurrentAgents,
  maxConcurrentAgentsError,
} from '../execution/max-concurrent'

const log = createLogger('settings-store')

/**
 * local-events channel for cross-process cache freshening, mirroring
 * `SECRET_CHANGED_CHANNEL`. The payload is the setting KEY only; the peer
 * re-reads the value from the DB, which stays the source of truth. The
 * transport is best-effort (no retries, no persistence), so a dropped
 * notification simply degrades to the worker's 60s periodic refresh.
 */
export const SETTING_CHANGED_CHANNEL = 'setting_changed'

/**
 * Backstop refresh interval for the settings cache (api AND worker).
 *
 * 5 minutes, not 60s: every write NOTIFYs {@link SETTING_CHANGED_CHANNEL} and
 * both processes subscribe (`startCrossProcessInvalidation`, wired in index.ts
 * right after `startPeriodicRefresh` and in worker.ts's startup), so a value
 * written by the api is visible to the worker in milliseconds. This timer only
 * bounds how long a MISSED notification can linger, so a full-table re-read
 * per process per minute bought nothing.
 */
export const SETTINGS_STORE_REFRESH_INTERVAL_MS = 5 * 60_000

// --- Known Settings ---

interface SettingDef {
  type: 'boolean' | 'string' | 'number'
  default: string
  description: string
  /**
   * Optional write-boundary validator. Returns an error message for a
   * rejected value, or `null` when the value is acceptable. Enforced inside
   * `set()` so EVERY write path (HTTP route, scripts, tests) is covered, not
   * just the API.
   */
  validate?: (value: string) => string | null
  /**
   * Broadcast writes to this key on `SETTING_CHANGED_CHANNEL` so the peer
   * process invalidates its cache immediately.
   *
   * Opt-in, NOT the default. Every broadcast costs a loopback POST plus a
   * `SELECT` on the peer, and most settings are read in the same process that
   * writes them — for those the peer would re-read a key it never consults.
   * Provider-health snapshots are an explicit exception because the API is a
   * read replica and must refresh promptly after worker observations.
   * `markExhausted`/`markAvailable`, so an unconditional broadcast puts that
   * traffic on a rate-limit storm's hot path. Set this only when the CONSUMER
   * lives in the other process and a stale minute would actually hurt;
   * `startPeriodicRefresh` covers everything else.
   */
  crossProcess?: boolean
}

/** Thrown by `SettingsStore.set` when a value fails its key's validator. */
export class SettingValidationError extends Error {
  constructor(
    message: string,
    readonly key: string
  ) {
    super(message)
    this.name = 'SettingValidationError'
  }
}

const KNOWN_SETTINGS: Record<string, SettingDef> = {
  STORAGE_SCAN_INTERVAL_HOURS: {
    type: 'number',
    default: '12',
    crossProcess: true,
    description: 'Hours between background storage scans; 0 disables scheduled scans.',
    validate: (value) =>
      value.trim() &&
      Number.isFinite(Number(value)) &&
      (Number(value) === 0 || (Number(value) >= 1 && Number(value) <= 168))
        ? null
        : 'Use 0 to disable, or 1–168 hours.',
  },
  STORAGE_ALERTS_ENABLED: {
    type: 'boolean',
    default: 'true',
    crossProcess: true,
    description: 'Send storage capacity threshold crossings to the system inbox.',
    validate: (value) => (['true', 'false'].includes(value) ? null : 'Use true or false.'),
  },
  STORAGE_ALERT_THRESHOLDS: {
    type: 'string',
    default: '80,90,95',
    crossProcess: true,
    description: 'Comma-separated storage usage percentages for warnings and inbox alerts.',
    validate: (value) => {
      const parts = value.split(',').map((part) => Number(part.trim()))
      return parts.length >= 1 &&
        parts.length <= 10 &&
        parts.every((n, i) => Number.isInteger(n) && n >= 1 && n <= 100 && (!i || n > parts[i - 1]!))
        ? null
        : 'Use 1–10 increasing, distinct percentages from 1 to 100.'
    },
  },
  TRANSCRIPTION_ENABLED: {
    type: 'boolean',
    default: 'true',
    description: 'Allow voice dictation in chats and question replies. Independent of realtime voice.',
  },
  ASSISTANT_REALTIME_ENABLED: {
    type: 'boolean',
    default: 'true',
    description:
      'Allow realtime assistant sessions using OpenAI API services. Does not disable text chat or audio transcription.',
  },
  EMBEDDINGS_ENABLED: {
    type: 'boolean',
    default: 'true',
    description: 'Enable automatic embedding generation for memory chunks',
  },
  LOCAL_AUTO_UPDATE_ENABLED: {
    type: 'boolean',
    default: String(DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.enabled),
    description: 'Enable automatic updates for local k3d Ficus installs',
  },
  LOCAL_AUTO_UPDATE_INTERVAL_MINUTES: {
    type: 'number',
    default: String(DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.intervalMinutes),
    description: 'Minutes between local k3d update checks',
  },
  LOCAL_AUTO_UPDATE_REMOTE: {
    type: 'string',
    default: DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.remote,
    description: 'Git remote used by the local updater',
  },
  LOCAL_AUTO_UPDATE_GITHUB_CONNECTION_ID: {
    type: 'string',
    default: '',
    description: 'GitHub integration connection used for local updates; required when multiple accounts are connected',
  },
  LOCAL_AUTO_UPDATE_BRANCH: {
    type: 'string',
    default: DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.branch,
    description: 'Git branch used by the local updater',
  },
  INBOX_MAX_ATTACHMENT_BYTES: {
    type: 'number',
    default: '10485760', // 10 MB
    description: 'Maximum size in bytes of a single binary attachment',
  },
  INBOX_MAX_TOTAL_STORAGE_BYTES: {
    type: 'number',
    default: '10737418240', // 10 GB
    description: 'Global cap in bytes on total attachment storage for this instance',
  },
  AGENT_DORMANT_RETENTION_DAYS: {
    type: 'number',
    default: '7',
    description: 'Days a dormant agent remains recoverable before final termination',
  },
  AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS: {
    type: 'number',
    default: '7',
    description: "Days to retain a terminated agent's archived /private data before deletion",
  },
  OPENROUTER_TIER_EXPANSION_ENABLED: {
    type: 'boolean',
    default: 'false',
    description: 'Use authenticated OpenRouter accounts as universal model-tier fallbacks',
    crossProcess: true,
  },
  PROVIDER_HEALTH_STATE: {
    type: 'string',
    default: '',
    description: 'Versioned provider health state shared from the worker to API read replicas',
    crossProcess: true,
  },
  [MAX_CONCURRENT_AGENTS_SETTING_KEY]: {
    type: 'number',
    // Env-aware so `list()` reports the cap that ACTUALLY applies with nothing
    // stored, and so "revert to default" is truthful on instances that set the
    // env var. Reading `process.env` at import is safe — env is fixed for a
    // process's lifetime. What must NEVER be captured at import is the
    // EFFECTIVE cap (see getMaxConcurrentAgents in execution/pickup.ts).
    default: String(envMaxConcurrentAgents()),
    description:
      `Maximum agent executions this instance runs concurrently ` +
      `(${MIN_MAX_CONCURRENT_AGENTS}-${MAX_MAX_CONCURRENT_AGENTS}). Takes effect without a restart. ` +
      `A value stored here overrides the MAX_CONCURRENT_AGENTS environment variable; ` +
      `clear it to fall back to that variable.`,
    validate: (value) => maxConcurrentAgentsError(value),
    // Written by ficus-api, consumed by execution pickup in ficus-worker. Without
    // the broadcast the worker keeps admitting at the OLD cap for up to 60s
    // after the operator saves — which is the whole promise of "takes effect
    // without a restart".
    crossProcess: true,
  },
  DECISION_ROUTING: {
    type: 'string',
    default: '{}',
    description: 'Which decision model providers each purpose asks, in order, and how long to wait for an answer.',
    validate: (value) => {
      try {
        const result = decisionRoutingSchema.safeParse(JSON.parse(value))
        return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid decision routing.')
      } catch {
        return 'Decision routing must be JSON.'
      }
    },
    // Saved in Settings (ficus-api); the GitHub firewall and event rules ask from ficus-worker.
    crossProcess: true,
  },
  DECISION_FEATURES: {
    type: 'string',
    default: '{}',
    description:
      "Instance decision features turned on or off; a feature that isn't listed is on once a decision model exists.",
    validate: (value) => {
      try {
        const result = decisionFeatureSwitchesSchema.safeParse(JSON.parse(value))
        return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid decision features.')
      } catch {
        return 'Decision features must be JSON.'
      }
    },
    // Tools run in ficus-worker; the switch is flipped in Settings (ficus-api).
    crossProcess: true,
  },
} as const

export type SettingKey = keyof typeof KNOWN_SETTINGS

export interface SettingMetadata {
  key: string
  value: string
  type: string
  default: string
  description: string
  isDefault: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

// --- Change Listeners ---

export type SettingChangeListener = (key: string, value: string) => void | Promise<void>

// --- Store ---

export class SettingsStore {
  private cache = new Map<string, string>()
  private refreshRunner: PeriodicRunner | null = null
  private changeListeners: SettingChangeListener[] = []
  private unlistenCrossProcess: (() => Promise<void>) | null = null

  /** Initialize: load from DB into cache. */
  async initialize(): Promise<void> {
    await this.loadFromDb()
    log.info(`SettingsStore initialized (${this.cache.size} settings loaded)`)
  }

  /** Start periodic cache refresh, optionally running a replica hook after each successful load. */
  startPeriodicRefresh(
    intervalMs = SETTINGS_STORE_REFRESH_INTERVAL_MS,
    afterRefresh?: () => void | Promise<void>
  ): void {
    this.stopPeriodicRefresh()
    this.refreshRunner = createPeriodicRunner({
      name: 'settings-store-refresh',
      intervalMs,
      runImmediately: false,
      task: async () => {
        await this.loadFromDb()
        await afterRefresh?.()
      },
    })
    this.refreshRunner.start()
  }

  stopPeriodicRefresh(): void {
    if (this.refreshRunner) {
      // stop() is async only to await an in-flight task; refresh is best-effort
      // cache maintenance, so fire-and-forget keeps this API synchronous.
      void this.refreshRunner.stop()
      this.refreshRunner = null
    }
  }

  /**
   * Subscribe to cross-process setting changes (mirrors the secret store's
   * invalidation). `ficus-api` and `ficus-worker` are separate OS processes, so a
   * value written by the API is otherwise invisible to the worker — which is
   * where execution pickup runs — until the next periodic refresh.
   *
   * This is the FAST PATH only. The DB (re-read here, and polled by
   * `startPeriodicRefresh`) remains the source of truth, because the
   * loopback transport is explicitly best-effort: no retries, no persistence.
   * A dropped notification therefore costs at most one refresh interval, not
   * correctness.
   */
  async startCrossProcessInvalidation(): Promise<void> {
    if (this.unlistenCrossProcess) return
    this.unlistenCrossProcess = await listen(SETTING_CHANGED_CHANNEL, (key) => {
      this.refreshKey(key).catch((err) => {
        log.error(`Failed to refresh setting '${key}' after change notification:`, err)
      })
    })
    log.info('Settings store listening for cross-process changes')
  }

  stopCrossProcessInvalidation(): void {
    if (this.unlistenCrossProcess) {
      // Best-effort teardown, mirroring stopPeriodicRefresh's sync API.
      void this.unlistenCrossProcess().catch(() => {})
      this.unlistenCrossProcess = null
    }
  }

  /**
   * Re-load a single key from the DB into the cache, firing change listeners
   * only when the value actually changed. Safe for self-originated writes
   * (no-op — the cache already holds the value).
   */
  async refreshKey(key: string): Promise<void> {
    const [row] = await db.select().from(settings).where(eq(settings.key, key))

    if (!row) {
      if (this.cache.has(key)) {
        this.cache.delete(key)
        await this.notifyListeners(key, KNOWN_SETTINGS[key]?.default ?? '')
      }
      return
    }

    if (this.cache.get(key) === row.value) return
    this.cache.set(key, row.value)
    await this.notifyListeners(key, row.value)
  }

  /**
   * Broadcast a setting change to other processes (fire-and-forget — the
   * write already committed, and a missed notification degrades to the
   * periodic refresh).
   *
   * Scoped to keys that declare `crossProcess`; see the flag for why this is
   * opt-in rather than universal.
   */
  private emitCrossProcessChange(key: string): void {
    if (!KNOWN_SETTINGS[key]?.crossProcess && !key.startsWith('__integration-enabled:')) return
    notify(SETTING_CHANGED_CHANNEL, key).catch((err) => {
      log.error(`Failed to notify setting change for '${key}':`, err)
    })
  }

  /** Register a listener called when a setting changes. */
  onChange(listener: SettingChangeListener): () => void {
    this.changeListeners.push(listener)
    return () => {
      this.changeListeners = this.changeListeners.filter((registered) => registered !== listener)
    }
  }

  private async notifyListeners(key: string, value: string): Promise<void> {
    for (const listener of this.changeListeners) {
      try {
        await listener(key, value)
      } catch (err) {
        log.error(`Setting change listener failed for key '${key}':`, err)
      }
    }
  }

  /**
   * The raw STORED value, or `undefined` when nothing is stored — unlike
   * `get()`, which substitutes the `KNOWN_SETTINGS` default. Callers that
   * layer their own fallback (e.g. the concurrency cap falling through to an
   * env var) need to tell "operator set this" apart from "nobody set this".
   */
  getStoredValue(key: string): string | undefined {
    return this.cache.get(key)
  }

  /** Get a setting's raw string value (from cache, then default). */
  get(key: string): string {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const def = KNOWN_SETTINGS[key]
    return def?.default ?? ''
  }

  /** Get a setting value parsed to its declared type. */
  getTyped(key: string): boolean | string | number {
    const raw = this.get(key)
    const def = KNOWN_SETTINGS[key]
    if (!def) return raw

    switch (def.type) {
      case 'boolean':
        return raw === 'true'
      case 'number':
        return Number(raw)
      default:
        return raw
    }
  }

  /**
   * Set a setting value. Writes to DB, updates cache, notifies listeners.
   *
   * @throws {SettingValidationError} when the key declares a `validate` and
   * the value fails it. The DB write and the cache update are skipped
   * entirely, so a rejected write leaves the previous value in place.
   */
  async set(key: string, value: string, updatedBy = 'admin'): Promise<void> {
    const validationError = KNOWN_SETTINGS[key]?.validate?.(value)
    if (validationError) {
      throw new SettingValidationError(validationError, key)
    }

    await db
      .insert(settings)
      .values({
        key,
        value,
        updatedAt: new Date(),
        updatedBy,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value,
          updatedAt: new Date(),
          updatedBy,
        },
      })

    this.cache.set(key, value)
    log.info(`Setting '${key}' updated to '${value}' by ${updatedBy}`)
    await this.notifyListeners(key, value)
    this.emitCrossProcessChange(key)
  }

  /** Delete a setting (reverts to default). */
  async delete(key: string): Promise<void> {
    await db.delete(settings).where(eq(settings.key, key))
    this.cache.delete(key)
    const def = KNOWN_SETTINGS[key]
    const defaultValue = def?.default ?? ''
    log.info(`Setting '${key}' deleted (reverted to default: '${defaultValue}')`)
    await this.notifyListeners(key, defaultValue)
    this.emitCrossProcessChange(key)
  }

  /** List all known settings with metadata. */
  async list(): Promise<SettingMetadata[]> {
    const rows = await db
      .select({
        key: settings.key,
        value: settings.value,
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy,
      })
      .from(settings)

    const dbMap = new Map(rows.map((r) => [r.key, r]))

    return Object.entries(KNOWN_SETTINGS).map(([key, def]) => {
      const row = dbMap.get(key)
      return {
        key,
        value: row?.value ?? def.default,
        type: def.type,
        default: def.default,
        description: def.description,
        isDefault: !row,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      }
    })
  }

  /** Load all settings from DB into cache. */
  private async loadFromDb(): Promise<void> {
    const rows = await db.select().from(settings)
    this.cache.clear()
    for (const row of rows) {
      this.cache.set(row.key, row.value)
    }
  }
}

// --- Singleton ---

let _store: SettingsStore | null = null

export function getSettingsStore(): SettingsStore {
  if (!_store) {
    _store = new SettingsStore()
  }
  return _store
}

/** Reset the singleton (for testing only). */
export function resetSettingsStore(): void {
  if (_store) {
    _store.stopPeriodicRefresh()
    _store.stopCrossProcessInvalidation()
  }
  _store = null
}

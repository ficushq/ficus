import { migrateLinearWebhookSettings } from '../integrations/linear/webhook-settings'
import { migrateGitHubWebhookSettings, LEGACY_GITHUB_WEBHOOK_SECRET_KEY } from '../integrations/github/webhook-settings'
import { eq } from 'drizzle-orm'
import { db, secrets } from '../../db'
import { encrypt, decrypt, getEncryptionKey } from './crypto'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { notify, listen } from '../../lib/infra/local-events'
import { isManagedSecretKey, readManagedSecretValue } from './managed'

const log = createLogger('secret-store')

/**
 * local-events channel for cross-process cache invalidation. The payload is
 * the secret KEY only — never the value (it travels in the clear over the
 * authenticated HTTP transport, and the peer can read the value from the DB itself).
 */
export const SECRET_CHANGED_CHANNEL = 'secret_changed'

/**
 * Backstop refresh interval for the secret cache (api AND worker).
 *
 * 5 minutes, not 60s: every write NOTIFYs {@link SECRET_CHANGED_CHANNEL} after
 * commit and both processes subscribe (`startCrossProcessInvalidation`, wired
 * at index.ts's boot chain and worker.ts's startup), so a change is visible
 * cross-process in milliseconds. This timer only bounds how long a MISSED
 * notification can linger — it is not the propagation path — and at 60s it was
 * a full-table read plus an AES decrypt per key in two processes every minute.
 */
export const SECRET_STORE_REFRESH_INTERVAL_MS = 5 * 60_000

/** Known secret keys the application uses */
const KNOWN_KEYS = [
  // Authentication
  'FICUS_PASSWORD',
  // Shared secret authenticating the in-cluster sandbox watcher's core callbacks
  // (workspace-files), independent of the admin-gated legacy FICUS_PASSWORD.
  'SANDBOX_CALLBACK_SECRET',
  // Reviewer credential for the demo access page (FICUS_DEMO_REVIEWER_ACCESS); rotate to revoke.
  'DEMO_REVIEWER_SECRET',

  // Notifications
  'VAPID_SUBJECT',

  // AI Providers
  'OPENAI_API_KEY',

  // Git (sandbox)
  'GIT_USER_NAME',
  'GIT_USER_EMAIL',

  // Linear
  'LINEAR_API_KEY',
  'LINEAR_WEBHOOK_SECRET',
  'LINEAR_USER_ID',

  // Discord
  'DISCORD_APPLICATION_ID',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',

  // Slack
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',

  // Telegram
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_BOT_ID',

  // VAPID keys for push notifications (JSON blob)
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',

  // Apple Push Notification service (APNs) — native iOS push for the mobile app
  'APNS_KEY_P8',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',

  // Google Cloud (JSON service account key for TTS, etc.)
  'GOOGLE_SERVICE_ACCOUNT_JSON',

  // Deployment provider tokens (selectively exposed to squads via squad env secret refs)
  'DEPLOY_VERCEL_TOKEN',
  'DEPLOY_NETLIFY_TOKEN',
  'DEPLOY_CLOUDFLARE_TOKEN',
  'DEPLOY_RAILWAY_TOKEN',
  'DEPLOY_SUPABASE_TOKEN',
  'DEPLOY_DIGITALOCEAN_TOKEN',

  // Provider auth (JSON blob — managed via Provider Auth API, not directly)
  'PROVIDER_AUTH_DATA',
] as const

export type SecretKey = (typeof KNOWN_KEYS)[number]

/**
 * Stored under Secret Store for convenience, but not credentials: public
 * identifiers, public keys, and environment labels.
 *
 * These are excluded from the content-safety matcher. Their values legitimately
 * appear in ordinary agent output — a commit author, a `git config` result, a
 * bundle id — so matching them would replace correct text with a marker and
 * teach agents that their own tool output is unreliable. Excluding them costs
 * nothing: none of them grant access on their own.
 */
const NON_SECRET_KEYS = new Set<string>([
  'GITHUB_USER', // Historical public identifier; never treat a login as secret material.
  'GIT_USER_NAME',
  'GIT_USER_EMAIL',
  'VAPID_SUBJECT',
  'VAPID_PUBLIC_KEY',
  'DISCORD_APPLICATION_ID',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_GUILD_ID',
  'TELEGRAM_BOT_ID',
  'LINEAR_USER_ID',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',
])

/** Values shorter than this match ordinary prose too often to be worth matching. */
const MIN_MATCHABLE_SECRET_LENGTH = 12

/** Whether a stored value should ever be replaced in tool output. */
export function isMatchableSecret(key: string, value: string): boolean {
  return !NON_SECRET_KEYS.has(key) && value.length >= MIN_MATCHABLE_SECRET_LENGTH
}

// Tests may intentionally override known service keys, but must not ingest an
// unchanged credential inherited from the parent process. The APNs file path is
// a runtime-only managed input, not a Secret Store key shown in the admin UI.
const TEST_ENVIRONMENT_SERVICE_KEYS = new Set<string>([
  ...KNOWN_KEYS,
  'APNS_KEY_P8_FILE',
  LEGACY_GITHUB_WEBHOOK_SECRET_KEY,
])
const inheritedKnownTestValues = new Map<string, string | undefined>(
  [...TEST_ENVIRONMENT_SERVICE_KEYS].map((key) => [key, process.env[key]])
)

export interface SecretMetadata {
  key: string
  isSet: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

/**
 * SecretStore — manages application secrets encrypted in the database.
 *
 * Secrets are cached in memory for fast reads. The cache is refreshed
 * on writes and periodically (for multi-process setups like API + Worker).
 */
export type SecretChangeListener = (key: string, value: string | undefined) => void | Promise<void>
export type SecretStoreTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** @internal Raw values must remain inside an in-process content-safety matcher. */
export interface SecretValueConsumer {
  /** Atomically replace coverage; rotations may temporarily include two values for one key. */
  replace(entries: readonly { key: string; value: string }[]): void
  update(key: string, value: string | undefined): void
}

export interface GeneratedSecretEnvironmentFixture {
  readonly key: string
  readonly value: string
  revoke(): void
}

type GeneratedFixtureRecord = { key: string; value: string; active: boolean }
const generatedFixtureCapabilities = new WeakMap<object, GeneratedFixtureRecord>()

/** Create an opaque, process-local generated fixture. Callers cannot choose or forge its key/value. */
export function createGeneratedSecretEnvironmentFixture(): GeneratedSecretEnvironmentFixture {
  const nonce = crypto.randomUUID().replaceAll('-', '_')
  const key = `CANARY_KEY_${nonce}`
  const value = `CANARY_SECRET_${crypto.randomUUID()}_${crypto.randomUUID()}`
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    throw new Error('Generated secret fixture collided with parent environment')
  }
  const fixture = {
    key,
    value,
    revoke() {
      const record = generatedFixtureCapabilities.get(fixture)
      if (record) record.active = false
      delete process.env[key]
    },
  }
  generatedFixtureCapabilities.set(fixture, { key, value, active: true })
  process.env[key] = value
  return Object.freeze(fixture)
}

export interface SecretStoreOptions {
  testEnvironmentReadFixtures?: readonly GeneratedSecretEnvironmentFixture[]
  testEnvironmentMigrationFixtures?: readonly GeneratedSecretEnvironmentFixture[]
}

export class SecretStore {
  private cache = new Map<string, string>()
  private encryptionKey: Buffer | null = null
  private refreshRunner: PeriodicRunner | null = null
  private changeListeners: SecretChangeListener[] = []
  private contentSafetyConsumers = new Set<SecretValueConsumer>()
  private unlistenCrossProcess: (() => Promise<void>) | null = null
  private operationSequence = 0
  private latestAppliedFullRefresh = 0
  private latestAppliedKeyRefresh = new Map<string, number>()
  private latestAppliedKeyRefreshGlobal = 0
  private latestLocalMutation = 0
  private latestLocalKeyMutation = new Map<string, number>()
  private environmentFallbackBlockedKeys = new Set<string>()
  private environmentMatcherEntries = new Map<string, string>()
  private readonly testEnvironmentReadFixtures: ReadonlyMap<string, string>
  private readonly testEnvironmentMigrationKeys: readonly string[]

  constructor(options: SecretStoreOptions = {}) {
    const readFixtures = options.testEnvironmentReadFixtures ?? []
    const migrationFixtures = options.testEnvironmentMigrationFixtures ?? []
    const records = [...readFixtures, ...migrationFixtures].map((fixture) => {
      const record = generatedFixtureCapabilities.get(fixture)
      if (!record?.active || process.env[record.key] !== record.value) {
        throw new Error('Test secret environment access requires an active generated fixture capability')
      }
      return record
    })
    this.testEnvironmentMigrationKeys = migrationFixtures.map(
      (fixture) => generatedFixtureCapabilities.get(fixture)!.key
    )
    this.testEnvironmentReadFixtures = new Map(records.map((record) => [record.key, record.value]))
  }

  /**
   * Initialize the store: load encryption key, load secrets from DB,
   * migrate any secrets from process.env.
   */
  async initialize(): Promise<void> {
    try {
      this.encryptionKey = getEncryptionKey()
    } catch {
      log.warn('FICUS_ENCRYPTION_KEY not set — secret store running in read-only env-fallback mode')
      return
    }

    await this.loadFromDb()
    await this.migrateFromEnv()
    await migrateGitHubWebhookSettings(this)
    await migrateLinearWebhookSettings(this)
    log.info(`SecretStore initialized (${this.cache.size} secrets loaded)`)
  }

  /**
   * Start periodic cache refresh from authoritative DB state (API and worker).
   * @param intervalMs Refresh interval in milliseconds (default: {@link SECRET_STORE_REFRESH_INTERVAL_MS})
   */
  startPeriodicRefresh(intervalMs = SECRET_STORE_REFRESH_INTERVAL_MS): void {
    this.stopPeriodicRefresh()
    this.refreshRunner = createPeriodicRunner({
      name: 'secret-store-refresh',
      intervalMs,
      runImmediately: false,
      task: () => this.loadFromDb(),
    })
    this.refreshRunner.start()
  }

  /**
   * Register a listener called when a secret is set or deleted.
   * Receives the key and the new value (undefined if deleted).
   * Returns an unsubscribe function.
   */
  onChange(listener: SecretChangeListener): () => void {
    this.changeListeners.push(listener)
    return () => {
      const index = this.changeListeners.indexOf(listener)
      if (index !== -1) this.changeListeners.splice(index, 1)
    }
  }

  /**
   * Binds the process-local content-safety matcher to the current cache and
   * subsequent changes. This is deliberately push-only: callers cannot obtain
   * a snapshot or serialize a raw value through the return type.
   *
   * @internal Only ContentSafetyRegistry may consume this boundary.
   */
  bindContentSafetyConsumer(consumer: SecretValueConsumer): () => void {
    const entries = this.matcherEntriesForCache(this.cache)
    consumer.replace(Array.from(entries, ([key, value]) => ({ key, value })))
    this.contentSafetyConsumers.add(consumer)
    return () => this.contentSafetyConsumers.delete(consumer)
  }

  private matcherEntriesForCache(cache: ReadonlyMap<string, string>): Map<string, string> {
    const entries = new Map(cache)
    for (const [key, value] of this.testEnvironmentReadFixtures) {
      if (!entries.has(key)) entries.set(key, value)
    }
    for (const [key, value] of this.environmentMatcherEntries) {
      if (!entries.has(key)) entries.set(key, value)
    }
    if (!this.isTestProcess()) {
      for (const key of KNOWN_KEYS) {
        if (entries.has(key) && !isManagedSecretKey(key)) continue
        const value = isManagedSecretKey(key) ? readManagedSecretValue(key) : this.readEnvironmentKey(key)
        if (value !== undefined) entries.set(key, value)
      }
    }
    // Public identifiers and very short values are dropped here, at the single
    // point that decides what the matcher can ever replace.
    for (const [key, value] of entries) {
      if (!isMatchableSecret(key, value)) entries.delete(key)
    }
    return entries
  }

  /** Publish cache and matcher through a conservative union generation so neither side can expose an unmatched value. */
  private publishCache(nextCache: Map<string, string>): void {
    const previousCache = this.cache
    const previousMatcher = this.matcherEntriesForCache(previousCache)
    const nextMatcher = this.matcherEntriesForCache(nextCache)
    const asEntries = (entries: ReadonlyMap<string, string>) => Array.from(entries, ([key, value]) => ({ key, value }))
    const previousEntries = asEntries(previousMatcher)
    const nextEntries = asEntries(nextMatcher)
    // A rotation has two values for the same key. Retain both until cache
    // publication crosses the boundary; a Map keyed only by name would drop
    // the old value too early.
    const unionEntries = [
      ...previousEntries,
      ...nextEntries.filter(
        (candidate) => !previousEntries.some((entry) => entry.key === candidate.key && entry.value === candidate.value)
      ),
    ]

    try {
      for (const consumer of this.contentSafetyConsumers) consumer.replace(unionEntries)
    } catch (error) {
      for (const consumer of this.contentSafetyConsumers) {
        try {
          consumer.replace(previousEntries)
        } catch {
          // Cache is still the previous generation; an atomic consumer keeps either previous or union coverage.
        }
      }
      throw error
    }

    this.cache = nextCache
    try {
      for (const consumer of this.contentSafetyConsumers) consumer.replace(nextEntries)
      for (const key of new Set([...previousMatcher.keys(), ...nextMatcher.keys()])) {
        this.environmentFallbackBlockedKeys.delete(key)
      }
    } catch (error) {
      // If a consumer failed on either side of its atomic replace, only values
      // common to both generations are proven matched everywhere.
      const changedKeys = new Set([...previousCache.keys(), ...nextCache.keys()])
      for (const key of changedKeys) {
        if (previousCache.get(key) !== nextCache.get(key)) this.environmentFallbackBlockedKeys.add(key)
      }
      const safeCache = new Map([...previousCache].filter(([key, value]) => nextCache.get(key) === value))
      this.cache = safeCache
      const safeMatcher = this.matcherEntriesForCache(safeCache)
      for (const consumer of this.contentSafetyConsumers) {
        try {
          consumer.replace(asEntries(safeMatcher))
        } catch {
          // Every possible prior matcher generation covers the retained intersection.
        }
      }
      throw error
    }
  }

  private async notifyListeners(key: string, value: string | undefined): Promise<void> {
    for (const listener of this.changeListeners) {
      try {
        await listener(key, value)
      } catch (err) {
        log.error(`Secret change listener failed for key '${key}':`, err)
      }
    }
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
   * Subscribe to cross-process secret-change notifications (local-events).
   *
   * Every write (set/delete/mutateSecret) notifies the changed KEY after
   * commit; on receipt we re-load that single key from the DB into the cache.
   * Both processes also refresh from the DB every
   * {@link SECRET_STORE_REFRESH_INTERVAL_MS}; this immediate key invalidation
   * is the fast path that shrinks the polling staleness window.
   * Self-originated notifications are harmless: the local cache was already
   * updated on write, so refreshKey sees no change and skips listeners.
   */
  async startCrossProcessInvalidation(): Promise<void> {
    if (!this.encryptionKey) return // env-only mode — nothing to invalidate
    if (this.unlistenCrossProcess) return

    this.unlistenCrossProcess = await listen(SECRET_CHANGED_CHANNEL, (key) => {
      this.refreshKey(key).catch((err) => {
        log.error(`Failed to refresh secret '${key}' after change notification:`, err)
      })
    })
    log.info('Secret store listening for cross-process changes')
  }

  stopCrossProcessInvalidation(): void {
    if (this.unlistenCrossProcess) {
      // Best-effort teardown, mirroring stopPeriodicRefresh's sync API.
      void this.unlistenCrossProcess().catch(() => {})
      this.unlistenCrossProcess = null
    }
  }

  private markLocalCacheMutation(key: string): void {
    const operation = ++this.operationSequence
    this.latestLocalMutation = operation
    this.latestLocalKeyMutation.set(key, operation)
  }

  private markKeyRefreshApplied(key: string, request: number): void {
    this.latestAppliedKeyRefresh.set(key, request)
    this.latestAppliedKeyRefreshGlobal = Math.max(this.latestAppliedKeyRefreshGlobal, request)
  }

  protected async selectRow(key: string): Promise<typeof secrets.$inferSelect | undefined> {
    const [row] = await db.select().from(secrets).where(eq(secrets.key, key))
    return row
  }

  /**
   * Re-load a single key from the DB into the cache, firing change listeners
   * if the value actually changed. Used by cross-process invalidation; safe to
   * call for self-originated writes (no-op — cache already holds the value).
   */
  async refreshKey(key: string): Promise<void> {
    if (!this.encryptionKey) return

    const request = ++this.operationSequence
    const row = await this.selectRow(key)

    // Only successfully applied newer results or a newer local mutation may
    // supersede this request. A newer request that failed must not suppress a
    // valid immediate invalidation result.
    if (
      (this.latestAppliedKeyRefresh.get(key) ?? 0) > request ||
      this.latestAppliedFullRefresh > request ||
      (this.latestLocalKeyMutation.get(key) ?? 0) > request
    ) {
      return
    }

    if (!row) {
      this.markKeyRefreshApplied(key, request)
      if (this.cache.has(key)) {
        const nextCache = new Map(this.cache)
        nextCache.delete(key)
        this.publishCache(nextCache)
        await this.notifyListeners(key, undefined)
      }
      return
    }

    let value: string
    try {
      value = decrypt(row.encryptedValue, row.iv, this.encryptionKey)
    } catch (err) {
      // Keep the last-known-good cached value rather than dropping it.
      log.error(`Failed to decrypt secret '${key}' during refresh — keeping cached value`, err)
      return
    }

    this.markKeyRefreshApplied(key, request)
    if (this.cache.get(key) === value) return
    const nextCache = new Map(this.cache)
    nextCache.set(key, value)
    this.publishCache(nextCache)
    await this.notifyListeners(key, value)
  }

  /**
   * Get a secret value. Returns undefined if not set.
   * Checks DB cache first, then falls back to process.env.
   * This ensures env vars always work as a last resort (important for tests
   * and gradual migration).
   */
  private readEnvironmentWithMatcher(key: string, value: string | undefined): string | undefined {
    if (value === undefined || this.environmentFallbackBlockedKeys.has(key)) return undefined
    try {
      for (const consumer of this.contentSafetyConsumers) consumer.update(key, value)
      this.environmentMatcherEntries.set(key, value)
      return value
    } catch {
      this.environmentFallbackBlockedKeys.add(key)
      return undefined
    }
  }

  get(key: string): string | undefined {
    // Platform-managed keys live ONLY in process.env (delivered via
    // managed.env). They are deliberately never ingested into the store, so
    // core services read them straight from env — and a stale DB row (e.g. a
    // self-host that later became platform-managed) must never shadow the
    // platform-delivered value. The value never becomes a store ENTRY.
    //
    // Read through readManagedSecretValue rather than process.env[key]: a few
    // managed credentials cannot be delivered under their own store key
    // (systemd EnvironmentFile names cannot contain a hyphen) or in their own
    // shape (its values cannot span lines), so the mapping from store key to
    // env name + encoding lives in one place. See managed.ts.
    if (isManagedSecretKey(key)) {
      return this.readEnvironmentWithMatcher(
        key,
        this.canReadEnvironmentKey(key) ? readManagedSecretValue(key) : undefined
      )
    }
    if (!this.encryptionKey) {
      // No encryption key — env-only mode
      return this.readEnvironmentWithMatcher(key, this.readEnvironmentKey(key))
    }
    // DB cache first, then an atomically matcher-published env fallback.
    return this.cache.get(key) ?? this.readEnvironmentWithMatcher(key, this.readEnvironmentKey(key))
  }

  /**
   * Set a secret value. Encrypts and writes to DB, updates cache.
   */
  async set(key: string, value: string, updatedBy = 'admin'): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Cannot set secrets: FICUS_ENCRYPTION_KEY not configured')
    }

    const { encrypted, iv } = encrypt(value, this.encryptionKey)

    await db
      .insert(secrets)
      .values({
        key,
        encryptedValue: encrypted,
        iv,
        updatedAt: new Date(),
        updatedBy,
      })
      .onConflictDoUpdate({
        target: secrets.key,
        set: {
          encryptedValue: encrypted,
          iv,
          updatedAt: new Date(),
          updatedBy,
        },
      })

    const nextCache = new Map(this.cache)
    nextCache.set(key, value)
    this.publishCache(nextCache)
    this.markLocalCacheMutation(key)
    log.info(`Secret '${key}' updated by ${updatedBy}`)
    await this.notifyListeners(key, value)
    this.emitCrossProcessChange(key)
  }

  /**
   * Persist a secret and its durable ownership obligation in one transaction.
   * Cache publication occurs only after both mutations commit.
   */
  async setWithDurableObligation<T>(
    key: string,
    value: string,
    updatedBy: string,
    obligation: (tx: SecretStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (!this.encryptionKey) {
      throw new Error('Cannot set secrets: FICUS_ENCRYPTION_KEY not configured')
    }
    const { encrypted, iv } = encrypt(value, this.encryptionKey)
    const result = await db.transaction(async (tx) => {
      await tx
        .insert(secrets)
        .values({ key, encryptedValue: encrypted, iv, updatedAt: new Date(), updatedBy })
        .onConflictDoUpdate({
          target: secrets.key,
          set: { encryptedValue: encrypted, iv, updatedAt: new Date(), updatedBy },
        })
      return obligation(tx)
    })

    const nextCache = new Map(this.cache)
    nextCache.set(key, value)
    this.publishCache(nextCache)
    this.markLocalCacheMutation(key)
    log.info(`Secret '${key}' updated by ${updatedBy}`)
    await this.notifyListeners(key, value)
    this.emitCrossProcessChange(key)
    return result
  }

  /**
   * Apply a durable mutation and delete its secret in one transaction.
   * The mutation must verify ownership before allowing deletion.
   */
  async deleteWithDurableMutation<T>(
    key: string,
    mutationBeforeDelete: (tx: SecretStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (!this.encryptionKey) {
      throw new Error('Cannot delete secrets: FICUS_ENCRYPTION_KEY not configured')
    }
    const result = await db.transaction(async (tx) => {
      const mutation = await mutationBeforeDelete(tx)
      await tx.delete(secrets).where(eq(secrets.key, key))
      return mutation
    })

    const nextCache = new Map(this.cache)
    nextCache.delete(key)
    this.publishCache(nextCache)
    this.markLocalCacheMutation(key)
    log.info(`Secret '${key}' deleted`)
    await this.notifyListeners(key, undefined)
    this.emitCrossProcessChange(key)
    return result
  }

  /**
   * Transactional read-modify-write of a single secret.
   *
   * Unlike `get()`-then-`set()` (which bases the mutation on a process-local
   * cache that can be up to 60 seconds stale after a missed event), this locks
   * the row with SELECT ... FOR UPDATE, decrypts the FRESH DB value, applies
   * `mutate`, and writes back inside the same transaction. Concurrent mutates
   * from other processes serialize on the row lock, so no update is lost.
   *
   * - `mutate` receives the current plaintext (undefined if the key is unset)
   *   and returns the new plaintext, or `undefined` to skip the write (the
   *   lock is released without writing).
   * - `mutate` runs inside the DB transaction — it must be synchronous and
   *   fast. If it throws, the transaction rolls back untouched.
   * - If the existing row fails to decrypt, the mutation REJECTS and the row
   *   is left untouched — never overwrite a value we cannot read.
   */
  async mutateSecret(
    key: string,
    mutate: (current: string | undefined) => string | undefined,
    updatedBy = 'admin'
  ): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Cannot mutate secrets: FICUS_ENCRYPTION_KEY not configured')
    }
    const encryptionKey = this.encryptionKey

    const runOnce = (): Promise<{ wrote: boolean; value?: string }> =>
      db.transaction(async (tx) => {
        const [row] = await tx.select().from(secrets).where(eq(secrets.key, key)).for('update')

        // Throws on decrypt failure → transaction aborts, row untouched.
        const current = row ? decrypt(row.encryptedValue, row.iv, encryptionKey) : undefined

        const next = mutate(current)
        if (next === undefined) return { wrote: false }

        const { encrypted, iv } = encrypt(next, encryptionKey)
        if (row) {
          await tx
            .update(secrets)
            .set({ encryptedValue: encrypted, iv, updatedAt: new Date(), updatedBy })
            .where(eq(secrets.key, key))
        } else {
          await tx.insert(secrets).values({ key, encryptedValue: encrypted, iv, updatedAt: new Date(), updatedBy })
        }
        return { wrote: true, value: next }
      })

    let result: { wrote: boolean; value?: string }
    try {
      result = await runOnce()
    } catch (err) {
      // First-ever write racing another process's first write: neither saw a
      // row to lock, both INSERTed, one hit the unique(key) constraint. The
      // row exists now — retry once through the FOR UPDATE path so the retry
      // bases its mutation on the winner's value instead of losing it.
      if (!isUniqueViolation(err)) throw err
      result = await runOnce()
    }

    if (!result.wrote) return
    const nextCache = new Map(this.cache)
    nextCache.set(key, result.value!)
    this.publishCache(nextCache)
    this.markLocalCacheMutation(key)
    log.info(`Secret '${key}' mutated by ${updatedBy}`)
    await this.notifyListeners(key, result.value!)
    this.emitCrossProcessChange(key)
  }

  /**
   * Delete a secret from DB and cache.
   */
  async delete(key: string): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Cannot delete secrets: FICUS_ENCRYPTION_KEY not configured')
    }

    await this.deleteWithDurableMutation(key, async () => undefined)
  }

  /**
   * Broadcast a secret change to other processes (fire-and-forget — a missed
   * notification degrades to both processes' 60-second periodic-refresh
   * fallback, and the write itself already committed).
   */
  private emitCrossProcessChange(key: string): void {
    notify(SECRET_CHANGED_CHANNEL, key).catch((err) => {
      log.error(`Failed to notify secret change for '${key}':`, err)
    })
  }

  /**
   * List all known secrets with metadata (no values).
   */
  async list(): Promise<SecretMetadata[]> {
    const rows = await db
      .select({
        key: secrets.key,
        updatedAt: secrets.updatedAt,
        updatedBy: secrets.updatedBy,
      })
      .from(secrets)

    const dbMap = new Map(rows.map((r) => [r.key, r]))

    // Platform-managed keys are invisible to the tenant: never listed (nor
    // therefore readable/exportable through the UI). Their value lives only in
    // process.env; excluding them here means they never surface as store entries.
    const known = KNOWN_KEYS.filter((key) => !isManagedSecretKey(key)).map((key) => {
      const row = dbMap.get(key)
      return {
        key,
        isSet: !!row,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      }
    })

    const knownSet = new Set<string>(KNOWN_KEYS)
    const dynamic = rows
      // `__`-prefixed keys are internal (e.g. the auto-provisioned webhook system token) — not listed.
      // Managed keys are excluded even if a stale row exists (see above).
      .filter((row) => !knownSet.has(row.key) && !row.key.startsWith('__') && !isManagedSecretKey(row.key))
      .map((row) => ({
        key: row.key,
        isSet: true,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      }))
      .sort((a, b) => a.key.localeCompare(b.key))

    return [...known, ...dynamic]
  }

  /**
   * Load all secrets from DB into cache.
   */
  protected selectAllRows(): Promise<(typeof secrets.$inferSelect)[]> {
    return db.select().from(secrets)
  }

  protected async loadFromDb(): Promise<void> {
    if (!this.encryptionKey) return

    const request = ++this.operationSequence
    const rows = await this.selectAllRows()

    // Only successfully applied newer refreshes or a newer local mutation may
    // supersede this snapshot. Merely starting a request that later fails must
    // not suppress a valid result.
    if (
      this.latestAppliedFullRefresh > request ||
      this.latestAppliedKeyRefreshGlobal > request ||
      this.latestLocalMutation > request
    ) {
      return
    }

    const nextCache = new Map<string, string>()
    for (const row of rows) {
      try {
        const value = decrypt(row.encryptedValue, row.iv, this.encryptionKey)
        nextCache.set(row.key, value)
      } catch (err) {
        log.error(`Failed to decrypt secret '${row.key}' — skipping`, err)
      }
    }
    this.publishCache(nextCache)
    this.latestAppliedFullRefresh = request
  }

  /**
   * Migrate secrets from process.env into DB.
   *
   * - If a key is missing from DB but set in env → insert with updatedBy='env'
   * - If a key exists in DB with updatedBy='env' and env has a different value → update it
   * - If a key exists in DB with updatedBy!='env' (set by admin) → never overwrite
   *
   * This allows env vars to seed initial values and stay in sync,
   * while admin-set values always take precedence.
   */
  private async migrateFromEnv(): Promise<void> {
    // Load updatedBy metadata for existing secrets
    const rows = await db.select({ key: secrets.key, updatedBy: secrets.updatedBy }).from(secrets)
    const dbMeta = new Map(rows.map((r) => [r.key, r.updatedBy]))

    const keys = this.isTestProcess() ? this.testEnvironmentMigrationKeys : KNOWN_KEYS
    let migrated = 0
    for (const key of keys) {
      // Platform-managed keys are delivered via env but MUST NOT be ingested
      // into the store: no DB entry means nothing to list, read, or export. Core
      // services still read the value straight from process.env via get().
      if (isManagedSecretKey(key)) continue

      const envValue = this.readEnvironmentKey(key)
      if (!envValue) continue

      const existingUpdatedBy = dbMeta.get(key)

      if (!existingUpdatedBy) {
        // Not in DB — seed from env
        await this.set(key, envValue, 'env')
        migrated++
      } else if (existingUpdatedBy === 'env' && this.cache.get(key) !== envValue) {
        // In DB but was set by env and value changed — update
        await this.set(key, envValue, 'env')
        migrated++
      }
      // If updatedBy is anything other than 'env' (e.g., 'admin'), don't touch it
    }
    if (migrated > 0) {
      log.info(`Migrated ${migrated} secret(s) from environment variables`)
    }
  }

  private isTestProcess(): boolean {
    return process.env.FICUS_TEST_MODE === '1'
  }

  private canReadEnvironmentKey(key: string): boolean {
    if (!this.isTestProcess()) return true
    const expected = this.testEnvironmentReadFixtures.get(key)
    if (expected !== undefined) return process.env[key] === expected
    // Normal tests explicitly override the application's known environment
    // keys. Unchanged inherited values and dynamic keys remain capability-gated.
    if (!TEST_ENVIRONMENT_SERVICE_KEYS.has(key)) return false
    if (isManagedSecretKey(key)) return true
    return process.env[key] !== inheritedKnownTestValues.get(key)
  }

  private readEnvironmentKey(key: string): string | undefined {
    if (this.environmentFallbackBlockedKeys.has(key)) return undefined
    return this.canReadEnvironmentKey(key) ? process.env[key] : undefined
  }
}

/** Postgres unique-constraint violation (SQLSTATE 23505), possibly wrapped. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true
  }
  return false
}

// Singleton instance
let _store: SecretStore | null = null

export function getSecretStore(): SecretStore {
  if (!_store) {
    _store = new SecretStore()
  }
  return _store
}

/** Reset the singleton (for testing only) */
export function resetSecretStore(): void {
  if (_store) {
    _store.stopPeriodicRefresh()
    _store.stopCrossProcessInvalidation()
  }
  _store = null
}

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes, randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, integrationCredentialCleanupJobs, integrationRevocationJobs, secrets } from '../../db'
import {
  createGeneratedSecretEnvironmentFixture,
  isMatchableSecret,
  SecretStore,
  SECRET_CHANGED_CHANNEL,
} from './store'
import { listPeriodicRunnerNames, listPeriodicRunners } from '../../lib/infra/PeriodicRunner'
import { listen } from '../../lib/infra/local-events'
import { ContentSafetyRegistry } from '../security/content-safety-registry'

function makeStore(options?: ConstructorParameters<typeof SecretStore>[0]): SecretStore {
  const store = new SecretStore(options)
  store.bindContentSafetyConsumer({ replace: () => undefined, update: () => undefined })
  return store
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('SecretStore', () => {
  const testKey = randomBytes(32).toString('hex')
  let store: SecretStore
  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    store = makeStore()
    await store.initialize()
  })

  afterEach(() => {
    store.stopPeriodicRefresh()
    process.env.FICUS_ENCRYPTION_KEY = testKey
  })

  test('set and get a secret', async () => {
    await store.set('OPENAI_API_KEY', 'sk-test-123')
    expect(store.get('OPENAI_API_KEY')).toBe('sk-test-123')
  })

  test('get falls back only to an explicit generated environment fixture', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    const { key: envKey, value: envValue } = fixture
    let freshStore: SecretStore | undefined

    try {
      freshStore = makeStore({ testEnvironmentReadFixtures: [fixture] })
      await freshStore.initialize()
      let matcherEntries: readonly { key: string; value: string }[] = []
      freshStore.bindContentSafetyConsumer({
        replace: (entries) => {
          matcherEntries = entries
        },
        update: () => undefined,
      })
      const initialRows = await db.select().from(secrets).where(eq(secrets.key, envKey))
      expect(initialRows).toHaveLength(0)
      expect(freshStore.get(envKey)).toBe(envValue)
      expect(matcherEntries).toContainEqual({ key: envKey, value: envValue })

      await freshStore.set(envKey, `CANARY_SECRET_${randomUUID()}`)
      expect(freshStore.get(envKey)).not.toBe(envValue)

      await freshStore.delete(envKey)
      expect(freshStore.get(envKey)).toBe(envValue)
    } finally {
      freshStore?.stopPeriodicRefresh()
      fixture.revoke()
    }
  })

  test('get returns undefined for unset key', () => {
    expect(store.get('OPENAI_API_KEY')).toBeUndefined()
  })

  test('set overwrites existing secret', async () => {
    await store.set('OPENAI_API_KEY', 'old-value')
    await store.set('OPENAI_API_KEY', 'new-value')
    expect(store.get('OPENAI_API_KEY')).toBe('new-value')
  })

  test('delete removes a secret', async () => {
    await store.set('OPENAI_API_KEY', 'sk-test-123')
    await store.delete('OPENAI_API_KEY')
    expect(store.get('OPENAI_API_KEY')).toBeUndefined()
  })

  test('setWithDurableObligation commits the secret and obligation atomically', async () => {
    const credentialRef = `__integration-credential:test:${randomUUID()}`
    await expect(
      store.setWithDurableObligation(credentialRef, 'secret-value', 'test', async (tx) => {
        await tx.insert(integrationRevocationJobs).values({
          providerKey: 'notion',
          adapterVersion: 1,
          clientAuthority: 'local',
          credentialRef,
        })
        throw new Error('obligation failed')
      })
    ).rejects.toThrow('obligation failed')
    expect(await db.select().from(secrets).where(eq(secrets.key, credentialRef))).toHaveLength(0)
    expect(
      await db
        .select()
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    ).toHaveLength(0)

    const result = await store.setWithDurableObligation(credentialRef, 'secret-value', 'test', async (tx) => {
      const [job] = await tx
        .insert(integrationRevocationJobs)
        .values({ providerKey: 'notion', adapterVersion: 1, clientAuthority: 'local', credentialRef })
        .returning({ id: integrationRevocationJobs.id })
      return job!.id
    })
    expect(result).toBeString()
    expect(store.get(credentialRef)).toBe('secret-value')
    expect(
      await db
        .select()
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    ).toHaveLength(1)
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    await store.delete(credentialRef)
  })

  test('deleteWithDurableMutation rolls back the mutation and deletion together', async () => {
    const credentialRef = `__integration-credential:test:${randomUUID()}`
    await store.set(credentialRef, 'secret-value')
    const [job] = await db
      .insert(integrationCredentialCleanupJobs)
      .values({ credentialRef, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .returning()

    await expect(
      store.deleteWithDurableMutation(credentialRef, async (tx) => {
        await tx.delete(integrationCredentialCleanupJobs).where(eq(integrationCredentialCleanupJobs.id, job!.id))
        throw new Error('mutation failed')
      })
    ).rejects.toThrow('mutation failed')
    expect(await db.select().from(secrets).where(eq(secrets.key, credentialRef))).toHaveLength(1)
    expect(
      await db.select().from(integrationCredentialCleanupJobs).where(eq(integrationCredentialCleanupJobs.id, job!.id))
    ).toHaveLength(1)

    await store.deleteWithDurableMutation(credentialRef, async (tx) => {
      await tx.delete(integrationCredentialCleanupJobs).where(eq(integrationCredentialCleanupJobs.id, job!.id))
    })
    expect(store.get(credentialRef)).toBeUndefined()
    expect(
      await db.select().from(integrationCredentialCleanupJobs).where(eq(integrationCredentialCleanupJobs.id, job!.id))
    ).toHaveLength(0)
  })

  test('publishes both old and new values to the matcher before rotating cache visibility', async () => {
    const key = `GENERATED_KEY_${randomUUID()}`
    const previous = `CANARY_SECRET_${randomUUID()}`
    const next = `CANARY_SECRET_${randomUUID()}`
    await store.set(key, previous)
    const generations: Array<Array<{ key: string; value: string }>> = []
    store.bindContentSafetyConsumer({
      replace: (entries) => generations.push([...entries]),
      update: () => undefined,
    })

    await store.set(key, next)

    expect(generations[1].filter((entry) => entry.key === key).map((entry) => entry.value)).toEqual([previous, next])
    expect(store.get(key)).toBe(next)
  })

  test('fails closed to the cache/matcher intersection when matcher publication fails', async () => {
    const key = `GENERATED_KEY_${randomUUID()}`
    const value = `CANARY_SECRET_${randomUUID()}`
    const firstMatcher = new Map<string, string>()
    let failingReplacements = 0
    store.bindContentSafetyConsumer({
      replace: (entries) => {
        firstMatcher.clear()
        for (const entry of entries) firstMatcher.set(entry.key, entry.value)
      },
      update: () => undefined,
    })
    store.bindContentSafetyConsumer({
      replace: () => {
        failingReplacements += 1
        if (failingReplacements === 3) throw new Error('generated matcher publication failure')
      },
      update: () => undefined,
    })

    await expect(store.set(key, value)).rejects.toThrow('generated matcher publication failure')

    expect(store.get(key)).toBeUndefined()
    expect(firstMatcher.has(key)).toBe(false)
  })

  test('list returns all known keys with status', async () => {
    await store.set('OPENAI_API_KEY', 'sk-test')
    const list = await store.list()

    const openai = list.find((s) => s.key === 'OPENAI_API_KEY')
    expect(openai).toBeDefined()
    expect(openai!.isSet).toBe(true)
    expect(openai!.updatedAt).toBeInstanceOf(Date)
  })

  test('list includes dynamic secret keys without values', async () => {
    await store.set('GITHUB_TOKEN_CUSTOM', 'ghp_dynamic')
    const list = await store.list()

    const dynamic = list.find((s) => s.key === 'GITHUB_TOKEN_CUSTOM')
    expect(dynamic).toEqual({
      key: 'GITHUB_TOKEN_CUSTOM',
      isSet: true,
      updatedAt: expect.any(Date),
      updatedBy: 'admin',
    })
    expect(JSON.stringify(dynamic)).not.toContain('ghp_dynamic')
  })

  test('secrets persist across store instances', async () => {
    await store.set('GITHUB_TOKEN', 'ghp_abc123')

    // New store loads from DB
    const store2 = makeStore()
    await store2.initialize()
    expect(store2.get('GITHUB_TOKEN')).toBe('ghp_abc123')
    store2.stopPeriodicRefresh()
  })

  test('migrateFromEnv seeds from an explicit generated environment fixture', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    const { key: envKey, value: envValue } = fixture
    const freshStore = makeStore({ testEnvironmentMigrationFixtures: [fixture] })
    await freshStore.initialize()

    expect(freshStore.get(envKey)).toBe(envValue)
    const migrated = (await freshStore.list()).find((secret) => secret.key === envKey)
    expect(migrated!.isSet).toBe(true)
    expect(migrated!.updatedBy).toBe('env')

    freshStore.stopPeriodicRefresh()
    fixture.revoke()
  })

  test('migrateFromEnv does not overwrite existing DB values', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    const envKey = fixture.key
    const storedValue = `CANARY_SECRET_${randomUUID()}`
    await store.set(envKey, storedValue)

    const freshStore = makeStore({ testEnvironmentMigrationFixtures: [fixture] })
    await freshStore.initialize()

    expect(freshStore.get(envKey)).toBe(storedValue)
    freshStore.stopPeriodicRefresh()
    fixture.revoke()
  })

  test('rejects a modified generated fixture value', () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    process.env[fixture.key] = `CANARY_SECRET_${randomUUID()}`
    try {
      expect(() => makeStore({ testEnvironmentMigrationFixtures: [fixture] })).toThrow(
        'active generated fixture capability'
      )
    } finally {
      fixture.revoke()
    }
  })

  test('migrateFromEnv does not overwrite admin-set values even if env differs', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    const envKey = fixture.key
    const adminValue = `CANARY_SECRET_${randomUUID()}`
    await store.set(envKey, adminValue, 'admin')
    const freshStore = makeStore({ testEnvironmentMigrationFixtures: [fixture] })
    await freshStore.initialize()

    expect(freshStore.get(envKey)).toBe(adminValue)
    freshStore.stopPeriodicRefresh()
    fixture.revoke()
  })

  test('fallback mode reads only an explicit generated environment fixture', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    const { key: envKey, value: envValue } = fixture
    delete process.env.FICUS_ENCRYPTION_KEY

    const fallbackStore = makeStore({ testEnvironmentReadFixtures: [fixture] })
    await fallbackStore.initialize()
    // Secret availability is independent of whether a process matcher is
    // currently subscribed; a later subscriber receives the cached entry.
    expect(fallbackStore.get(envKey)).toBe(envValue)
    let matcherEntries: readonly { key: string; value: string }[] = []
    fallbackStore.bindContentSafetyConsumer({
      replace: (entries) => {
        matcherEntries = entries
      },
      update: () => undefined,
    })

    expect(fallbackStore.get(envKey)).toBe(envValue)
    expect(matcherEntries).toContainEqual({ key: envKey, value: envValue })
    let lateMatcherEntries: readonly { key: string; value: string }[] = []
    fallbackStore.bindContentSafetyConsumer({
      replace: (entries) => {
        lateMatcherEntries = entries
      },
      update: () => undefined,
    })
    expect(lateMatcherEntries).toContainEqual({ key: envKey, value: envValue })
    expect(fallbackStore.set(envKey, `CANARY_SECRET_${randomUUID()}`)).rejects.toThrow(
      'FICUS_ENCRYPTION_KEY not configured'
    )

    fallbackStore.stopPeriodicRefresh()
    fixture.revoke()
  })

  test('full refresh replaces the live matcher after a missed change event', async () => {
    class RefreshableStore extends SecretStore {
      refreshAll(): Promise<void> {
        return this.loadFromDb()
      }
    }
    const key = `CANARY_KEY_${randomUUID().replaceAll('-', '_')}`
    const first = `CANARY_SECRET_${randomUUID()}`
    const second = `CANARY_SECRET_${randomUUID()}`
    const refreshable = new RefreshableStore()
    await refreshable.initialize()
    await refreshable.set(key, first)
    const registry = new ContentSafetyRegistry(refreshable)
    const other = makeStore()
    await other.initialize()
    await other.set(key, second)
    const notifications: Array<[string, string | undefined]> = []
    refreshable.onChange((changedKey, value) => {
      notifications.push([changedKey, value])
    })

    await refreshable.refreshAll()

    expect(notifications).toEqual([])
    expect(registry.redact(first)).toBe(first)
    expect(registry.redact(second)).toBe(`[REDACTED_SECRET_ENV:${key}]`)
    registry.dispose()
  })

  describe('mutateSecret', () => {
    test('bases the mutation on the fresh DB value, not the stale local cache', async () => {
      await store.set('GITHUB_TOKEN', 'local-stale')

      // Another process writes a newer value; `store`'s cache does not see it.
      const other = makeStore()
      await other.initialize()
      await other.set('GITHUB_TOKEN', 'other-process-value')
      expect(store.get('GITHUB_TOKEN')).toBe('local-stale')

      const seen: (string | undefined)[] = []
      await store.mutateSecret('GITHUB_TOKEN', (current) => {
        seen.push(current)
        return `${current}+mutated`
      })

      expect(seen).toEqual(['other-process-value'])
      expect(store.get('GITHUB_TOKEN')).toBe('other-process-value+mutated')

      // Final DB state (via a fresh instance) reflects the merged write.
      const fresh = makeStore()
      await fresh.initialize()
      expect(fresh.get('GITHUB_TOKEN')).toBe('other-process-value+mutated')
    })

    test('concurrent mutates from two instances both land (no lost update)', async () => {
      await store.set('GITHUB_TOKEN', JSON.stringify({ items: [] as string[] }))

      const a = makeStore()
      const b = makeStore()
      await a.initialize()
      await b.initialize()

      const push = (item: string) => (current: string | undefined) => {
        const parsed = JSON.parse(current!) as { items: string[] }
        parsed.items.push(item)
        return JSON.stringify(parsed)
      }
      await Promise.all([
        a.mutateSecret('GITHUB_TOKEN', push('from-a')),
        b.mutateSecret('GITHUB_TOKEN', push('from-b')),
      ])

      const fresh = makeStore()
      await fresh.initialize()
      const final = JSON.parse(fresh.get('GITHUB_TOKEN')!) as { items: string[] }
      expect(final.items.sort()).toEqual(['from-a', 'from-b'])
    })

    test('concurrent first-ever writes both land (insert race retry)', async () => {
      const a = makeStore()
      const b = makeStore()
      await a.initialize()
      await b.initialize()

      const add = (item: string) => (current: string | undefined) => {
        const parsed = current ? (JSON.parse(current) as { items: string[] }) : { items: [] as string[] }
        parsed.items.push(item)
        return JSON.stringify(parsed)
      }
      await Promise.all([a.mutateSecret('GITHUB_TOKEN', add('from-a')), b.mutateSecret('GITHUB_TOKEN', add('from-b'))])

      const fresh = makeStore()
      await fresh.initialize()
      const final = JSON.parse(fresh.get('GITHUB_TOKEN')!) as { items: string[] }
      expect(final.items.sort()).toEqual(['from-a', 'from-b'])
    })

    test('mutate returning undefined writes nothing', async () => {
      await store.set('GITHUB_TOKEN', 'unchanged')
      const [before] = await db.select().from(secrets).where(eq(secrets.key, 'GITHUB_TOKEN'))

      const listened: string[] = []
      store.onChange((key) => {
        listened.push(key)
      })
      await store.mutateSecret('GITHUB_TOKEN', () => undefined)

      const [after] = await db.select().from(secrets).where(eq(secrets.key, 'GITHUB_TOKEN'))
      expect(after).toEqual(before)
      expect(store.get('GITHUB_TOKEN')).toBe('unchanged')
      expect(listened).toEqual([])

      // Unset key + skip: no row created either.
      await store.mutateSecret('LINEAR_API_KEY', (current) => {
        expect(current).toBeUndefined()
        return undefined
      })
      const rows = await db.select().from(secrets).where(eq(secrets.key, 'LINEAR_API_KEY'))
      expect(rows).toHaveLength(0)
    })

    test('first-ever write inserts the row', async () => {
      await store.mutateSecret(
        'GITHUB_TOKEN',
        (current) => {
          expect(current).toBeUndefined()
          return 'first-value'
        },
        'system'
      )

      expect(store.get('GITHUB_TOKEN')).toBe('first-value')
      const [row] = await db.select().from(secrets).where(eq(secrets.key, 'GITHUB_TOKEN'))
      expect(row).toBeDefined()
      expect(row.updatedBy).toBe('system')

      const fresh = makeStore()
      await fresh.initialize()
      expect(fresh.get('GITHUB_TOKEN')).toBe('first-value')
    })

    test('undecryptable row rejects the mutation and leaves the row untouched', async () => {
      const garbage = {
        key: 'GITHUB_TOKEN',
        encryptedValue: randomBytes(48).toString('hex'),
        iv: randomBytes(16).toString('hex'),
        updatedAt: new Date(),
        updatedBy: 'corrupt',
      }
      await db.insert(secrets).values(garbage)

      let mutateRan = false
      await expect(
        store.mutateSecret('GITHUB_TOKEN', () => {
          mutateRan = true
          return 'fresh-empty-overwrite'
        })
      ).rejects.toThrow()
      expect(mutateRan).toBe(false)

      const [row] = await db.select().from(secrets).where(eq(secrets.key, 'GITHUB_TOKEN'))
      expect(row.encryptedValue).toBe(garbage.encryptedValue)
      expect(row.iv).toBe(garbage.iv)
      expect(row.updatedBy).toBe('corrupt')
    })

    test('throws in env-fallback mode (no encryption key)', async () => {
      delete process.env.FICUS_ENCRYPTION_KEY
      const fallbackStore = makeStore()
      await fallbackStore.initialize()

      await expect(fallbackStore.mutateSecret('GITHUB_TOKEN', () => 'x')).rejects.toThrow(
        'FICUS_ENCRYPTION_KEY not configured'
      )
      process.env.FICUS_ENCRYPTION_KEY = testKey
    })
  })

  describe('cross-process invalidation', () => {
    test('an older full refresh cannot overwrite a newer key refresh', async () => {
      let resolveSnapshotCaptured!: () => void
      const snapshotCaptured = new Promise<void>((resolve) => {
        resolveSnapshotCaptured = resolve
      })
      let releaseSnapshot!: () => void
      const snapshotRelease = new Promise<void>((resolve) => {
        releaseSnapshot = resolve
      })

      class DelayedFullRefreshStore extends SecretStore {
        private allRowsLoads = 0

        protected override async selectAllRows(): Promise<(typeof secrets.$inferSelect)[]> {
          const rows = await super.selectAllRows()
          this.allRowsLoads += 1
          if (this.allRowsLoads === 2) {
            resolveSnapshotCaptured()
            await snapshotRelease
          }
          return rows
        }

        runFullRefresh(): Promise<void> {
          return this.loadFromDb()
        }
      }

      await store.set('GITHUB_TOKEN', 'v1')
      const replica = new DelayedFullRefreshStore()
      await replica.initialize()
      expect(replica.get('GITHUB_TOKEN')).toBe('v1')

      const staleFullRefresh = replica.runFullRefresh()
      await snapshotCaptured
      await store.set('GITHUB_TOKEN', 'v2')
      await replica.refreshKey('GITHUB_TOKEN')
      expect(replica.get('GITHUB_TOKEN')).toBe('v2')

      releaseSnapshot()
      await staleFullRefresh
      expect(replica.get('GITHUB_TOKEN')).toBe('v2')
    })

    test('a later-started key refresh wins when its query resolves last', async () => {
      let releaseOld!: () => void
      const oldRelease = new Promise<void>((resolve) => {
        releaseOld = resolve
      })
      let releaseNew!: () => void
      const newRelease = new Promise<void>((resolve) => {
        releaseNew = resolve
      })
      let resolveOldCaptured!: () => void
      const oldCaptured = new Promise<void>((resolve) => {
        resolveOldCaptured = resolve
      })
      let resolveNewCaptured!: () => void
      const newCaptured = new Promise<void>((resolve) => {
        resolveNewCaptured = resolve
      })

      class OrderedKeyRefreshStore extends SecretStore {
        private keyLoads = 0

        protected override async selectRow(key: string): Promise<typeof secrets.$inferSelect | undefined> {
          const row = await super.selectRow(key)
          this.keyLoads += 1
          if (this.keyLoads === 1) {
            resolveOldCaptured()
            await oldRelease
          } else if (this.keyLoads === 2) {
            resolveNewCaptured()
            await newRelease
          }
          return row
        }
      }

      await store.set('GITHUB_TOKEN', 'v1')
      const replica = new OrderedKeyRefreshStore()
      await replica.initialize()
      await store.set('GITHUB_TOKEN', 'v2')

      const oldRefresh = replica.refreshKey('GITHUB_TOKEN')
      await oldCaptured
      await store.set('GITHUB_TOKEN', 'v3')
      const newRefresh = replica.refreshKey('GITHUB_TOKEN')
      await newCaptured

      releaseOld()
      await oldRefresh
      expect(replica.get('GITHUB_TOKEN')).toBe('v2')
      releaseNew()
      await newRefresh
      expect(replica.get('GITHUB_TOKEN')).toBe('v3')
    })

    test('a later-started full refresh wins while an older key refresh is in flight', async () => {
      let releaseKey!: () => void
      const keyRelease = new Promise<void>((resolve) => {
        releaseKey = resolve
      })
      let releaseFull!: () => void
      const fullRelease = new Promise<void>((resolve) => {
        releaseFull = resolve
      })
      let resolveKeyCaptured!: () => void
      const keyCaptured = new Promise<void>((resolve) => {
        resolveKeyCaptured = resolve
      })
      let resolveFullCaptured!: () => void
      const fullCaptured = new Promise<void>((resolve) => {
        resolveFullCaptured = resolve
      })

      class OrderedMixedRefreshStore extends SecretStore {
        private allRowsLoads = 0

        protected override async selectRow(key: string): Promise<typeof secrets.$inferSelect | undefined> {
          const row = await super.selectRow(key)
          resolveKeyCaptured()
          await keyRelease
          return row
        }

        protected override async selectAllRows(): Promise<(typeof secrets.$inferSelect)[]> {
          const rows = await super.selectAllRows()
          this.allRowsLoads += 1
          if (this.allRowsLoads === 2) {
            resolveFullCaptured()
            await fullRelease
          }
          return rows
        }

        runFullRefresh(): Promise<void> {
          return this.loadFromDb()
        }
      }

      await store.set('GITHUB_TOKEN', 'v1')
      const replica = new OrderedMixedRefreshStore()
      await replica.initialize()
      await store.set('GITHUB_TOKEN', 'v2')
      const olderKeyRefresh = replica.refreshKey('GITHUB_TOKEN')
      await keyCaptured

      await store.set('GITHUB_TOKEN', 'v3')
      const newerFullRefresh = replica.runFullRefresh()
      await fullCaptured
      releaseKey()
      await olderKeyRefresh
      expect(replica.get('GITHUB_TOKEN')).toBe('v2')

      releaseFull()
      await newerFullRefresh
      expect(replica.get('GITHUB_TOKEN')).toBe('v3')
    })

    test('a failed newer full refresh does not suppress a successful key refresh', async () => {
      const keyCaptured = deferred()
      const releaseKey = deferred()

      class FailedFullRefreshStore extends SecretStore {
        private allRowsLoads = 0

        protected override async selectRow(key: string): Promise<typeof secrets.$inferSelect | undefined> {
          const row = await super.selectRow(key)
          keyCaptured.resolve()
          await releaseKey.promise
          return row
        }

        protected override async selectAllRows(): Promise<(typeof secrets.$inferSelect)[]> {
          this.allRowsLoads += 1
          if (this.allRowsLoads === 2) throw new Error('full refresh failed')
          return super.selectAllRows()
        }

        runFullRefresh(): Promise<void> {
          return this.loadFromDb()
        }
      }

      await store.set('GITHUB_TOKEN', 'v1')
      const replica = new FailedFullRefreshStore()
      await replica.initialize()
      await store.set('GITHUB_TOKEN', 'v2')

      const successfulKeyRefresh = replica.refreshKey('GITHUB_TOKEN')
      await keyCaptured.promise
      await expect(replica.runFullRefresh()).rejects.toThrow('full refresh failed')
      releaseKey.resolve()
      await successfulKeyRefresh

      expect(replica.get('GITHUB_TOKEN')).toBe('v2')
    })

    test('a failed newer same-key refresh does not suppress an older successful refresh', async () => {
      const keyCaptured = deferred()
      const releaseKey = deferred()

      class FailedKeyRefreshStore extends SecretStore {
        private keyLoads = 0

        protected override async selectRow(key: string): Promise<typeof secrets.$inferSelect | undefined> {
          this.keyLoads += 1
          if (this.keyLoads === 2) throw new Error('key refresh failed')
          const row = await super.selectRow(key)
          keyCaptured.resolve()
          await releaseKey.promise
          return row
        }
      }

      await store.set('GITHUB_TOKEN', 'v1')
      const replica = new FailedKeyRefreshStore()
      await replica.initialize()
      await store.set('GITHUB_TOKEN', 'v2')

      const successfulKeyRefresh = replica.refreshKey('GITHUB_TOKEN')
      await keyCaptured.promise
      await expect(replica.refreshKey('GITHUB_TOKEN')).rejects.toThrow('key refresh failed')
      releaseKey.resolve()
      await successfulKeyRefresh

      expect(replica.get('GITHUB_TOKEN')).toBe('v2')
    })

    test('refreshKey updates the cache and fires change listeners', async () => {
      await store.set('GITHUB_TOKEN', 'v1')

      const other = makeStore()
      await other.initialize()
      expect(other.get('GITHUB_TOKEN')).toBe('v1')

      const events: [string, string | undefined][] = []
      other.onChange((key, value) => {
        events.push([key, value])
      })

      // Update lands in the DB via `store`; `other`'s cache is stale until refresh.
      await store.set('GITHUB_TOKEN', 'v2')
      expect(other.get('GITHUB_TOKEN')).toBe('v1')
      await other.refreshKey('GITHUB_TOKEN')
      expect(other.get('GITHUB_TOKEN')).toBe('v2')
      expect(events).toEqual([['GITHUB_TOKEN', 'v2']])

      // Deleted key: refresh clears the cache and notifies with undefined.
      await store.delete('GITHUB_TOKEN')
      await other.refreshKey('GITHUB_TOKEN')
      expect(other.get('GITHUB_TOKEN')).toBeUndefined()
      expect(events).toEqual([
        ['GITHUB_TOKEN', 'v2'],
        ['GITHUB_TOKEN', undefined],
      ])

      // Self-originated/no-op refresh does not re-fire listeners.
      await other.refreshKey('GITHUB_TOKEN')
      expect(events).toHaveLength(2)
    })

    test('set, delete, and mutateSecret emit secret_changed with the key only', async () => {
      const received: string[] = []
      const unlisten = await listen(SECRET_CHANGED_CHANNEL, (payload) => {
        received.push(payload)
      })
      try {
        await store.set('GITHUB_TOKEN', 'notify-me')
        await waitFor(() => received.length >= 1)
        await store.mutateSecret('GITHUB_TOKEN', () => 'notify-me-2')
        await waitFor(() => received.length >= 2)
        await store.delete('GITHUB_TOKEN')
        await waitFor(() => received.length >= 3)

        expect(received).toEqual(['GITHUB_TOKEN', 'GITHUB_TOKEN', 'GITHUB_TOKEN'])
        // Never the value — local-events HTTP payloads are key-only and unencrypted.
        expect(received.join()).not.toContain('notify-me')
      } finally {
        await unlisten()
      }
    })

    test("a subscribed instance picks up another instance's write", async () => {
      const other = makeStore()
      await other.initialize()
      await other.startCrossProcessInvalidation()

      const events: [string, string | undefined][] = []
      other.onChange((key, value) => {
        events.push([key, value])
      })

      try {
        await store.set('GITHUB_TOKEN', 'live-update')
        await waitFor(() => other.get('GITHUB_TOKEN') === 'live-update')
        expect(events).toContainEqual(['GITHUB_TOKEN', 'live-update'])
      } finally {
        other.stopCrossProcessInvalidation()
      }
    })
  })

  test('periodic refresh is registered with the periodic-runner registry', async () => {
    const registryStore = makeStore()
    await registryStore.initialize()

    registryStore.startPeriodicRefresh()
    registryStore.startPeriodicRefresh()
    expect(listPeriodicRunnerNames().filter((name) => name === 'secret-store-refresh')).toHaveLength(1)

    registryStore.stopPeriodicRefresh()
    expect(listPeriodicRunnerNames()).not.toContain('secret-store-refresh')
  })

  test('refreshes every 5 minutes by default, behind cross-process invalidation', async () => {
    const registryStore = new SecretStore()
    await registryStore.initialize()

    registryStore.startPeriodicRefresh()
    const runner = listPeriodicRunners().find((r) => r.runnerName === 'secret-store-refresh')
    expect(runner?.runnerIntervalMs).toBe(5 * 60_000)

    registryStore.stopPeriodicRefresh()
  })
})

describe('content-safety matcher eligibility', () => {
  test('never matches public identifier keys', () => {
    // These hold a commit author, a bundle id, an environment label. Replacing
    // them in tool output would corrupt correct text for no security gain.
    for (const key of [
      'GITHUB_USER',
      'GIT_USER_NAME',
      'GIT_USER_EMAIL',
      'VAPID_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
      'DISCORD_GUILD_ID',
      'TELEGRAM_BOT_ID',
      'APNS_TEAM_ID',
      'APNS_BUNDLE_ID',
      'APNS_ENV',
    ]) {
      expect(isMatchableSecret(key, 'a-perfectly-ordinary-identifier')).toBe(false)
    }
  })

  test('still matches real credential keys', () => {
    for (const key of [
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'FICUS_PASSWORD',
      'SANDBOX_CALLBACK_SECRET',
      'VAPID_PRIVATE_KEY',
      'PROVIDER_AUTH_DATA',
      'GITHUB_TOKEN_NOAHSASO',
    ]) {
      expect(isMatchableSecret(key, 'ghp_0123456789abcdefghij')).toBe(true)
    }
  })

  test('never matches a value short enough to collide with ordinary prose', () => {
    expect(isMatchableSecret('GITHUB_TOKEN', 'tau')).toBe(false)
    expect(isMatchableSecret('GITHUB_TOKEN', 'short')).toBe(false)
    expect(isMatchableSecret('GITHUB_TOKEN', '0123456789ab')).toBe(true)
  })
})

describe('SecretStore — platform-managed keys', () => {
  const testKey = randomBytes(32).toString('hex')
  const originalEnvKey = process.env.FICUS_ENCRYPTION_KEY
  let managedFixture: ReturnType<typeof createGeneratedSecretEnvironmentFixture>
  let managedKey: string
  let managedValue: string

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    managedFixture = createGeneratedSecretEnvironmentFixture()
    managedKey = managedFixture.key
    managedValue = managedFixture.value
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = managedKey
  })

  afterEach(() => {
    if (originalEnvKey) process.env.FICUS_ENCRYPTION_KEY = originalEnvKey
    else delete process.env.FICUS_ENCRYPTION_KEY
    delete process.env.FICUS_MANAGED
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    delete process.env.APNS_KEY_P8_FILE
    managedFixture.revoke()
  })

  test('a managed key is NEVER ingested into the store (no DB entry) but get() resolves it from env', async () => {
    const store = makeStore({ testEnvironmentReadFixtures: [managedFixture] })
    await store.initialize()

    // Env-first: core services keep working off the env value…
    expect(store.get(managedKey)).toBe(managedValue)
    // …while the key never becomes a store ENTRY (migrateFromEnv skipped it).
    const [row] = await db.select().from(secrets).where(eq(secrets.key, managedKey))
    expect(row).toBeUndefined()
  })

  test('list() excludes a managed key even when a stale DB row exists, and get() ignores the stale row', async () => {
    // Simulate a self-host that later became platform-managed: a leftover DB row.
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    const seed = makeStore()
    await seed.initialize()
    await seed.set(managedKey, 'stale-db-value')

    // Now the platform manages it.
    process.env.FICUS_MANAGED_SECRET_KEYS = managedKey
    const store = makeStore({ testEnvironmentReadFixtures: [managedFixture] })
    await store.initialize()

    const list = await store.list()
    expect(list.some((s) => s.key === managedKey)).toBe(false)
    // The env-delivered value wins over the stale DB row — never shadowed.
    expect(store.get(managedKey)).toBe(managedValue)
  })

  test('a key superseded by a managed key is managed too: hidden from list() and its DB row never resolves', async () => {
    // APNS_KEY_P8 (inline PEM) is resolved BEFORE APNS_KEY_P8_FILE, so a
    // tenant-set inline key would silently override the platform's .p8.
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    const seed = makeStore()
    await seed.initialize()
    await seed.set('APNS_KEY_P8', 'tenant-supplied-pem')
    expect((await seed.list()).some((s) => s.key === 'APNS_KEY_P8')).toBe(true)

    // The platform now manages the FILE variant — the inline key follows,
    // without making its filesystem path a tenant-visible Secret Store key.
    const managedPath = `/tmp/generated-${randomUUID()}.p8`
    process.env.FICUS_MANAGED_SECRET_KEYS = `${managedKey},APNS_KEY_P8_FILE`
    process.env.APNS_KEY_P8_FILE = managedPath
    const store = makeStore()
    await store.initialize()

    const listed = await store.list()
    expect(listed.some((s) => s.key === 'APNS_KEY_P8')).toBe(false)
    expect(listed.some((s) => s.key === 'APNS_KEY_P8_FILE')).toBe(false)
    expect(store.get('APNS_KEY_P8_FILE')).toBe(managedPath)
    // Env-first for managed keys, and there IS no APNS_KEY_P8 env value on a
    // managed instance — so the tenant row is dead and APNs resolution falls
    // through to APNS_KEY_P8_FILE.
    expect(store.get('APNS_KEY_P8')).toBeUndefined()
  })

  test('the exe.dev key resolves from EXE_PROVIDER_SSH_KEY, decoded, and its stale DB row never shadows it', async () => {
    // The credential that made this alias necessary: its store key contains a
    // hyphen (systemd cannot set such a variable) and its value spans lines (an
    // EnvironmentFile value may not). A self-host that later became managed can
    // easily have a leftover row under the old name.
    const pem = `CANARY_SECRET_${randomUUID()}\ngenerated multiline fixture\n`
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    const seed = makeStore()
    await seed.initialize()
    await seed.set('exe-provider-ssh-key', 'stale-tenant-key')
    expect((await seed.list()).some((s) => s.key === 'exe-provider-ssh-key')).toBe(true)

    process.env.FICUS_MANAGED_SECRET_KEYS = `${managedKey},EXE_PROVIDER_SSH_KEY`
    process.env.EXE_PROVIDER_SSH_KEY = Buffer.from(pem, 'utf8').toString('base64')
    try {
      expect(() => makeStore({ testEnvironmentReadFixtures: [{ key: 'exe-provider-ssh-key' }] as never })).toThrow(
        'active generated fixture capability'
      )
      const store = makeStore()
      await store.initialize()
      expect(store.get('exe-provider-ssh-key')).toBeUndefined()
      expect((await store.list()).some((s) => s.key === 'exe-provider-ssh-key')).toBe(false)
    } finally {
      delete process.env.EXE_PROVIDER_SSH_KEY
    }
  })

  test('self-hosted: the exe.dev key stays an ordinary DB secret, read verbatim', async () => {
    delete process.env.FICUS_MANAGED
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    const store = makeStore()
    await store.initialize()
    await store.set('exe-provider-ssh-key', 'self-hosted-pem')

    expect((await store.list()).some((s) => s.key === 'exe-provider-ssh-key')).toBe(true)
    expect(store.get('exe-provider-ssh-key')).toBe('self-hosted-pem')
  })

  test('self-hosted: a superseded key stays an ordinary, listed, resolvable secret', async () => {
    delete process.env.FICUS_MANAGED
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    const store = makeStore()
    await store.initialize()

    await store.set('APNS_KEY_P8', 'self-hosted-pem')

    expect((await store.list()).some((s) => s.key === 'APNS_KEY_P8')).toBe(true)
    expect(store.get('APNS_KEY_P8')).toBe('self-hosted-pem')
  })
})

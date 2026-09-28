import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, secrets, settings, integrationConnections } from '../../../db'
import { SecretStore } from '../../secrets/store'
import { importLegacyLinearCredential } from './legacy-import'

test('legacy Linear credentials migrate once without enabling access or restoring a replaced token', async () => {
  const marker = '__integration-migration:linear-credential'
  const id = '43956328-8dc6-4b08-9cd9-9089322e470f'
  const ref = '__integration-credential:linear-legacy-import:bearer'
  const keys = ['LINEAR_API_KEY', 'LINEAR_USER_ID', ref]
  const env = Object.fromEntries(
    ['FICUS_ENCRYPTION_KEY', 'LINEAR_API_KEY', 'LINEAR_USER_ID'].map((key) => [key, process.env[key]])
  )
  const priorSecrets = await db.select().from(secrets).where(inArray(secrets.key, keys))
  const priorMarker = await db.select().from(settings).where(eq(settings.key, marker))
  const priorConnection = await db.select().from(integrationConnections).where(eq(integrationConnections.id, id))
  try {
    await db.delete(secrets).where(inArray(secrets.key, keys))
    await db.delete(settings).where(eq(settings.key, marker))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    delete process.env.LINEAR_API_KEY
    delete process.env.LINEAR_USER_ID
    const store = new SecretStore()
    await store.initialize()
    await store.set('LINEAR_API_KEY', 'legacy-test-token')
    await store.set('LINEAR_USER_ID', 'legacy-user')
    await importLegacyLinearCredential(store)
    const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, id))
    expect(connection).toMatchObject({
      providerKey: 'linear',
      enabled: false,
      authState: 'pending',
      credentialRef: ref,
    })
    await store.refreshKey(ref)
    expect(store.get(ref)).toBe('legacy-test-token')
    expect(store.get('LINEAR_API_KEY')).toBe('')
    expect(store.get('LINEAR_USER_ID')).toBe('')
    await store.set(ref, 'replacement-test-token')
    await store.set('LINEAR_API_KEY', 'stale-token-after-restart')
    await importLegacyLinearCredential(store)
    expect(store.get(ref)).toBe('replacement-test-token')
    expect(store.get('LINEAR_API_KEY')).toBe('')
    expect(await db.select().from(integrationConnections).where(eq(integrationConnections.id, id))).toHaveLength(1)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    await db.delete(settings).where(eq(settings.key, marker))
    await db.delete(secrets).where(inArray(secrets.key, keys))
    if (priorConnection.length) await db.insert(integrationConnections).values(priorConnection)
    if (priorMarker.length) await db.insert(settings).values(priorMarker)
    if (priorSecrets.length) await db.insert(secrets).values(priorSecrets)
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

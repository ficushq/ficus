import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, integrationRevocationJobs, secrets } from '../../../db'
import { SecretStore } from '../../secrets/store'
import { RevocationArtifactStager } from './revocation-artifact-stager'

let store: SecretStore

beforeEach(async () => {
  process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  await db.delete(secrets)
  store = new SecretStore()
  store.bindContentSafetyConsumer({ replace: () => undefined, update: () => undefined })
  await store.initialize()
})

afterEach(() => store.stopPeriodicRefresh())

test('staging acknowledgement loss refreshes the exact process-local cache entry', async () => {
  const refreshed: string[] = []
  const stager = new RevocationArtifactStager({
    setWithDurableObligation: async () => {
      throw new Error('commit acknowledgement lost')
    },
    refreshKey: async (key) => {
      refreshed.push(key)
    },
  } as Pick<SecretStore, 'setWithDurableObligation' | 'refreshKey'>)
  const credentialRef = `__integration-credential:rollback:${randomUUID()}`
  await expect(
    stager.stage({
      credentialRef,
      credential: 'serialized-grant',
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      actor: 'test-user',
    })
  ).rejects.toThrow('commit acknowledgement lost')
  expect(refreshed).toEqual([credentialRef])
})

test('rollback artifact and authority-owned revocation job are staged atomically and idempotently', async () => {
  const credentialRef = `__integration-credential:rollback:${randomUUID()}`
  const stager = new RevocationArtifactStager(store)

  await stager.stage({
    credentialRef,
    credential: 'serialized-grant',
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    actor: 'test-user',
  })
  await stager.stage({
    credentialRef,
    credential: 'serialized-grant',
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    actor: 'test-user',
  })

  expect(store.get(credentialRef)).toBe('serialized-grant')
  const jobs = await db
    .select()
    .from(integrationRevocationJobs)
    .where(eq(integrationRevocationJobs.credentialRef, credentialRef))
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ clientAuthority: 'platform_broker', providerKey: 'notion', adapterVersion: 1 })

  await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, credentialRef))
  await db.delete(secrets).where(eq(secrets.key, credentialRef))
})

import { expect, test } from 'bun:test'
import { randomBytes } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { db, integrationAuthorizationFlowReceipts, integrationCredentialCleanupJobs, secrets } from '../../db'
import {
  DbIntegrationCredentialCleanupRepository,
  IntegrationCredentialCleanupWorker,
  type CredentialCleanupJob,
  type IntegrationCredentialCleanupRepository,
} from './credential-cleanup-worker'
import { SecretStore, type SecretStoreTransaction } from '../secrets/store'

class MemoryCleanupRepository implements IntegrationCredentialCleanupRepository {
  job: CredentialCleanupJob | null = {
    id: 'job-1',
    credentialRef: '__integration-credential:connection:revision:bearer',
    authorizationFlowId: null,
    attempts: 0,
    leaseToken: '',
  }
  failures: Array<{ attempts: number; nextAttemptAt: Date }> = []

  async claim(_now: Date, _leaseExpiresAt: Date, leaseToken: string) {
    if (!this.job) return null
    this.job = { ...this.job, leaseToken }
    return this.job
  }
  async complete(id: string, leaseToken: string) {
    if (this.job?.id === id && this.job.leaseToken === leaseToken) this.job = null
  }
  async settleWithinTransaction(job: CredentialCleanupJob) {
    await this.complete(job.id, job.leaseToken)
  }
  async fail(_id: string, _leaseToken: string, attempts: number, nextAttemptAt: Date) {
    this.failures.push({ attempts, nextAttemptAt })
    if (this.job) this.job = { ...this.job, attempts, leaseToken: '' }
  }
}

test('failed credential deletion remains durable and a later retry succeeds', async () => {
  const repository = new MemoryCleanupRepository()
  let deletes = 0
  const credentials = {
    deleteWithDurableMutation: async (_key: string, mutation: (tx: SecretStoreTransaction) => Promise<void>) => {
      deletes += 1
      if (deletes === 1) throw new Error('secret backend unavailable')
      await mutation(undefined as unknown as SecretStoreTransaction)
    },
  }
  const now = new Date('2026-01-01T00:00:00.000Z')
  const worker = new IntegrationCredentialCleanupWorker(
    repository,
    credentials,
    () => now,
    () => `lease-${deletes}`
  )

  expect(await worker.runOnce()).toBe(true)
  expect(repository.job).not.toBeNull()
  expect(repository.failures).toEqual([{ attempts: 1, nextAttemptAt: new Date(now.getTime() + 1_000) }])

  expect(await worker.runOnce()).toBe(true)
  expect(repository.job).toBeNull()
  expect(deletes).toBe(2)
})

test('flow-owned cleanup atomically settles with database timestamps despite a skewed worker clock', async () => {
  const priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  const credentials = new SecretStore()
  credentials.bindContentSafetyConsumer({ replace: () => undefined, update: () => undefined })
  await credentials.initialize()
  const localFlowId = crypto.randomUUID()
  const credentialRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  const now = new Date('2100-01-01T00:00:00.000Z')
  await credentials.set(credentialRef, 'serialized-grant')
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'connect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'a'.repeat(64),
    artifactCredentialRef: credentialRef,
    terminalCode: 'flow_expired',
    // Settlement uses the DB clock too: host timestamps can be ahead and
    // violate cleanupSettledAt >= cleanupRequiredAt even in a healthy transaction.
    terminalAt: sql`transaction_timestamp()`,
    cleanupRequiredAt: sql`transaction_timestamp()`,
    recoveryExpiresAt: sql`transaction_timestamp()`,
    retainUntil: sql`transaction_timestamp()`,
  })
  await db.insert(integrationCredentialCleanupJobs).values({
    credentialRef,
    authorizationFlowId: localFlowId,
    // Eligibility uses the database clock; the host clock can be slightly ahead.
    nextAttemptAt: sql`clock_timestamp()`,
  })
  const worker = new IntegrationCredentialCleanupWorker(
    new DbIntegrationCredentialCleanupRepository([credentialRef]),
    credentials,
    () => new Date(now.getTime() + 1),
    () => crypto.randomUUID()
  )

  try {
    expect(await worker.runOnce()).toBe(true)
    expect(await db.select().from(secrets).where(eq(secrets.key, credentialRef))).toHaveLength(0)
    expect(
      await db
        .select()
        .from(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, localFlowId))
    ).toHaveLength(0)
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(receipt?.cleanupSettledAt).toBeInstanceOf(Date)
  } finally {
    credentials.stopPeriodicRefresh()
    if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, credentialRef))
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
  }
})

test('DB cleanup claims enforce due time, leases, expiry recovery, and lease-token ownership', async () => {
  const repository = new DbIntegrationCredentialCleanupRepository()
  const credentialRef = `test-cleanup:${crypto.randomUUID()}`
  const now = new Date('2026-01-01T00:00:00.000Z')
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  const [job] = await db
    .insert(integrationCredentialCleanupJobs)
    .values({ credentialRef, nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
    .returning()
  try {
    expect(
      await repository.claim(now, new Date(now.getTime() + 60_000), '00000000-0000-4000-8000-000000000001')
    ).toBeNull()
    await db
      .update(integrationCredentialCleanupJobs)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(integrationCredentialCleanupJobs.id, job.id))
    expect(
      await new DbIntegrationCredentialCleanupRepository([]).claim(
        now,
        new Date(now.getTime() + 60_000),
        '00000000-0000-4000-8000-000000000009'
      )
    ).toBeNull()
    const first = await repository.claim(now, new Date(now.getTime() + 60_000), '00000000-0000-4000-8000-000000000001')
    expect(first?.id).toBe(job.id)
    expect(
      await repository.claim(now, new Date(now.getTime() + 60_000), '00000000-0000-4000-8000-000000000002')
    ).toBeNull()

    await db
      .update(integrationCredentialCleanupJobs)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(integrationCredentialCleanupJobs.id, job.id))
    const reclaimed = await repository.claim(
      new Date('1900-01-01T00:00:00.000Z'),
      new Date('1900-01-01T00:01:00.000Z'),
      '00000000-0000-4000-8000-000000000002'
    )
    expect(reclaimed?.id).toBe(job.id)
    await repository.complete(job.id, '00000000-0000-4000-8000-000000000001')
    expect(
      await db
        .select({ id: integrationCredentialCleanupJobs.id })
        .from(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.id, job.id))
    ).toEqual([{ id: job.id }])
    await repository.complete(job.id, '00000000-0000-4000-8000-000000000002')
    expect(
      await db
        .select({ id: integrationCredentialCleanupJobs.id })
        .from(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.id, job.id))
    ).toHaveLength(0)
  } finally {
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
  }
})

test('DB-backed cleanup failure waits until its durable retry is due, then succeeds', async () => {
  const repository = new DbIntegrationCredentialCleanupRepository()
  const credentialRef = `test-cleanup:${crypto.randomUUID()}`
  let now = new Date('2026-01-01T00:00:00.000Z')
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  const [job] = await db
    .insert(integrationCredentialCleanupJobs)
    .values({ credentialRef, nextAttemptAt: now })
    .returning()
  let deletes = 0
  const worker = new IntegrationCredentialCleanupWorker(
    repository,
    {
      deleteWithDurableMutation: async (_key: string, mutation: (tx: SecretStoreTransaction) => Promise<void>) => {
        deletes += 1
        if (deletes === 1) throw new Error('transient')
        await db.transaction(async (tx) => mutation(tx))
      },
    },
    () => now,
    () => crypto.randomUUID()
  )
  try {
    expect(await worker.runOnce()).toBe(true)
    expect(await worker.runOnce()).toBe(false)
    const [failed] = await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.id, job.id))
    expect(failed).toMatchObject({ attempts: 1, lastErrorCode: 'secret_delete_failed' })
    now = new Date(now.getTime() + 1_000)
    await db
      .update(integrationCredentialCleanupJobs)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(integrationCredentialCleanupJobs.id, job.id))
    expect(await worker.runOnce()).toBe(true)
    expect(deletes).toBe(2)
    expect(
      await db.select().from(integrationCredentialCleanupJobs).where(eq(integrationCredentialCleanupJobs.id, job.id))
    ).toHaveLength(0)
  } finally {
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
  }
})

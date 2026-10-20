import { afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT, type ManagedBigbrainVaultSummary } from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults, users } from '../../../../db'
import { ManagedVaultStoreError, managedVaultStore as store } from './store'

const createdUsers: string[] = []
afterEach(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.ownerUserId, createdUsers))
  await db.delete(users).where(inArray(users.id, createdUsers.splice(0)))
})
async function human(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  createdUsers.push(user!.id)
  return user!.id
}
const createInput = (displayName: string, requestId: string, ownerUserId: string) => ({
  requestId,
  displayName,
  ownerUserId,
  ownerHandle: 'ada',
  ownerDisplay: 'Ada',
  actorUserId: ownerUserId,
})
async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedVaultStoreError)
    return (error as ManagedVaultStoreError).code
  }
  throw new Error('expected a refusal')
}
function summary(
  row: { id: string; ownerUserId: string; displayName: string },
  patch: Partial<ManagedBigbrainVaultSummary> = {}
) {
  return {
    contractVersion: 1 as const,
    vaultId: row.id,
    displayName: row.displayName,
    ownerUserId: row.ownerUserId,
    state: 'ready' as const,
    readAccess: 'active' as const,
    desiredGeneration: 1,
    appliedGeneration: 1,
    upstreamVaultId: crypto.randomUUID(),
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    origin: null,
    operationId: crypto.randomUUID(),
    lastErrorCode: null,
    retryable: false,
    updatedAt: new Date().toISOString(),
    ...patch,
  }
}

test('two vaults and a retried create retain independent identities', async () => {
  const owner = await human()
  const requestA = crypto.randomUUID()
  const requestB = crypto.randomUUID()
  const a = await store.request(createInput(`Research ${requestA}`, requestA, owner))
  const b = await store.request(createInput(`Design ${requestB}`, requestB, owner))
  expect(a.id).not.toBe(b.id)
  expect((await store.request(createInput(`Research ${requestA}`, requestA, owner))).id).toBe(a.id)
  expect(a).toMatchObject({ state: 'requested', readAccess: 'pending', desiredGeneration: 1, appliedGeneration: 0 })
  const rows = await db.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.ownerUserId, owner))
  expect(rows).toHaveLength(2)
})

test('concurrent replays of one create request converge on one vault', async () => {
  const owner = await human()
  const requestId = crypto.randomUUID()
  const results = await Promise.all(
    Array.from({ length: 4 }, () => store.request(createInput(`Same ${requestId}`, requestId, owner)))
  )
  expect(new Set(results.map((r) => r.id)).size).toBe(1)
})

test('a replayed request ID with a different body conflicts and changes nothing', async () => {
  const owner = await human()
  const other = await human()
  const requestId = crypto.randomUUID()
  const a = await store.request(createInput(`Original ${requestId}`, requestId, owner))
  expect(await code(store.request(createInput(`Renamed ${requestId}`, requestId, owner)))).toBe('request_conflict')
  expect(await code(store.request(createInput(`Original ${requestId}`, requestId, other)))).toBe('request_conflict')
  expect((await store.get(a.id))?.displayName).toBe(`Original ${requestId}`)
})

test('a live display name cannot be reused, but a deleted tombstone frees it', async () => {
  const owner = await human()
  const name = `Shared ${crypto.randomUUID()}`
  const a = await store.request(createInput(name, crypto.randomUUID(), owner))
  expect(await code(store.request(createInput(name, crypto.randomUUID(), owner)))).toBe('name_conflict')
  await store.applySummary(summary(a, { state: 'deleted', desiredGeneration: 2, appliedGeneration: 2 }))
  const b = await store.request(createInput(name, crypto.randomUUID(), owner))
  expect(b.id).not.toBe(a.id)
})

test('Platform summaries apply monotonically: a late or older generation never rolls state back', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Sync ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  const ready = summary(row, { desiredGeneration: 2, appliedGeneration: 2 })
  const applied = await store.applySummary(ready)
  expect(applied).toMatchObject({
    state: 'ready',
    readAccess: 'active',
    desiredGeneration: 2,
    appliedGeneration: 2,
    upstreamVaultId: ready.upstreamVaultId,
  })
  // An in-flight reply from generation 1 arrives late: ignored.
  const stale = await store.applySummary(
    summary(row, { state: 'provisioning', desiredGeneration: 1, appliedGeneration: 0 })
  )
  expect(stale).toMatchObject({ state: 'ready', desiredGeneration: 2, appliedGeneration: 2 })
  // Same desired generation but less applied progress is also stale.
  await store.applySummary(summary(row, { desiredGeneration: 2, appliedGeneration: 1, state: 'provisioning' }))
  expect((await store.get(row.id))?.state).toBe('ready')
  // Within one generation, Platform's own updatedAt orders observations (ready -> degraded).
  const later = new Date(Date.parse(ready.updatedAt) + 1000).toISOString()
  const earlier = new Date(Date.parse(ready.updatedAt) - 1000).toISOString()
  await store.applySummary({ ...ready, state: 'degraded', updatedAt: later })
  expect((await store.get(row.id))?.state).toBe('degraded')
  await store.applySummary({ ...ready, state: 'ready', updatedAt: earlier })
  expect((await store.get(row.id))?.state).toBe('degraded')
})

test('a summary that names another owner or an unknown vault is refused', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Owner ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  expect(await code(store.applySummary(summary(row, { ownerUserId: crypto.randomUUID() })))).toBe('identity_mismatch')
  expect(await code(store.applySummary(summary({ ...row, id: crypto.randomUUID() })))).toBe('not_found')
  expect((await store.get(row.id))?.state).toBe('requested')
})

test('deleted vaults are tombstones: never resurrected by a later live summary', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Tomb ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  await store.applySummary(summary(row, { state: 'deleted', desiredGeneration: 3, appliedGeneration: 3 }))
  await store.applySummary(summary(row, { state: 'ready', desiredGeneration: 4, appliedGeneration: 4 }))
  expect((await store.get(row.id))?.state).toBe('deleted')
  expect((await store.list()).map((v) => v.id)).not.toContain(row.id)
})

test('advancing a generation is compare-and-set on the expected generation', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Gen ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  expect((await store.advanceGeneration(row.id, 1)).desiredGeneration).toBe(2)
  expect(await code(store.advanceGeneration(row.id, 1))).toBe('generation_conflict')
  expect(await code(store.advanceGeneration(crypto.randomUUID(), 1))).toBe('not_found')
})

test('invalid create input never writes', async () => {
  const owner = await human()
  for (const input of [
    createInput(' padded ', crypto.randomUUID(), owner),
    createInput('', crypto.randomUUID(), owner),
    createInput('ok', 'not-a-uuid', owner),
    createInput('x'.repeat(121), crypto.randomUUID(), owner),
  ])
    expect(await code(store.request(input))).toBe('invalid_request')
  expect(
    await db.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.ownerUserId, owner))
  ).toHaveLength(0)
})

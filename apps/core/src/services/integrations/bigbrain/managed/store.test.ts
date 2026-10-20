import { afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainHostReceipt,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainOperations, managedBigbrainVaults, users } from '../../../../db'
import { managedVaultOperations } from './operations'
import { ManagedVaultStoreError, managedVaultStore as store, type ManagedVault } from './store'

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
const recipe = (vaultId: string) => ({
  origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
})
const createInput = (displayName: string, requestId: string, ownerUserId: string) => {
  const vaultId = crypto.randomUUID()
  return {
    vaultId,
    requestId,
    displayName,
    ownerUserId,
    ownerHandle: 'ada',
    ownerDisplay: 'Ada',
    actorUserId: ownerUserId,
    recipe: recipe(vaultId),
  }
}
async function refusal(promise: Promise<unknown>): Promise<ManagedVaultStoreError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedVaultStoreError)
    return error as ManagedVaultStoreError
  }
  throw new Error('expected a refusal')
}
const receipt = (row: ManagedVault, patch: Partial<ManagedBigbrainHostReceipt> = {}): ManagedBigbrainHostReceipt => ({
  receiptId: crypto.randomUUID(),
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  vaultId: row.id,
  hostEpoch: 1,
  generation: row.desiredGeneration,
  upstreamVaultId: row.upstreamVaultId ?? '33333333-3333-4333-8333-333333333333',
  displayName: row.displayName,
  state: 'ready',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  localPort: null,
  origin: row.origin,
  readAccess: 'active',
  ...patch,
})
async function readyVault(name = `Vault ${crypto.randomUUID()}`) {
  const owner = await human()
  const row = await store.request(createInput(name, crypto.randomUUID(), owner))
  return store.applyReceipt(receipt(row))
}

test('two vaults and a retried create retain independent identities; create is a pending host action', async () => {
  const owner = await human()
  const requestA = crypto.randomUUID()
  const inputA = createInput(`Research ${requestA}`, requestA, owner)
  const a = await store.request(inputA)
  const b = await store.request(createInput(`Design ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  expect(a.id).not.toBe(b.id)
  expect((await store.request(inputA)).id).toBe(a.id)
  expect(a).toMatchObject({
    state: 'provisioning',
    desiredGeneration: 1,
    appliedGeneration: 0,
    desiredAction: 'create',
    operationRequestId: requestA,
    origin: inputA.recipe.origin,
  })
  expect(a.nextAttemptAt).not.toBeNull()
  expect(
    await db.select().from(managedBigbrainOperations).where(eq(managedBigbrainOperations.requestId, requestA))
  ).toHaveLength(1)
})

test('a replayed create ID with a different body conflicts; a live name cannot be reused', async () => {
  const owner = await human()
  const requestId = crypto.randomUUID()
  const input = createInput(`Original ${requestId}`, requestId, owner)
  await store.request(input)
  expect((await refusal(store.request({ ...input, displayName: `Other ${requestId}` }))).code).toBe('request_conflict')
  expect((await refusal(store.request(createInput(input.displayName, crypto.randomUUID(), owner)))).code).toBe(
    'name_conflict'
  )
})

test('receipts apply monotonically: the desired generation completes the pending action, older ones are ignored', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Sync ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  const ready = await store.applyReceipt(receipt(row))
  expect(ready).toMatchObject({
    state: 'ready',
    readAccess: 'active',
    appliedGeneration: 1,
    desiredAction: null,
    nextAttemptAt: null,
    hostDisplayName: row.displayName,
  })
  const renamed = await store.requestOperation(row.id, {
    action: 'rename',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    displayName: `Renamed ${crypto.randomUUID()}`,
  })
  expect(renamed).toMatchObject({ desiredGeneration: 2, desiredAction: 'rename' })
  // A late generation-1 status changes nothing about the pending rename.
  expect(await store.applyReceipt(receipt(ready, { generation: 1, state: 'degraded' }))).toMatchObject({
    desiredAction: 'rename',
    desiredGeneration: 2,
  })
  expect(await store.applyReceipt(receipt(renamed, { generation: 2, displayName: renamed.displayName }))).toMatchObject(
    {
      appliedGeneration: 2,
      desiredAction: null,
      hostDisplayName: renamed.displayName,
    }
  )
})

test('operations are fenced on the desired generation and replay by request ID', async () => {
  const row = await readyVault()
  const requestId = crypto.randomUUID()
  const revoke = { action: 'read-revoke' as const, requestId, expectedGeneration: 1 }
  const revoked = await store.requestOperation(row.id, revoke)
  expect(revoked).toMatchObject({ readAccess: 'revoked', desiredAction: 'read-revoke', readMaterial: null })
  expect((await store.requestOperation(row.id, revoke)).desiredGeneration).toBe(2)
  expect((await refusal(store.requestOperation(row.id, { ...revoke, action: 'read-reconnect' }))).code).toBe(
    'request_conflict'
  )
  const stale = await refusal(
    store.requestOperation(row.id, { action: 'read-reconnect', requestId: crypto.randomUUID(), expectedGeneration: 1 })
  )
  expect([stale.code, stale.currentGeneration]).toEqual(['generation_conflict', 2])
  // Pending intent wins over an older host state until the host reaches the generation.
  expect((await store.applyReceipt(receipt(revoked, { generation: 1 }))).readAccess).toBe('revoked')
})

test('a delete replaces any pending action; the tombstone is final and never resurrected by a receipt', async () => {
  const row = await readyVault()
  await store.requestOperation(row.id, { action: 'read-revoke', requestId: crypto.randomUUID(), expectedGeneration: 1 })
  const deleting = await store.requestOperation(row.id, {
    action: 'delete',
    requestId: crypto.randomUUID(),
    expectedGeneration: 2,
  })
  expect(deleting).toMatchObject({ state: 'deleting', desiredAction: 'delete', desiredGeneration: 3 })
  await store.applyReceipt(receipt(deleting, { generation: 3, state: 'deleted', readAccess: 'revoked' }))
  expect((await store.get(row.id))?.state).toBe('deleted')
  await store.applyReceipt(receipt(deleting, { generation: 9, state: 'ready' }))
  expect((await store.get(row.id))?.state).toBe('deleted')
  expect((await store.list()).map((v) => v.id)).not.toContain(row.id)
  expect(
    (
      await refusal(
        store.requestOperation(row.id, { action: 'delete', requestId: crypto.randomUUID(), expectedGeneration: 3 })
      )
    ).code
  ).toBe('not_found')
})

test('a newer receipt generation (restored host) is adopted read-revoked; another upstream identity is refused', async () => {
  const row = await readyVault()
  const adopted = await store.applyReceipt(receipt(row, { generation: 5, readAccess: 'revoked' }))
  expect(adopted).toMatchObject({
    desiredGeneration: 5,
    appliedGeneration: 5,
    readAccess: 'revoked',
    desiredAction: null,
  })
  expect(
    (await refusal(store.applyReceipt(receipt(adopted, { generation: 6, upstreamVaultId: crypto.randomUUID() })))).code
  ).toBe('identity_mismatch')
})

test('failures back off when retryable and pause otherwise until a retry re-arms the same operation', async () => {
  const owner = await human()
  const row = await store.request(createInput(`Fail ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  const now = new Date('2026-10-20T12:00:00Z')
  const first = await store.recordFailure(row.id, row.operationRequestId!, { code: 'busy', retryable: true, now })
  expect(first).toMatchObject({ attempts: 1, lastErrorCode: 'busy', retryable: true })
  expect(first!.nextAttemptAt!.getTime() - now.getTime()).toBe(5_000)
  const second = await store.recordFailure(row.id, row.operationRequestId!, { code: 'busy', retryable: true, now })
  expect(second!.nextAttemptAt!.getTime() - now.getTime()).toBe(30_000)
  // A failure for another (superseded) request changes nothing.
  expect(
    (await store.recordFailure(row.id, crypto.randomUUID(), { code: 'operation_failed', retryable: false, now }))!
      .attempts
  ).toBe(2)
  const failed = await store.recordFailure(row.id, row.operationRequestId!, {
    code: 'storage_unavailable',
    retryable: false,
    now,
  })
  expect(failed).toMatchObject({ state: 'failed', retryable: false, nextAttemptAt: null, desiredAction: 'create' })
  expect(await store.due(new Date('2030-01-01T00:00:00Z'), 10)).not.toContainEqual(
    expect.objectContaining({ id: row.id })
  )
  const retry = { requestId: crypto.randomUUID(), expectedGeneration: 1 }
  const rearmed = await store.retry(row.id, retry)
  expect(rearmed).toMatchObject({
    state: 'provisioning',
    attempts: 0,
    desiredAction: 'create',
    operationRequestId: row.operationRequestId,
  })
  expect((await store.retry(row.id, retry)).id).toBe(row.id)
  expect((await store.due(new Date(Date.now() + 1000), 50)).map((v) => v.id)).toContain(row.id)
})

test('owner-link windows are immutable per request and expire after an hour', async () => {
  const row = await readyVault()
  const requestId = crypto.randomUUID()
  const now = new Date('2026-10-20T12:00:00.500Z')
  const first = await managedVaultOperations.openInviteWindow(requestId, row.id, 1, now)
  expect(first).toEqual({ status: 'current', issuedAt: '2026-10-20T12:00:00Z', expiresAt: '2026-10-20T13:00:00Z' })
  expect(await managedVaultOperations.openInviteWindow(requestId, row.id, 1, new Date(now.getTime() + 60_000))).toEqual(
    first
  )
  expect(
    await managedVaultOperations.openInviteWindow(requestId, row.id, 1, new Date(now.getTime() + 3_600_000))
  ).toEqual({
    status: 'expired',
  })
  expect(await managedVaultOperations.openInviteWindow(requestId, row.id, 2, now)).toEqual({ status: 'conflict' })
})

test('invalid input never writes', async () => {
  const owner = await human()
  for (const input of [
    createInput(' padded ', crypto.randomUUID(), owner),
    createInput('', crypto.randomUUID(), owner),
    createInput('ok', 'not-a-uuid', owner),
    { ...createInput('ok', crypto.randomUUID(), owner), ownerHandle: 'ficus-reader!' },
  ])
    expect((await refusal(store.request(input))).code).toBe('invalid_request')
  expect(
    await db.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.ownerUserId, owner))
  ).toHaveLength(0)
})

test('a new vault whose 12-hex short id is taken by any vault, even a deleted one, is refused before anything is written', async () => {
  const owner = await human()
  const existing = await store.request(createInput(`Old ${crypto.randomUUID()}`, crypto.randomUUID(), owner))
  await db.update(managedBigbrainVaults).set({ state: 'deleted' }).where(eq(managedBigbrainVaults.id, existing.id))
  // Same first 12 hex characters (8-4 of the UUID), different vault.
  const clash = `${existing.id.slice(0, 13)}-4abc-8abc-${crypto.randomUUID().slice(-12)}`
  const requestId = crypto.randomUUID()
  const input = { ...createInput(`New ${requestId}`, requestId, owner), vaultId: clash, recipe: recipe(clash) }
  expect((await refusal(store.request(input))).code).toBe('short_id_conflict')
  expect(await store.get(clash)).toBeNull()
  expect(
    await db.select().from(managedBigbrainOperations).where(eq(managedBigbrainOperations.requestId, requestId))
  ).toHaveLength(0)
  // A fresh UUID for the same request goes through.
  const fresh = crypto.randomUUID()
  expect((await store.request({ ...input, vaultId: fresh, recipe: recipe(fresh) })).id).toBe(fresh)
})

import { afterEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainHostReceipt,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults, users } from '../../../../db'
import { ManagedHostError, type ManagedHostCall } from './host-client'
import { reconcileNext, sweepManagedVaults, type ManagedReconcilerDeps } from './reconciler'
import { managedVaultStore as store } from './store'

const owners: string[] = []
afterEach(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.ownerUserId, owners))
  await db.delete(users).where(inArray(users.id, owners.splice(0)))
})
const host: ManagedBigbrainInstalledHost = {
  contractVersion: 1,
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  hostEpoch: 2,
  hostState: 'active',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  zone: 'example.com',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  effect: null,
}
const origin = (id: string) => `https://bb-${id.replaceAll('-', '')}.example.com`
const UPSTREAM = '33333333-3333-4333-8333-333333333333'

/** A fake helper keeping host receipts in memory, plus a fake Platform DNS. */
function fakeHost() {
  const receipts = new Map<string, ManagedBigbrainHostReceipt>()
  const calls: string[] = []
  const dns: string[] = []
  let fail: { code: ManagedHostError['code']; retryable: boolean } | null = null
  const receiptFor = (vaultId: string, patch: Partial<ManagedBigbrainHostReceipt>): ManagedBigbrainHostReceipt => ({
    receiptId: crypto.randomUUID(),
    tenantId: host.tenantId,
    physicalHostBinding: host.physicalHostBinding,
    vaultId,
    hostEpoch: host.hostEpoch,
    generation: 1,
    upstreamVaultId: UPSTREAM,
    displayName: 'x',
    state: 'ready',
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    artifactDigest: host.artifactDigest,
    localPort: null,
    origin: origin(vaultId),
    readAccess: 'active',
    ...receipts.get(vaultId),
    ...patch,
  })
  const ok = (action: string, receipt: ManagedBigbrainHostReceipt) => ({
    contractVersion: 1 as const,
    requestId: crypto.randomUUID(),
    ok: true as const,
    action,
    physicalHostBinding: host.physicalHostBinding,
    receipt,
  })
  const deps: ManagedReconcilerDeps = {
    host: () => host,
    hostClient: {
      call: (async (_host: unknown, requestId: string, call: ManagedHostCall) => {
        calls.push(`${call.action}:${'vaultId' in call ? call.vaultId.slice(0, 4) : ''}:${requestId.slice(0, 4)}`)
        if (fail) {
          const f = fail
          fail = null
          throw new ManagedHostError(f.code, f.retryable)
        }
        if (call.action === 'status') {
          const r = receipts.get(call.vaultId)
          if (!r) throw new ManagedHostError('not_found', false)
          return ok('status', r)
        }
        if (call.action === 'create') {
          const r = receiptFor(call.vaultId, { generation: 1, displayName: call.displayName, origin: call.origin })
          receipts.set(call.vaultId, r)
          return ok('create', r)
        }
        if (call.action === 'rename' || call.action === 'read-revoke' || call.action === 'read-reconnect') {
          const r = receiptFor(call.vaultId, {
            generation: call.generation,
            ...(call.action === 'rename' ? { displayName: call.displayName } : {}),
            ...(call.action === 'read-revoke' ? { readAccess: 'revoked' as const } : {}),
            ...(call.action === 'read-reconnect' ? { readAccess: 'active' as const } : {}),
          })
          receipts.set(call.vaultId, r)
          return ok(call.action, r)
        }
        if (call.action === 'delete') {
          const current = receipts.get(call.vaultId)!
          if (call.confirmedName !== current.displayName || call.expectedGeneration !== current.generation)
            throw new ManagedHostError('identity_mismatch', false)
          const r = receiptFor(call.vaultId, { generation: call.generation, state: 'deleted', readAccess: 'revoked' })
          receipts.set(call.vaultId, r)
          return ok('delete', r)
        }
        throw new Error(`unexpected ${call.action}`)
      }) as never,
    },
    platform: {
      ensureDns: (async (vaultId: string, expected: string) => {
        dns.push(`put:${vaultId.slice(0, 4)}`)
        if (expected !== origin(vaultId)) throw new Error('bad origin')
        return {} as never
      }) as never,
      deleteDns: async (vaultId: string) => void dns.push(`delete:${vaultId.slice(0, 4)}`),
    },
  }
  return { deps, receipts, calls, dns, failNext: (f: typeof fail) => (fail = f), receiptFor }
}

async function requested(name = `Vault ${crypto.randomUUID()}`) {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  owners.push(user!.id)
  const vaultId = crypto.randomUUID()
  return store.request({
    vaultId,
    requestId: crypto.randomUUID(),
    displayName: name,
    ownerUserId: user!.id,
    ownerHandle: 'ada',
    ownerDisplay: 'Ada',
    actorUserId: user!.id,
    recipe: {
      origin: origin(vaultId),
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: host.artifactDigest,
    },
  })
}
const drain = async (deps: ManagedReconcilerDeps) => {
  const outcomes: string[] = []
  for (let i = 0; i < 10; i++) {
    const outcome = await reconcileNext({ ...deps, now: () => new Date(Date.now() + 3_600_000) })
    if (outcome === 'idle') break
    outcomes.push(outcome)
  }
  return outcomes
}

test('a pending create gets its exact DNS record first, then the host create with the recorded recipe', async () => {
  const f = fakeHost()
  const row = await requested()
  expect(await drain(f.deps)).toEqual(['applied'])
  expect(f.dns).toEqual([`put:${row.id.slice(0, 4)}`])
  expect(f.calls).toEqual([`create:${row.id.slice(0, 4)}:${row.operationRequestId!.slice(0, 4)}`])
  expect(await store.get(row.id)).toMatchObject({
    state: 'ready',
    readAccess: 'active',
    appliedGeneration: 1,
    desiredAction: null,
    upstreamVaultId: UPSTREAM,
    hostDisplayName: row.displayName,
  })
})

test('retryable failures back off with the same request; terminal ones mark the create failed until retry', async () => {
  const f = fakeHost()
  const row = await requested()
  f.failNext({ code: 'busy', retryable: true })
  expect(await reconcileNext({ ...f.deps, now: () => new Date(Date.now() + 1000) })).toBe('retrying')
  expect(await store.get(row.id)).toMatchObject({ attempts: 1, lastErrorCode: 'busy', retryable: true })
  f.failNext({ code: 'storage_unavailable', retryable: false })
  expect(await reconcileNext({ ...f.deps, now: () => new Date(Date.now() + 3_600_000) })).toBe('failed')
  expect(await store.get(row.id)).toMatchObject({ state: 'failed', retryable: false, nextAttemptAt: null })
  expect(await drain(f.deps)).toEqual([])
  await store.retry(row.id, { requestId: crypto.randomUUID(), expectedGeneration: 1 })
  expect(await drain(f.deps)).toEqual(['applied'])
  // Every attempt replayed the same request ID: the host never sees a second identity.
  expect(new Set(f.calls.map((c) => c.split(':')[2])).size).toBe(1)
})

test('rename and read revoke/reconnect are sent fenced on the generation; the host receipt completes them', async () => {
  const f = fakeHost()
  const row = await requested()
  await drain(f.deps)
  await store.requestOperation(row.id, {
    action: 'rename',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    displayName: `Renamed ${crypto.randomUUID()}`,
  })
  await drain(f.deps)
  const renamed = (await store.get(row.id))!
  expect(renamed).toMatchObject({ appliedGeneration: 2, desiredAction: null, hostDisplayName: renamed.displayName })
  await store.requestOperation(row.id, { action: 'read-revoke', requestId: crypto.randomUUID(), expectedGeneration: 2 })
  await drain(f.deps)
  expect(await store.get(row.id)).toMatchObject({ readAccess: 'revoked', appliedGeneration: 3 })
})

test('delete is fenced on the host generation and name, removes DNS after the host, and tombstones', async () => {
  const f = fakeHost()
  const row = await requested()
  await drain(f.deps)
  await store.requestOperation(row.id, { action: 'delete', requestId: crypto.randomUUID(), expectedGeneration: 1 })
  expect(await drain(f.deps)).toEqual(['deleted'])
  expect(f.calls.map((c) => c.split(':')[0])).toEqual(['create', 'status', 'delete'])
  expect(f.dns).toEqual([`put:${row.id.slice(0, 4)}`, `delete:${row.id.slice(0, 4)}`])
  expect((await store.get(row.id))?.state).toBe('deleted')
})

test('deleting a vault the host never had just tombstones it and removes DNS', async () => {
  const f = fakeHost()
  const row = await requested()
  await store.requestOperation(row.id, { action: 'delete', requestId: crypto.randomUUID(), expectedGeneration: 1 })
  expect(await drain(f.deps)).toEqual(['deleted'])
  expect(f.calls.map((c) => c.split(':')[0])).toEqual(['status'])
  expect((await store.get(row.id))?.state).toBe('deleted')
})

test('the status sweep adopts a restored host: newer generation read-revoked, and Core wins on name and deletion', async () => {
  const f = fakeHost()
  const kept = await requested()
  const tombstoned = await requested()
  const lost = await requested()
  await drain(f.deps)
  // Core deleted `tombstoned` after the backup; `lost` was created after it.
  await store.requestOperation(tombstoned.id, {
    action: 'delete',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
  })
  await drain(f.deps)
  // The host is rebuilt from an older backup: everything archived comes back at gen+1, revoked.
  f.receipts.set(kept.id, f.receiptFor(kept.id, { generation: 2, readAccess: 'revoked', displayName: 'Old name' }))
  f.receipts.set(tombstoned.id, f.receiptFor(tombstoned.id, { generation: 2, readAccess: 'revoked', state: 'ready' }))
  f.receipts.delete(lost.id)
  const report = await sweepManagedVaults(f.deps)
  expect(report[kept.id]).toBe('rename_scheduled')
  expect(report[tombstoned.id]).toBe('delete_scheduled')
  expect(report[lost.id]).toBe('missing')
  expect(await store.get(kept.id)).toMatchObject({
    desiredGeneration: 3,
    appliedGeneration: 2,
    readAccess: 'revoked',
    desiredAction: 'rename',
  })
  expect(await store.get(lost.id)).toMatchObject({
    state: 'failed',
    lastErrorCode: 'storage_unavailable',
    retryable: false,
  })
  await drain(f.deps)
  expect(f.receipts.get(tombstoned.id)?.state).toBe('deleted')
  expect((await store.get(tombstoned.id))?.state).toBe('deleted')
  expect(f.receipts.get(kept.id)?.displayName).toBe(kept.displayName)
  // Read access stays revoked until a human reconnects it explicitly.
  expect((await store.get(kept.id))?.readAccess).toBe('revoked')
})

test('nothing runs while managed BigBrain is unavailable', async () => {
  const f = fakeHost()
  await requested()
  expect(await reconcileNext({ ...f.deps, host: () => null, now: () => new Date(Date.now() + 1000) })).toBe(
    'unavailable'
  )
  expect(await sweepManagedVaults({ ...f.deps, host: () => null })).toEqual({})
  expect(f.calls).toEqual([])
})

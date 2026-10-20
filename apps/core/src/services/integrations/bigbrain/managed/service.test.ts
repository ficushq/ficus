import { afterAll, afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults, users } from '../../../../db'
import { User } from '../../../../entities/User'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../../../test-utils/rbac'
import type { Identity } from '../../../rbac/permissions'
import { ManagedHostError, type ManagedHostCall } from './host-client'
import { createManagedVaultService, managedVaultErrorResponse } from './service'
import { managedVaultStore } from './store'

const PREFIX = `mbb-svc-${crypto.randomUUID().slice(0, 8)}`
const userIds: string[] = []
// A tenant holds at most MANAGED_BIGBRAIN_MAX_VAULTS live vaults: each test starts empty.
afterEach(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.ownerUserId, userIds))
})
afterAll(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.ownerUserId, userIds))
  await cleanupTestRbac(PREFIX)
})
async function human(permissions: string[], displayName = 'Ada Lovelace'): Promise<Identity & { userId: string }> {
  const user = await createTestUser({ prefix: PREFIX, displayName })
  userIds.push(user.id)
  if (permissions.length) {
    const role = await createTestRole({ prefix: PREFIX, permissions })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
  }
  return { type: 'user', userId: user.id }
}
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

function service(options: { enabled?: boolean; available?: boolean; maxVaults?: number } = {}) {
  const calls: { action: string; body: ManagedHostCall; requestId: string }[] = []
  const fences: string[] = []
  const hooks: { invite?: () => Promise<void>; fail?: ManagedHostError } = {}
  const svc = createManagedVaultService({
    hostClient: {
      call: (async (_host: unknown, requestId: string, body: ManagedHostCall) => {
        calls.push({ action: body.action, body, requestId })
        if (hooks.fail) throw hooks.fail
        await hooks.invite?.()
        const vaultId = (body as { vaultId: string }).vaultId
        return {
          contractVersion: 1,
          requestId,
          ok: true,
          action: 'owner-invite',
          physicalHostBinding: host.physicalHostBinding,
          invite: {
            inviteUrl: `https://bb-${vaultId.replaceAll('-', '')}.example.com/invite#${'A'.repeat(43)}`,
            expiresAt: (body as { expiresAt: string }).expiresAt,
          },
        }
      }) as never,
    },
    host: () =>
      options.available === false ? null : { ...host, limits: { ...host.limits, maxVaults: options.maxVaults ?? 2 } },
    disableConnection: async (id) => void fences.push(`disable:${id}`),
    usage: async () => ({ squads: [{ id: 'squad-1', name: 'Research squad' }] }),
    isEnabled: async () => options.enabled ?? true,
    available: () => ({ available: options.available ?? true }),
  })
  return { svc, calls, fences, hooks }
}
async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const response = managedVaultErrorResponse(error)
    expect(response).not.toBeNull()
    return String(response!.body.code)
  }
  throw new Error('expected a refusal')
}
const create = (displayName: string, requestId = crypto.randomUUID()) => ({
  requestId,
  displayName,
  ownerHandle: 'ada',
})
/** Pretend the reconciler created it on the host. */
async function makeReady(vaultId: string) {
  const row = (await managedVaultStore.get(vaultId))!
  return managedVaultStore.applyReceipt({
    receiptId: crypto.randomUUID(),
    tenantId: host.tenantId,
    physicalHostBinding: host.physicalHostBinding,
    vaultId,
    hostEpoch: 2,
    generation: row.desiredGeneration,
    upstreamVaultId: '33333333-3333-4333-8333-333333333333',
    displayName: row.displayName,
    state: 'ready',
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    artifactDigest: host.artifactDigest,
    localPort: null,
    origin: row.origin,
    readAccess: 'active',
  })
}

test('non-humans, missing permission, a disabled integration or unavailable host never record anything', async () => {
  const admin = await human(['*'])
  const reader = await human(['integrations:read:bigbrain'])
  const { svc, calls } = service()
  const automation: Identity = { type: 'system', systemTokenId: 'x', name: 'x', scopes: ['*'] }
  const delegated: Identity = { type: 'agent', agentId: crypto.randomUUID(), squadId: null, userId: admin.userId }
  for (const identity of [automation, delegated, undefined])
    expect(await code(svc.create(identity, create(`Denied ${crypto.randomUUID()}`)))).toBe('human_required')
  expect(await code(svc.create(reader, create(`Denied ${crypto.randomUUID()}`)))).toBe('permission_required')
  expect(await code(service({ enabled: false }).svc.create(admin, create(`Off ${crypto.randomUUID()}`)))).toBe(
    'integration_disabled'
  )
  expect(await code(service({ available: false }).svc.create(admin, create(`Down ${crypto.randomUUID()}`)))).toBe(
    'unavailable'
  )
  expect(await code(svc.create(admin, { ...create('Bad'), ownerHandle: 'ficus-reader' }))).toBe('invalid_request')
  expect(calls).toEqual([])
  expect(
    await db.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.ownerUserId, admin.userId))
  ).toHaveLength(0)
})

test('create records a pending local host create with the installed zone origin; no Platform call; replays', async () => {
  const owner = await human(['integrations:write:bigbrain', 'integrations:read:bigbrain'], 'Ada Lovelace')
  const { svc, calls } = service()
  const input = create(`Research ${crypto.randomUUID()}`)
  const created = await svc.create(owner, input)
  expect(created).toMatchObject({
    state: 'provisioning',
    pendingAction: 'create',
    isOwner: true,
    ownerUserId: owner.userId,
  })
  expect(created.origin).toBe(`https://bb-${created.vaultId.replaceAll('-', '')}.example.com`)
  const row = (await managedVaultStore.get(created.vaultId))!
  expect(row).toMatchObject({
    ownerHandle: 'ada',
    ownerDisplay: 'Ada Lovelace',
    createRecipe: { limits: { maxVaults: 2 } },
  })
  expect(calls).toEqual([])
  expect((await svc.create(owner, input)).vaultId).toBe(created.vaultId)
  expect(await code(svc.create(owner, { ...input, displayName: 'Different' }))).toBe('request_conflict')
  expect(await code(svc.create(owner, create(input.displayName)))).toBe('name_conflict')
})

test('create refuses beyond the vault limit, but still answers a replay', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const { svc } = service({ maxVaults: 1 })
  const existing = await managedVaultStore.list()
  for (const row of existing)
    await db.update(managedBigbrainVaults).set({ state: 'deleted' }).where(eq(managedBigbrainVaults.id, row.id))
  const input = create(`Only ${crypto.randomUUID()}`)
  await svc.create(owner, input)
  const refusal = await svc.create(owner, create(`Second ${crypto.randomUUID()}`)).catch((e) => e)
  expect(managedVaultErrorResponse(refusal)).toEqual({ status: 429, body: { code: 'capacity' } })
  expect((await svc.create(owner, input)).displayName).toBe(input.displayName)
})

test('rename, revoke and delete are recorded with generation fences; revoke and delete fence Core access first', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const { svc, calls, fences } = service()
  const created = await svc.create(owner, create(`Fence ${crypto.randomUUID()}`))
  const stale = await svc
    .rename(owner, created.vaultId, { requestId: crypto.randomUUID(), expectedGeneration: 1, displayName: 'X' })
    .catch((e) => e)
  // Not ready yet: the create is still pending on the host.
  expect(managedVaultErrorResponse(stale)?.body).toMatchObject({ code: 'generation_conflict', currentGeneration: 1 })
  const ready = await makeReady(created.vaultId)
  const renamed = await svc.rename(owner, created.vaultId, {
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    displayName: `Renamed ${crypto.randomUUID()}`,
  })
  expect(renamed).toMatchObject({ desiredGeneration: 2, pendingAction: 'rename' })
  await makeReady(created.vaultId)
  await db.update(managedBigbrainVaults).set({ connectionId: null }).where(eq(managedBigbrainVaults.id, ready.id))
  const revoked = await svc.setReadAccess(owner, created.vaultId, {
    requestId: crypto.randomUUID(),
    expectedGeneration: 2,
    action: 'revoke',
  })
  expect(revoked).toMatchObject({ readAccess: 'revoked', pendingAction: 'read-revoke' })
  const confirm = {
    requestId: crypto.randomUUID(),
    expectedGeneration: 3,
    confirmedVaultId: created.vaultId,
    confirmedName: renamed.displayName,
  }
  expect(await code(svc.delete(owner, created.vaultId, { ...confirm, confirmedName: 'Other' }))).toBe(
    'confirmation_mismatch'
  )
  expect(await code(svc.delete(owner, created.vaultId, { ...confirm, confirmedVaultId: crypto.randomUUID() }))).toBe(
    'confirmation_mismatch'
  )
  expect(await code(svc.delete(owner, created.vaultId, { ...confirm, expectedGeneration: 2 }))).toBe(
    'generation_conflict'
  )
  // Delete replaces the still-pending revoke.
  expect(await svc.delete(owner, created.vaultId, confirm)).toMatchObject({
    state: 'deleting',
    pendingAction: 'delete',
  })
  expect(calls).toEqual([])
  void fences
})

test('owner links: only the recorded owner, an immutable window per request, re-verified after the host call', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const admin = await human(['*'])
  const { svc, calls, hooks } = service()
  const created = await svc.create(owner, create(`Invite ${crypto.randomUUID()}`))
  const fence = { requestId: crypto.randomUUID(), expectedGeneration: 1 }
  expect(await code(svc.ownerInvite(owner, created.vaultId, fence))).toBe('generation_conflict')
  await makeReady(created.vaultId)
  expect(await code(svc.ownerInvite(admin, created.vaultId, fence))).toBe('owner_required')
  expect(calls).toEqual([])
  const first = await svc.ownerInvite(owner, created.vaultId, fence)
  expect(first.inviteUrl).toContain('/invite#')
  const replay = await svc.ownerInvite(owner, created.vaultId, fence)
  expect(calls.map((c) => [c.action, c.requestId])).toEqual([
    ['owner-invite', fence.requestId],
    ['owner-invite', fence.requestId],
  ])
  // The same request always carries the same immutable one-hour window.
  expect(calls[0]!.body).toEqual(calls[1]!.body)
  expect(replay.expiresAt).toBe(first.expiresAt)
  const window = calls[0]!.body as { issuedAt: string; expiresAt: string }
  expect(Date.parse(window.expiresAt) - Date.parse(window.issuedAt)).toBe(3_600_000)
  // Busy helper: retryable 503.
  hooks.fail = new ManagedHostError('busy', true)
  const busy = managedVaultErrorResponse(
    await svc.ownerInvite(owner, created.vaultId, { ...fence, requestId: crypto.randomUUID() }).catch((e) => e)
  )
  expect(busy).toEqual({ status: 503, body: { code: 'busy', retryable: true } })
  hooks.fail = undefined
  // Owner disabled while the host minted the link: the result is withheld.
  hooks.invite = async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.userId))
  }
  expect(await code(svc.ownerInvite(owner, created.vaultId, { ...fence, requestId: crypto.randomUUID() }))).toBe(
    'enabled_human_required'
  )
})

test('an expired owner-link window is refused rather than minting a new link', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const base = service()
  const created = await base.svc.create(owner, create(`Expiry ${crypto.randomUUID()}`))
  await makeReady(created.vaultId)
  const fence = { requestId: crypto.randomUUID(), expectedGeneration: 1 }
  await base.svc.ownerInvite(owner, created.vaultId, fence)
  const later = createManagedVaultService({
    hostClient: { call: (async () => ({})) as never },
    host: () => host,
    disableConnection: async () => {},
    usage: async () => ({ squads: [] }),
    isEnabled: async () => true,
    available: () => ({ available: true }),
    now: () => new Date(Date.now() + 2 * 3_600_000),
  })
  expect(await code(later.ownerInvite(owner, created.vaultId, fence))).toBe('invite_expired')
})

test('deleting an owner never fails: their live vault keeps serving without an owner; tombstones never block', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const formerOwner = await human(['integrations:write:bigbrain'])
  const admin = await human(['*'])
  const { svc, calls } = service()
  const live = await svc.create(owner, create(`Owned ${crypto.randomUUID()}`))
  await makeReady(live.vaultId)
  const gone = await svc.create(formerOwner, create(`Gone ${crypto.randomUUID()}`))
  await makeReady(gone.vaultId)
  await svc.delete(formerOwner, gone.vaultId, {
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    confirmedVaultId: gone.vaultId,
    confirmedName: gone.displayName,
  })
  await managedVaultStore.finalizeTombstone(gone.vaultId)
  try {
    // Exactly the path DELETE /api/users/:id takes.
    await (await User.findById(formerOwner.userId))!.delete()
    await (await User.findById(owner.userId))!.delete()
    expect(await User.findById(owner.userId)).toBeNull()
    expect(await User.findById(formerOwner.userId)).toBeNull()
    const orphan = await svc.get(admin, live.vaultId)
    expect(orphan).toMatchObject({ ownerUserId: null, isOwner: false, state: 'ready' })
    // Nobody inherits owner authority: not an administrator, not automatically.
    expect(
      await code(svc.ownerInvite(admin, live.vaultId, { requestId: crypto.randomUUID(), expectedGeneration: 1 }))
    ).toBe('owner_required')
    expect(calls).toEqual([])
    // Other management continues, and the vault can still be deleted.
    expect(
      await svc.delete(admin, live.vaultId, {
        requestId: crypto.randomUUID(),
        expectedGeneration: 1,
        confirmedVaultId: live.vaultId,
        confirmedName: live.displayName,
      })
    ).toMatchObject({ pendingAction: 'delete' })
  } finally {
    await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.id, [live.vaultId, gone.vaultId]))
  }
})

test('concurrent creates never exceed the vault limit', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const { svc } = service({ maxVaults: 2 })
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => svc.create(owner, create(`Race ${i} ${crypto.randomUUID()}`)))
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  for (const r of results.filter((r) => r.status === 'rejected'))
    expect(managedVaultErrorResponse((r as PromiseRejectedResult).reason)).toEqual({
      status: 429,
      body: { code: 'capacity' },
    })
  expect(await managedVaultStore.list()).toHaveLength(2)
})

test('managers see affected squads; listing needs BigBrain read authority; refusals map to codes only', async () => {
  const reader = await human(['integrations:read:bigbrain'])
  const owner = await human(['integrations:write:bigbrain'])
  const { svc } = service()
  const created = await svc.create(owner, create(`Squads ${crypto.randomUUID()}`))
  await makeReady(created.vaultId)
  await db
    .update(managedBigbrainVaults)
    .set({ connectionId: null })
    .where(eq(managedBigbrainVaults.id, created.vaultId))
  expect((await svc.get(reader, created.vaultId)).assignedSquads).toEqual([])
  expect(await code(svc.list({ type: 'system', systemTokenId: 'x', name: 'x', scopes: ['*'] }))).toBe('forbidden')
  for (const [error, status] of [
    [new ManagedHostError('generation_conflict', false), 409],
    [new ManagedHostError('host_unreachable', true), 503],
    [new ManagedHostError('capacity', true), 429],
    [new ManagedHostError('invalid_response', false), 502],
  ] as const)
    expect(managedVaultErrorResponse(error)?.status).toBe(status)
  expect(managedVaultErrorResponse(new Error('raw'))).toBeNull()
})

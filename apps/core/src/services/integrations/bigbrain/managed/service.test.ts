import { afterAll, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT, type ManagedBigbrainVaultSummary } from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults, users } from '../../../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../../../test-utils/rbac'
import type { Identity } from '../../../rbac/permissions'
import { ManagedBigbrainPlatformError } from './platform-client'
import { ManagedVaultServiceError, createManagedVaultService, managedVaultErrorResponse } from './service'
import { managedVaultStore } from './store'

const PREFIX = `mbb-svc-${crypto.randomUUID().slice(0, 8)}`
const userIds: string[] = []
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

/** A Platform stand-in that records every call and keeps authoritative per-vault summaries. */
function fakePlatform() {
  const calls: string[] = []
  const summaries = new Map<string, ManagedBigbrainVaultSummary>()
  const bump = (vaultId: string, patch: Partial<ManagedBigbrainVaultSummary>) => {
    const current = summaries.get(vaultId)!
    const next = current.desiredGeneration + 1
    summaries.set(vaultId, {
      ...current,
      desiredGeneration: next,
      updatedAt: new Date(Date.now() + next).toISOString(),
      ...patch,
    })
  }
  const operation = (vaultId: string) => ({
    contractVersion: 1 as const,
    operationId: crypto.randomUUID(),
    vaultId,
    generation: summaries.get(vaultId)!.desiredGeneration,
    state: 'accepted' as const,
    code: null,
  })
  const platform = {
    calls,
    summaries,
    inviteHook: undefined as undefined | (() => Promise<void>),
    async listVaults() {
      return { items: [...summaries.values()] }
    },
    async getVault(vaultId: string) {
      calls.push(`get:${vaultId}`)
      return summaries.get(vaultId)!
    },
    async putVault(vaultId: string, input: { expectedGeneration: number; displayName: string; owner: unknown }) {
      calls.push(`put:${vaultId}:${input.expectedGeneration}:${JSON.stringify(input.owner)}`)
      if (input.expectedGeneration === 0)
        summaries.set(vaultId, {
          contractVersion: 1,
          vaultId,
          displayName: input.displayName,
          ownerUserId: (input.owner as { userId: string }).userId,
          state: 'provisioning',
          readAccess: 'pending',
          desiredGeneration: 1,
          appliedGeneration: 0,
          upstreamVaultId: null,
          upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
          origin: null,
          operationId: crypto.randomUUID(),
          lastErrorCode: null,
          retryable: false,
          updatedAt: new Date().toISOString(),
        })
      else bump(vaultId, { displayName: input.displayName })
      return operation(vaultId)
    },
    async retryVault(vaultId: string) {
      calls.push(`retry:${vaultId}`)
      return operation(vaultId)
    },
    async setReadAccess(vaultId: string, input: { action: string }) {
      calls.push(`read-access:${input.action}:${vaultId}`)
      bump(vaultId, { readAccess: input.action === 'revoke' ? 'revoked' : 'pending' })
      return operation(vaultId)
    },
    async deleteVault(vaultId: string) {
      calls.push(`delete:${vaultId}`)
      bump(vaultId, { state: 'deleting' })
      return operation(vaultId)
    },
    async createOwnerInvite(vaultId: string) {
      calls.push(`invite:${vaultId}`)
      await platform.inviteHook?.()
      return {
        inviteUrl: `https://bb-${vaultId.replaceAll('-', '')}.vaults.example.com/invite#${'A'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }
    },
  }
  return platform
}

function service(options: { enabled?: boolean; available?: boolean } = {}) {
  const platform = fakePlatform()
  const fences: string[] = []
  const svc = createManagedVaultService({
    platform: platform as never,
    disableConnection: async (id) => {
      fences.push(`disable:${id}`)
      platform.calls.push(`disable:${id}`)
    },
    isEnabled: async () => options.enabled ?? true,
    available: () => ({ available: options.available ?? true }),
  })
  return { svc, platform, fences }
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

test('non-humans, missing permission, a disabled integration or unavailable host never reach Platform', async () => {
  const admin = await human(['*'])
  const reader = await human(['integrations:read:bigbrain'])
  const { svc, platform } = service()
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
  expect(platform.calls).toEqual([])
})

test('create records the human owner once, returns provisioning (not ready), and replays idempotently', async () => {
  const owner = await human(['integrations:write:bigbrain', 'integrations:read:bigbrain'], 'Ada Lovelace')
  const { svc, platform } = service()
  const input = create(`Research ${crypto.randomUUID()}`)
  const created = await svc.create(owner, input)
  expect(created).toMatchObject({
    state: 'provisioning',
    readAccess: 'pending',
    isOwner: true,
    ownerUserId: owner.userId,
  })
  expect(platform.calls[0]).toBe(
    `put:${created.vaultId}:0:${JSON.stringify({ userId: owner.userId, handle: 'ada', display: 'Ada Lovelace' })}`
  )
  expect((await svc.create(owner, input)).vaultId).toBe(created.vaultId)
  expect(await code(svc.create(owner, { ...input, displayName: 'Different' }))).toBe('request_conflict')
  expect(await code(svc.create(owner, create(input.displayName)))).toBe('name_conflict')
})

test('rename is fenced by generation and resends the owner exactly as recorded', async () => {
  const owner = await human(['integrations:write:bigbrain'], 'Ada Lovelace')
  const { svc, platform } = service()
  const created = await svc.create(owner, create(`Rename ${crypto.randomUUID()}`))
  // The owner later changes their profile name: the recorded upstream owner is unchanged.
  await db.update(users).set({ displayName: 'Countess' }).where(eq(users.id, owner.userId))
  platform.calls.length = 0
  const stale = await svc
    .rename(owner, created.vaultId, { requestId: crypto.randomUUID(), expectedGeneration: 9, displayName: 'X' })
    .catch((e) => e)
  expect(stale).toBeInstanceOf(ManagedVaultServiceError)
  expect([stale.code, stale.currentGeneration]).toEqual(['generation_conflict', 1])
  expect(platform.calls).toEqual([])
  const renamed = await svc.rename(owner, created.vaultId, {
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    displayName: `Renamed ${crypto.randomUUID()}`,
  })
  expect(renamed.desiredGeneration).toBe(2)
  expect(platform.calls[0]).toContain(JSON.stringify({ userId: owner.userId, handle: 'ada', display: 'Ada Lovelace' }))
})

test('owner links: only the recorded owner, re-verified after the host call', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const admin = await human(['*'])
  const { svc, platform } = service()
  const created = await svc.create(owner, create(`Invite ${crypto.randomUUID()}`))
  platform.calls.length = 0
  const fence = { requestId: crypto.randomUUID(), expectedGeneration: 1 }
  expect(await code(svc.ownerInvite(admin, created.vaultId, fence))).toBe('owner_required')
  expect(platform.calls).toEqual([])
  expect((await svc.ownerInvite(owner, created.vaultId, fence)).inviteUrl).toContain('/invite#')
  // Owner disabled while the host minted the link: the result is withheld.
  platform.inviteHook = async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.userId))
  }
  expect(await code(svc.ownerInvite(owner, created.vaultId, { ...fence, requestId: crypto.randomUUID() }))).toBe(
    'enabled_human_required'
  )
})

test('revoke and delete fence Core access before Platform; delete needs the exact ID, name and generation', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const { svc, platform } = service()
  const created = await svc.create(owner, create(`Fence ${crypto.randomUUID()}`))
  platform.calls.length = 0
  await svc.setReadAccess(owner, created.vaultId, {
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    action: 'revoke',
  })
  expect(platform.calls.filter((c) => !c.startsWith('get:'))).toEqual([`read-access:revoke:${created.vaultId}`])
  expect((await managedVaultStore.get(created.vaultId))?.readMaterial).toBeNull()
  platform.calls.length = 0
  const confirm = {
    requestId: crypto.randomUUID(),
    expectedGeneration: 2,
    confirmedVaultId: created.vaultId,
    confirmedName: created.displayName,
  }
  for (const wrong of [
    { ...confirm, confirmedName: 'Other' },
    { ...confirm, confirmedVaultId: crypto.randomUUID() },
  ])
    expect(await code(svc.delete(owner, created.vaultId, wrong))).toBe('confirmation_mismatch')
  expect(await code(svc.delete(owner, created.vaultId, { ...confirm, expectedGeneration: 1 }))).toBe(
    'generation_conflict'
  )
  expect(platform.calls).toEqual([])
  const deleting = await svc.delete(owner, created.vaultId, confirm)
  expect(deleting.state).toBe('deleting')
  expect(platform.calls.filter((c) => !c.startsWith('get:'))).toEqual([`delete:${created.vaultId}`])
})

test('a bound read connection is disabled before the revoke reaches Platform', async () => {
  const owner = await human(['integrations:write:bigbrain'])
  const { svc, platform } = service()
  const created = await svc.create(owner, create(`Bound ${crypto.randomUUID()}`))
  const { integrationConnections } = await import('../../../../db')
  const connectionId = crypto.randomUUID()
  await db.insert(integrationConnections).values({
    id: connectionId,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: `Bound ${connectionId}`,
    configuration: {},
    credentialRef: `ref:${connectionId}`,
  })
  try {
    await db.update(managedBigbrainVaults).set({ connectionId }).where(eq(managedBigbrainVaults.id, created.vaultId))
    platform.calls.length = 0
    await svc.setReadAccess(owner, created.vaultId, {
      requestId: crypto.randomUUID(),
      expectedGeneration: 1,
      action: 'revoke',
    })
    expect(platform.calls.filter((c) => !c.startsWith('get:'))).toEqual([
      `disable:${connectionId}`,
      `read-access:revoke:${created.vaultId}`,
    ])
  } finally {
    await db
      .update(managedBigbrainVaults)
      .set({ connectionId: null })
      .where(eq(managedBigbrainVaults.id, created.vaultId))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
  }
})

test('listing needs BigBrain read authority; Platform refusals map to codes, never raw bodies', async () => {
  const reader = await human(['integrations:read:bigbrain'])
  const { svc } = service()
  expect(Array.isArray(await svc.list(reader))).toBe(true)
  expect(await code(svc.list({ type: 'system', systemTokenId: 'x', name: 'x', scopes: ['*'] }))).toBe('forbidden')
  for (const [error, status] of [
    [new ManagedBigbrainPlatformError('generation_conflict', false, 409), 409],
    [new ManagedBigbrainPlatformError('host_unreachable', true), 503],
    [new ManagedBigbrainPlatformError('capacity', true, 429), 429],
    [new ManagedBigbrainPlatformError('capability_stale', false, 403), 403],
    [new ManagedBigbrainPlatformError('invalid_response', false), 502],
  ] as const)
    expect(managedVaultErrorResponse(error)?.status).toBe(status)
  expect(managedVaultErrorResponse(new Error('raw'))).toBeNull()
})

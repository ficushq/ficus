import { afterAll, afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults, users } from '../../../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../../../test-utils/rbac'
import type { Identity } from '../../../rbac/permissions'
import { FixedWindowLimiter } from '../../../auth/device-auth-rate-limit'
import type { IntegrationAuditEvent } from '../../audit'
import { ManagedHostError, type ManagedHostCall } from './host-client'
import { MANAGED_VAULT_MEMBER_LIMITS } from './members'
import { createManagedVaultService, managedVaultErrorResponse } from './service'
import { managedVaultStore } from './store'

const PREFIX = `mbb-mem-${crypto.randomUUID().slice(0, 8)}`
const userIds: string[] = []
afterEach(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.createdByUserId, userIds))
})
afterAll(async () => {
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.createdByUserId, userIds))
  await cleanupTestRbac(PREFIX)
})
async function human(permissions: string[]): Promise<Identity & { userId: string }> {
  const user = await createTestUser({ prefix: PREFIX })
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
  tenantLabel: null,
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  effect: null,
}
const INVITE = 'c'.repeat(24)
const SECRET = 'S'.repeat(43)
const member = (handle: string, fields: object = {}) => ({
  handle,
  displayName: handle,
  role: 'member',
  access: 'write',
  status: 'active',
  createdAt: '2026-10-20T00:00:00.000Z',
  ...fields,
})

/** A host that answers like the controller would (the wire reply shape is the contract's). */
function service() {
  const calls: { body: ManagedHostCall; requestId: string }[] = []
  const audits: IntegrationAuditEvent[] = []
  const hooks: { reply?: (body: ManagedHostCall) => object; fail?: ManagedHostError; during?: () => Promise<void> } = {}
  const limiter = new FixedWindowLimiter()
  const svc = createManagedVaultService({
    audit: { record: async (event) => void audits.push(event) },
    memberLimiter: limiter,
    hostClient: {
      call: (async (_host: unknown, requestId: string, body: ManagedHostCall) => {
        calls.push({ body, requestId })
        if (hooks.fail) throw hooks.fail
        await hooks.during?.()
        const base = { contractVersion: 1, requestId, ok: true, physicalHostBinding: host.physicalHostBinding }
        const b = body as Record<string, string>
        const vaultId = b.vaultId!
        if (hooks.reply) return { ...base, action: body.action, vaultId, ...hooks.reply(body) }
        switch (body.action) {
          case 'member-list':
            return {
              ...base,
              action: body.action,
              vaultId,
              roster: {
                members: [
                  member('ficus', { role: 'owner', displayName: 'Ficus' }),
                  member('ficus-reader', { access: 'read', displayName: 'Ficus' }),
                  member('grace'),
                  member('removed', { status: 'removed' }),
                ],
                invites: [
                  { inviteId: INVITE, displayName: 'Lin', access: 'read', expiresAt: '2026-10-21T00:00:00.000Z' },
                ],
                membersTruncated: false,
                invitesTruncated: false,
              },
            }
          case 'member-invite':
            return {
              ...base,
              action: body.action,
              vaultId,
              invite: {
                inviteId: INVITE,
                inviteUrl: `https://bb-${vaultId.replaceAll('-', '')}.example.com/invite#${SECRET}`,
                displayName: b.displayName,
                access: b.access,
                expiresAt: '2026-10-21T00:00:00.000Z',
              },
            }
          case 'invite-cancel':
            return { ...base, action: body.action, vaultId, inviteId: b.inviteId }
          case 'member-set-access':
            return { ...base, action: body.action, vaultId, member: member(b.handle!, { access: b.access }) }
          case 'member-remove':
            return { ...base, action: body.action, vaultId, member: member(b.handle!, { status: 'removed' }) }
          default:
            throw new ManagedHostError('invalid_request', false)
        }
      }) as never,
    },
    host: () => host,
    disableConnection: async () => {},
    usage: async () => ({ squads: [] }),
    isEnabled: async () => true,
    available: () => ({ available: true }),
  })
  return { svc, calls, audits, hooks, limiter }
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
async function readyVault(svc: ReturnType<typeof service>['svc'], owner: Identity) {
  const created = await svc.create(owner, {
    requestId: crypto.randomUUID(),
    displayName: `Members ${crypto.randomUUID()}`,
  })
  const row = (await managedVaultStore.get(created.vaultId))!
  await managedVaultStore.applyReceipt({
    receiptId: crypto.randomUUID(),
    tenantId: host.tenantId,
    physicalHostBinding: host.physicalHostBinding,
    vaultId: row.id,
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
  return created.vaultId
}
const fence = (fields: object = {}) => ({ requestId: crypto.randomUUID(), expectedGeneration: 1, ...fields })

test('only a BigBrain manager sees or changes members; readers, agents and tokens never reach the host', async () => {
  const manager = await human(['integrations:write:bigbrain'])
  const reader = await human(['integrations:read:bigbrain'])
  const { svc, calls } = service()
  const vaultId = await readyVault(svc, manager)
  const automation: Identity = { type: 'system', systemTokenId: 'x', name: 'x', scopes: ['*'] }
  const delegated: Identity = { type: 'agent', agentId: crypto.randomUUID(), squadId: null, userId: manager.userId }
  for (const identity of [automation, delegated, undefined]) {
    expect(await code(svc.members(identity, vaultId))).toBe('human_required')
    expect(await code(svc.inviteMember(identity, vaultId, fence({ displayName: 'X', access: 'read' })))).toBe(
      'human_required'
    )
    expect(await code(svc.removeMember(identity, vaultId, 'grace', fence()))).toBe('human_required')
  }
  // Read-only BigBrain authority lists vaults, never their members.
  expect(await code(svc.members(reader, vaultId))).toBe('permission_required')
  expect(await code(svc.cancelInvite(reader, vaultId, INVITE, fence()))).toBe('permission_required')
  expect(await code(svc.setMemberAccess(reader, vaultId, 'grace', fence({ access: 'read' })))).toBe(
    'permission_required'
  )
  expect(calls).toEqual([])
  const roster = await svc.members(manager, vaultId)
  expect(roster.members.map((m) => [m.handle, m.system, m.editable])).toEqual([
    ['ficus', 'owner', false],
    ['ficus-reader', 'reader', false],
    ['grace', null, true],
    ['removed', null, false],
  ])
  expect(roster.invites).toHaveLength(1)
  expect(calls.map((c) => c.body)).toEqual([{ action: 'member-list', vaultId }])
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, manager.userId))
  expect(await code(svc.members(manager, vaultId))).toBe('enabled_human_required')
})

test('an invite returns its link once, is audited by member handle without the link, and is re-verified', async () => {
  const manager = await human(['integrations:write:bigbrain'])
  const { svc, calls, audits, hooks } = service()
  const vaultId = await readyVault(svc, manager)
  const input = fence({ displayName: 'Grace Hopper', access: 'write' })
  const invite = await svc.inviteMember(manager, vaultId, input)
  expect(invite).toEqual({
    inviteId: INVITE,
    inviteUrl: `https://bb-${vaultId.replaceAll('-', '')}.example.com/invite#${SECRET}`,
    displayName: 'Grace Hopper',
    access: 'write',
    expiresAt: '2026-10-21T00:00:00.000Z',
  })
  expect(calls).toEqual([
    {
      requestId: input.requestId,
      body: { action: 'member-invite', vaultId, expectedGeneration: 1, displayName: 'Grace Hopper', access: 'write' },
    },
  ])
  expect(audits).toEqual([
    {
      userId: manager.userId,
      actorKey: `user:${manager.userId}`,
      targetKind: 'managed_bigbrain_member',
      targetId: `${vaultId}/invite-${INVITE}`,
      connectionId: undefined,
      action: 'managed_vault_member_invite_write',
      outcome: 'succeeded',
      requestId: input.requestId,
      at: expect.any(Date),
    },
  ])
  expect(JSON.stringify(audits)).not.toContain(SECRET)
  // A host reply for another origin, name or access is withheld.
  for (const drift of [
    { inviteUrl: `https://bb-${'f'.repeat(32)}.example.com/invite#${SECRET}` },
    { displayName: 'Someone else' },
    { access: 'read' },
  ]) {
    hooks.reply = (body) => ({
      invite: {
        ...invite,
        ...drift,
        displayName: (drift as { displayName?: string }).displayName ?? (body as { displayName: string }).displayName,
      },
    })
    expect(
      await code(svc.inviteMember(manager, vaultId, fence({ displayName: 'Grace Hopper', access: 'write' })))
    ).toBe('invalid_response')
  }
  hooks.reply = undefined
  // Requester disabled while the host minted the link: withheld and not audited.
  hooks.during = async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, manager.userId))
  }
  const before = audits.length
  expect(await code(svc.inviteMember(manager, vaultId, fence({ displayName: 'Lin', access: 'read' })))).toBe(
    'enabled_human_required'
  )
  expect(audits).toHaveLength(before)
})

test('cancel, access and removal are fenced, audited by handle, and never target ficus or ficus-reader', async () => {
  const manager = await human(['integrations:write:bigbrain'])
  const { svc, calls, audits } = service()
  const vaultId = await readyVault(svc, manager)
  expect(await svc.cancelInvite(manager, vaultId, INVITE, fence())).toEqual({ inviteId: INVITE, cancelled: true })
  expect(await svc.setMemberAccess(manager, vaultId, 'grace', fence({ access: 'read' }))).toMatchObject({
    handle: 'grace',
    access: 'read',
    editable: true,
  })
  expect(await svc.removeMember(manager, vaultId, 'grace', fence())).toMatchObject({
    handle: 'grace',
    status: 'removed',
    editable: false,
  })
  expect(audits.map((a) => [a.action, a.targetId])).toEqual([
    ['managed_vault_member_invite_cancel', `${vaultId}/invite-${INVITE}`],
    ['managed_vault_member_access_read', `${vaultId}/grace`],
    ['managed_vault_member_remove', `${vaultId}/grace`],
  ])
  const sent = calls.length
  for (const handle of ['ficus', 'ficus-reader']) {
    expect(await code(svc.setMemberAccess(manager, vaultId, handle, fence({ access: 'write' })))).toBe('forbidden')
    expect(await code(svc.removeMember(manager, vaultId, handle, fence()))).toBe('forbidden')
  }
  for (const [attempt, expected] of [
    [() => svc.removeMember(manager, vaultId, 'Grace', fence()), 'invalid_request'],
    [() => svc.removeMember(manager, vaultId, '../x', fence()), 'invalid_request'],
    [() => svc.cancelInvite(manager, vaultId, 'nope', fence()), 'invalid_request'],
    [() => svc.setMemberAccess(manager, vaultId, 'grace', fence({ access: 'owner' })), 'invalid_request'],
    [() => svc.inviteMember(manager, vaultId, fence({ displayName: ' Grace', access: 'read' })), 'invalid_request'],
    [
      () => svc.inviteMember(manager, vaultId, fence({ displayName: 'Grace', access: 'read', role: 'owner' })),
      'invalid_request',
    ],
    [() => svc.removeMember(manager, vaultId, 'grace', fence({ expectedGeneration: 2 })), 'generation_conflict'],
    [() => svc.removeMember(manager, crypto.randomUUID(), 'grace', fence()), 'not_found'],
  ] as const)
    expect(await code(attempt())).toBe(expected)
  expect(calls).toHaveLength(sent)
  // A reply naming another member is refused.
  const other = service()
  const otherVault = await readyVault(other.svc, manager)
  other.hooks.reply = () => ({ member: member('mallory', { status: 'removed' }) })
  expect(await code(other.svc.removeMember(manager, otherVault, 'grace', fence()))).toBe('invalid_response')
})

test('a vault that is not set up or mid-change refuses member work before the host', async () => {
  const manager = await human(['integrations:write:bigbrain'])
  const { svc, calls } = service()
  const created = await svc.create(manager, {
    requestId: crypto.randomUUID(),
    displayName: `Pending ${crypto.randomUUID()}`,
  })
  expect(await code(svc.members(manager, created.vaultId))).toBe('generation_conflict')
  expect(await code(svc.inviteMember(manager, created.vaultId, fence({ displayName: 'A', access: 'read' })))).toBe(
    'generation_conflict'
  )
  expect(calls).toEqual([])
})

test('per-user budgets bound host calls; host refusals map to codes', async () => {
  const manager = await human(['integrations:write:bigbrain'])
  const { svc, calls, hooks } = service()
  const vaultId = await readyVault(svc, manager)
  for (let i = 0; i < MANAGED_VAULT_MEMBER_LIMITS.invite.max; i++)
    await svc.inviteMember(manager, vaultId, fence({ displayName: `M ${i}`, access: 'read' }))
  const refused = await svc
    .inviteMember(manager, vaultId, fence({ displayName: 'One more', access: 'read' }))
    .catch((e) => e)
  expect(managedVaultErrorResponse(refused)).toEqual({ status: 429, body: { code: 'rate_limited' } })
  expect(calls).toHaveLength(MANAGED_VAULT_MEMBER_LIMITS.invite.max)
  // Another person has their own budget.
  const other = await human(['integrations:write:bigbrain'])
  expect((await svc.inviteMember(other, vaultId, fence({ displayName: 'Other', access: 'read' }))).inviteId).toBe(
    INVITE
  )
  hooks.fail = new ManagedHostError('busy', true)
  expect(managedVaultErrorResponse(await svc.members(manager, vaultId).catch((e) => e))).toEqual({
    status: 503,
    body: { code: 'busy', retryable: true },
  })
  hooks.fail = new ManagedHostError('capacity', false)
  expect(
    managedVaultErrorResponse(
      await svc.inviteMember(other, vaultId, fence({ displayName: 'X', access: 'read' })).catch((e) => e)
    )?.status
  ).toBe(429)
  hooks.fail = new ManagedHostError('invite_expired', false)
  expect(
    managedVaultErrorResponse(
      await svc.inviteMember(other, vaultId, fence({ displayName: 'X', access: 'read' })).catch((e) => e)
    )?.status
  ).toBe(409)
})

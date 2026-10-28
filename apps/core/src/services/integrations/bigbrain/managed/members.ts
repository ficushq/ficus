/**
 * Members of a managed shared BigBrain vault: list, invite, cancel an invite, change access and
 * remove, each a synchronous call to the local root helper (no generation advance; fenced to the
 * vault's current generation).
 *
 * Every route requires a LITERAL enabled human with `integrations:write:bigbrain`, including the
 * list: a roster names people and their pending invitations, which is management data, and each
 * list runs the root helper. `integrations:read:bigbrain` alone sees vaults, not their members;
 * squad readers never see either.
 *
 * A member invite link is a secret like the owner device link: returned once to its requester,
 * never stored, cached or logged here. Core records who did what (actor, vault, member handle)
 * in the integration audit log, never the link.
 */
import { z } from 'zod'
import {
  managedBigbrainMemberAccessSchema,
  managedBigbrainMemberHandleSchema,
  managedBigbrainMemberInviteResultSchema,
  managedBigbrainMemberIsProtected,
  managedBigbrainMemberRosterSchema,
  managedBigbrainMemberSchema,
  managedBigbrainInviteIdSchema,
  MANAGED_BIGBRAIN_READER_HANDLE,
  type ManagedBigbrainInstalledHost,
  type ManagedBigbrainMember,
  type ManagedBigbrainMemberInviteResult,
  type ManagedBigbrainPendingInvite,
} from '@ficus/shared/managed-bigbrain'
import { createLogger } from '../../../../lib/infra/logger'
import { FixedWindowLimiter } from '../../../auth/device-auth-rate-limit'
import type { Identity } from '../../../rbac/permissions'
import type { IntegrationAuditRecorder } from '../../audit'
import { requireManagedVaultManager } from './authorization'
import type { ManagedHostCall, ManagedHostClient } from './host-client'
import type { ManagedVault } from './store'

const label = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v))
const fence = { requestId: z.string().uuid(), expectedGeneration: z.number().int().safe().min(1) }
export const managedVaultMemberInviteInputSchema = z
  .object({ ...fence, displayName: label, access: managedBigbrainMemberAccessSchema })
  .strict()
export const managedVaultMemberFenceInputSchema = z.object(fence).strict()
export const managedVaultMemberAccessInputSchema = z
  .object({ ...fence, access: managedBigbrainMemberAccessSchema })
  .strict()

/** One roster entry for the settings card. `system` members are shown and never editable. */
export interface ManagedVaultMemberView extends ManagedBigbrainMember {
  system: 'owner' | 'reader' | null
  editable: boolean
}
export interface ManagedVaultRosterView {
  members: ManagedVaultMemberView[]
  invites: ManagedBigbrainPendingInvite[]
  membersTruncated: boolean
  invitesTruncated: boolean
}

/** Per-user budgets (fixed windows). Each call runs the root helper as the vault's user. */
export const MANAGED_VAULT_MEMBER_LIMITS = {
  list: { max: 60, windowMs: 60_000 },
  invite: { max: 20, windowMs: 60 * 60_000 },
  change: { max: 60, windowMs: 60 * 60_000 },
} as const
export const managedVaultMemberLimiter = new FixedWindowLimiter()

export interface ManagedVaultMemberContext {
  hostClient: Pick<ManagedHostClient, 'call'>
  audit: IntegrationAuditRecorder
  now: () => Date
  limiter?: FixedWindowLimiter
  /** The live (not deleted) vault row, or not_found. */
  live: (vaultId: string) => Promise<ManagedVault>
  /** The eligible installed host, or unavailable. */
  requireHost: () => ManagedBigbrainInstalledHost
  /** The service's error constructor (code + HTTP status + current generation on races). */
  fail: (
    code: 'invalid_request' | 'forbidden' | 'generation_conflict' | 'rate_limited' | 'invalid_response',
    currentGeneration?: number
  ) => Error
}

const log = createLogger('managed-bigbrain-members')

function memberView(member: ManagedBigbrainMember): ManagedVaultMemberView {
  const system = member.role === 'owner' ? 'owner' : member.handle === MANAGED_BIGBRAIN_READER_HANDLE ? 'reader' : null
  return {
    ...member,
    system,
    editable: system === null && member.status !== 'removed' && !managedBigbrainMemberIsProtected(member.handle),
  }
}

export function managedVaultMemberMethods(ctx: ManagedVaultMemberContext) {
  const limiter = ctx.limiter ?? managedVaultMemberLimiter
  function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw ctx.fail('invalid_request')
    return parsed.data
  }
  function budget(userId: string, kind: keyof typeof MANAGED_VAULT_MEMBER_LIMITS): void {
    const { max, windowMs } = MANAGED_VAULT_MEMBER_LIMITS[kind]
    if (!limiter.take(`${userId}:${kind}`, max, windowMs)) throw ctx.fail('rate_limited')
  }
  /** The vault is set up, at the generation the client last saw, and not mid-change. */
  function current(row: ManagedVault, expectedGeneration?: number): void {
    if (
      expectedGeneration !== undefined &&
      (row.desiredGeneration !== expectedGeneration || row.desiredAction !== null)
    )
      throw ctx.fail('generation_conflict', row.desiredGeneration)
    if (row.state !== 'ready' && row.state !== 'degraded') throw ctx.fail('generation_conflict')
  }
  async function call(requestId: string, body: ManagedHostCall) {
    return ctx.hostClient.call(ctx.requireHost(), requestId, body)
  }
  async function record(
    userId: string,
    row: ManagedVault,
    requestId: string,
    action: string,
    handle: string
  ): Promise<void> {
    await ctx.audit.record({
      userId,
      actorKey: `user:${userId}`,
      targetKind: 'managed_bigbrain_member',
      targetId: `${row.id}/${handle}`,
      connectionId: row.connectionId ?? undefined,
      action,
      outcome: 'succeeded',
      requestId,
      at: ctx.now(),
    })
    log.info('Managed BigBrain member change', { vaultId: row.id, userId, requestId, action, handle })
  }

  return {
    async members(identity: Identity | undefined, vaultId: string): Promise<ManagedVaultRosterView> {
      const userId = await requireManagedVaultManager(identity)
      const row = await ctx.live(vaultId)
      current(row)
      budget(userId, 'list')
      const reply = await call(crypto.randomUUID(), { action: 'member-list', vaultId })
      const roster = 'roster' in reply ? managedBigbrainMemberRosterSchema.safeParse(reply.roster) : null
      if (!roster?.success) throw ctx.fail('invalid_response')
      return { ...roster.data, members: roster.data.members.map(memberView) }
    },

    /** Returns the SECRET member invite link once; callers must send it with no-store headers. */
    async inviteMember(
      identity: Identity | undefined,
      vaultId: string,
      input: unknown
    ): Promise<ManagedBigbrainMemberInviteResult> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultMemberInviteInputSchema, input)
      const row = await ctx.live(vaultId)
      current(row, body.expectedGeneration)
      if (!row.origin) throw ctx.fail('generation_conflict')
      budget(userId, 'invite')
      const reply = await call(body.requestId, {
        action: 'member-invite',
        vaultId,
        expectedGeneration: body.expectedGeneration,
        displayName: body.displayName,
        access: body.access,
      })
      const invite = 'invite' in reply ? managedBigbrainMemberInviteResultSchema.safeParse(reply.invite) : null
      if (
        !invite?.success ||
        !invite.data.inviteUrl.startsWith(`${row.origin}/invite#`) ||
        invite.data.displayName !== body.displayName ||
        invite.data.access !== body.access
      )
        throw ctx.fail('invalid_response')
      // Authority may have been lost while the host call was in flight: verify again.
      await requireManagedVaultManager(identity)
      await ctx.live(vaultId)
      // Fails closed: a link is only returned once its requester is on record. The member who
      // redeems it gets the handle `invite-<id>`, so that is the audited target.
      await record(
        userId,
        row,
        body.requestId,
        `managed_vault_member_invite_${body.access}`,
        `invite-${invite.data.inviteId}`
      )
      return invite.data
    },

    async cancelInvite(
      identity: Identity | undefined,
      vaultId: string,
      inviteId: string,
      input: unknown
    ): Promise<{ inviteId: string; cancelled: true }> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultMemberFenceInputSchema, input)
      const id = parse(managedBigbrainInviteIdSchema, inviteId)
      const row = await ctx.live(vaultId)
      current(row, body.expectedGeneration)
      budget(userId, 'change')
      const reply = await call(body.requestId, {
        action: 'invite-cancel',
        vaultId,
        expectedGeneration: body.expectedGeneration,
        inviteId: id,
      })
      if (!('inviteId' in reply) || reply.inviteId !== id) throw ctx.fail('invalid_response')
      await record(userId, row, body.requestId, 'managed_vault_member_invite_cancel', `invite-${id}`)
      return { inviteId: id, cancelled: true }
    },

    async setMemberAccess(
      identity: Identity | undefined,
      vaultId: string,
      handle: string,
      input: unknown
    ): Promise<ManagedVaultMemberView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultMemberAccessInputSchema, input)
      const target = parse(managedBigbrainMemberHandleSchema, handle)
      // The instance owner and the Ficus reader are never changed through Ficus.
      if (managedBigbrainMemberIsProtected(target)) throw ctx.fail('forbidden')
      const row = await ctx.live(vaultId)
      current(row, body.expectedGeneration)
      budget(userId, 'change')
      const reply = await call(body.requestId, {
        action: 'member-set-access',
        vaultId,
        expectedGeneration: body.expectedGeneration,
        handle: target,
        access: body.access,
      })
      const member = 'member' in reply ? managedBigbrainMemberSchema.safeParse(reply.member) : null
      if (!member?.success || member.data.handle !== target || member.data.access !== body.access)
        throw ctx.fail('invalid_response')
      await record(userId, row, body.requestId, `managed_vault_member_access_${body.access}`, target)
      return memberView(member.data)
    },

    async removeMember(
      identity: Identity | undefined,
      vaultId: string,
      handle: string,
      input: unknown
    ): Promise<ManagedVaultMemberView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultMemberFenceInputSchema, input)
      const target = parse(managedBigbrainMemberHandleSchema, handle)
      if (managedBigbrainMemberIsProtected(target)) throw ctx.fail('forbidden')
      const row = await ctx.live(vaultId)
      current(row, body.expectedGeneration)
      budget(userId, 'change')
      const reply = await call(body.requestId, {
        action: 'member-remove',
        vaultId,
        expectedGeneration: body.expectedGeneration,
        handle: target,
      })
      const member = 'member' in reply ? managedBigbrainMemberSchema.safeParse(reply.member) : null
      if (!member?.success || member.data.handle !== target || member.data.status !== 'removed')
        throw ctx.fail('invalid_response')
      await record(userId, row, body.requestId, 'managed_vault_member_remove', target)
      return memberView(member.data)
    },
  }
}

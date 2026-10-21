import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_MEMBER_INVITES,
  MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS,
  type ManagedBigbrainHostRequest,
} from '@ficus/shared/managed-bigbrain'
import { memberInviteMintSchema } from './member-admin'
import { managedPaths } from './paths'
import { readPrivateJson, writePrivateJson } from './secure-files'

export const MEMBER_INVITE_CACHE = 'member-invites.json'
const entrySchema = z
  .object({
    requestId: z.string().uuid(),
    inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expiresAt: z.string().datetime().max(40),
    phase: z.enum(['pending', 'complete']),
    inviteId: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .nullable(),
    secret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
  })
  .strict()
  .refine((v) => (v.phase === 'complete') === (v.inviteId !== null && v.secret !== null))
  .refine((v) => (v.inviteId === null) === (v.secret === null))
/** A request whose invite was cancelled or redeemed: secret-free, so a replay answers
 * invite_expired and never mints again. Pruned at the invite's expiry; never counts toward the cap. */
const spentSchema = z.object({ requestId: z.string().uuid(), expiresAt: z.string().datetime().max(40) }).strict()
/** Spent requests remembered per vault (sized so the whole file fits the private-file budget). A vault
 * that would need more refuses new invites with `capacity` until the oldest expire (fails closed). */
export const MAX_SPENT_MEMBER_INVITES = 72
/** Display name and access are not stored: the input hash binds them to the request. */
export const memberInviteCacheSchema = z
  .object({
    schema: z.literal(1),
    invites: z.array(entrySchema).max(MANAGED_BIGBRAIN_MAX_MEMBER_INVITES),
    spent: z.array(spentSchema).max(MAX_SPENT_MEMBER_INVITES).default([]),
  })
  .strict()
  .refine((v) => {
    const ids = [...v.invites, ...v.spent].map((e) => e.requestId)
    return new Set(ids).size === ids.length
  })
type Entry = z.infer<typeof entrySchema>
type Spent = z.infer<typeof spentSchema>
export type MemberInviteMint = z.infer<typeof memberInviteMintSchema>

export async function initializeMemberInviteCache(vaultId: string, deps: { root?: string; uid?: number }) {
  await writePrivateJson(
    managedPaths({ vaultId, root: deps.root }).control,
    MEMBER_INVITE_CACHE,
    { schema: 1, invites: [], spent: [] },
    memberInviteCacheSchema,
    { uid: deps.uid }
  )
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}

/**
 * Root-only replay cache for member invites beneath a validated control directory. Caller MUST
 * hold the host lifecycle lock and supply a live vault + generation fence. A pending entry is
 * written BEFORE the invite is minted, so a lost result is never permission to mint another: a
 * retried request returns the same link while it is still pending upstream, and otherwise fails.
 * Only invites still pending upstream (and lost results, which cannot be checked) count toward the
 * cap: a cancelled or redeemed invite becomes a secret-free spent record. A corrupt file fails
 * closed. Only vaults created before member management have no file; it is created on their first
 * invite (vaults created since get it at create).
 */
export async function cachedMemberInvite(options: {
  vaultId: string
  root?: string
  uid?: number
  request: Extract<ManagedBigbrainHostRequest, { action: 'member-invite' }>
  now?: () => number
  authorize: () => Promise<void>
  /** Invite IDs still pending upstream (not accepted, cancelled or expired); `unknown` when the
   * roster was truncated, in which case every recorded invite is treated as pending. */
  pendingInvites: () => Promise<ReadonlySet<string> | 'unknown'>
  mint: (issuedAt: string) => Promise<MemberInviteMint>
}): Promise<MemberInviteMint> {
  const now = options.now ?? Date.now
  const directory = managedPaths({ vaultId: options.vaultId, root: options.root }).control
  const fs = { uid: options.uid }
  if (!(await present(join(directory, MEMBER_INVITE_CACHE))))
    await initializeMemberInviteCache(options.vaultId, { root: options.root, uid: options.uid })
  const cache = await readPrivateJson(directory, MEMBER_INVITE_CACHE, memberInviteCacheSchema, fs)
  const unexpired = <T extends { expiresAt: string }>(e: T) => Date.parse(e.expiresAt) > now()
  let invites = cache.invites.filter(unexpired)
  let spent = cache.spent.filter(unexpired)
  const write = () =>
    writePrivateJson(directory, MEMBER_INVITE_CACHE, { schema: 1, invites, spent }, memberInviteCacheSchema, fs)
  /** Move complete invites no longer pending upstream to the spent records. */
  const retire = async (ids: ReadonlySet<string> | 'unknown') => {
    if (ids === 'unknown') return
    const gone = invites.filter((e) => e.phase === 'complete' && e.inviteId !== null && !ids.has(e.inviteId))
    if (gone.length === 0) return
    const next: Spent[] = [...spent, ...gone.map((e) => ({ requestId: e.requestId, expiresAt: e.expiresAt }))]
    if (next.length > MAX_SPENT_MEMBER_INVITES) throw new Error('capacity')
    invites = invites.filter((e) => !gone.includes(e))
    spent = next
    await write()
  }
  const hash = `sha256:${createHash('sha256').update(JSON.stringify(options.request)).digest('hex')}`
  if (spent.some((e) => e.requestId === options.request.requestId)) throw new Error('invite_expired')
  const existing = cache.invites.find((e) => e.requestId === options.request.requestId)
  if (existing) {
    if (existing.inputHash !== hash) throw new Error('request_conflict')
    if (existing.phase !== 'complete' || existing.inviteId === null || existing.secret === null)
      throw new Error('operation_failed')
    if (!unexpired(existing)) throw new Error('invite_expired')
    const ids = await options.pendingInvites()
    if (ids !== 'unknown' && !ids.has(existing.inviteId)) {
      await retire(ids)
      throw new Error('invite_expired')
    }
    await options.authorize()
    return { inviteId: existing.inviteId, secret: existing.secret, expiresAt: existing.expiresAt }
  }
  // Only at the cap is upstream asked which invites are still pending.
  if (invites.length >= MANAGED_BIGBRAIN_MAX_MEMBER_INVITES) await retire(await options.pendingInvites())
  if (invites.length >= MANAGED_BIGBRAIN_MAX_MEMBER_INVITES) throw new Error('capacity')
  const issued = now()
  const pending: Entry = {
    requestId: options.request.requestId,
    inputHash: hash,
    expiresAt: new Date(issued + MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS).toISOString(),
    phase: 'pending',
    inviteId: null,
    secret: null,
  }
  const before = invites
  invites = [...before, pending]
  await write()
  await options.authorize()
  let minted: MemberInviteMint
  try {
    minted = memberInviteMintSchema.parse(await options.mint(new Date(issued).toISOString()))
  } catch (error) {
    // Fixed codes only (the adapter's busy/forbidden/...), never upstream text.
    const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'operation_failed'
    // The adapter refuses these before upstream writes anything, so the same request may retry.
    if (code === 'busy' || code === 'invalid_request') {
      invites = before
      await write()
    }
    throw new Error(code)
  }
  if (Date.parse(minted.expiresAt) !== Date.parse(pending.expiresAt)) throw new Error('upstream_protocol')
  invites = [...before, { ...pending, phase: 'complete', inviteId: minted.inviteId, secret: minted.secret }]
  await write()
  await options.authorize()
  return minted
}

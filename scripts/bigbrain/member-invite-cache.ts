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
/** Display name and access are not stored: the input hash binds them to the request. */
export const memberInviteCacheSchema = z
  .object({ schema: z.literal(1), invites: z.array(entrySchema).max(MANAGED_BIGBRAIN_MAX_MEMBER_INVITES) })
  .strict()
  .refine((v) => new Set(v.invites.map((e) => e.requestId)).size === v.invites.length)
type Entry = z.infer<typeof entrySchema>
export type MemberInviteMint = z.infer<typeof memberInviteMintSchema>

export async function initializeMemberInviteCache(vaultId: string, deps: { root?: string; uid?: number }) {
  await writePrivateJson(
    managedPaths({ vaultId, root: deps.root }).control,
    MEMBER_INVITE_CACHE,
    { schema: 1, invites: [] },
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
 * A corrupt file fails closed. Only vaults created before member management have no file; it
 * is created on their first invite (vaults created since get it at create).
 */
export async function cachedMemberInvite(options: {
  vaultId: string
  root?: string
  uid?: number
  request: Extract<ManagedBigbrainHostRequest, { action: 'member-invite' }>
  now?: () => number
  authorize: () => Promise<void>
  /** Whether an invite is still pending upstream (not accepted, cancelled or expired). */
  stillPending: (inviteId: string) => Promise<boolean>
  mint: (issuedAt: string) => Promise<MemberInviteMint>
}): Promise<MemberInviteMint> {
  const now = options.now ?? Date.now
  const directory = managedPaths({ vaultId: options.vaultId, root: options.root }).control
  const fs = { uid: options.uid }
  if (!(await present(join(directory, MEMBER_INVITE_CACHE))))
    await initializeMemberInviteCache(options.vaultId, { root: options.root, uid: options.uid })
  const cache = await readPrivateJson(directory, MEMBER_INVITE_CACHE, memberInviteCacheSchema, fs)
  const hash = `sha256:${createHash('sha256').update(JSON.stringify(options.request)).digest('hex')}`
  const existing = cache.invites.find((e) => e.requestId === options.request.requestId)
  if (existing) {
    if (existing.inputHash !== hash) throw new Error('request_conflict')
    if (existing.phase !== 'complete' || existing.inviteId === null || existing.secret === null)
      throw new Error('operation_failed')
    if (Date.parse(existing.expiresAt) <= now() || !(await options.stillPending(existing.inviteId)))
      throw new Error('invite_expired')
    await options.authorize()
    return { inviteId: existing.inviteId, secret: existing.secret, expiresAt: existing.expiresAt }
  }
  const live = cache.invites.filter((e) => Date.parse(e.expiresAt) > now())
  if (live.length >= MANAGED_BIGBRAIN_MAX_MEMBER_INVITES) throw new Error('capacity')
  const issued = now()
  const pending: Entry = {
    requestId: options.request.requestId,
    inputHash: hash,
    expiresAt: new Date(issued + MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS).toISOString(),
    phase: 'pending',
    inviteId: null,
    secret: null,
  }
  const save = (entry: Entry) =>
    writePrivateJson(
      directory,
      MEMBER_INVITE_CACHE,
      { schema: 1, invites: [...live, entry] },
      memberInviteCacheSchema,
      fs
    )
  await save(pending)
  await options.authorize()
  let minted: MemberInviteMint
  try {
    minted = memberInviteMintSchema.parse(await options.mint(new Date(issued).toISOString()))
  } catch (error) {
    // Fixed codes only (the adapter's busy/forbidden/...), never upstream text.
    const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'operation_failed'
    // The adapter refuses these before upstream writes anything, so the same request may retry.
    if (code === 'busy' || code === 'invalid_request')
      await writePrivateJson(directory, MEMBER_INVITE_CACHE, { schema: 1, invites: live }, memberInviteCacheSchema, fs)
    throw new Error(code)
  }
  if (Date.parse(minted.expiresAt) !== Date.parse(pending.expiresAt)) throw new Error('upstream_protocol')
  await save({ ...pending, phase: 'complete', inviteId: minted.inviteId, secret: minted.secret })
  await options.authorize()
  return minted
}

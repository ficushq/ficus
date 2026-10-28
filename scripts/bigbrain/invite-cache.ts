import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_ACTIVE_INVITES,
  managedBigbrainHostRequestSchema,
  managedBigbrainInviteWindowStatus,
} from '@ficus/shared/managed-bigbrain'
import { readPrivateJson, writePrivateJson } from './secure-files'
const entrySchema = z
  .strictObject({
    requestId: z.uuid(),
    inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expiresAt: z.iso.datetime().max(40),
    phase: z.enum(['pending', 'complete']),
    secret: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{43}$/)
      .nullable(),
  })
  .refine((v) => (v.phase === 'complete') === (v.secret !== null))
export const ownerInviteCacheSchema = z
  .strictObject({ schema: z.literal(1), invites: z.array(entrySchema).max(MANAGED_BIGBRAIN_MAX_ACTIVE_INVITES) })
  .refine((v) => new Set(v.invites.map((e) => e.requestId)).size === v.invites.length)
const resultSchema = z.strictObject({
  secret: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  expiresAt: z.iso.datetime().max(40),
})

/** Root-only cache beneath a validated control directory. Caller MUST hold the host lifecycle
 * lock, initialize the empty file exactly once during reservation, and supply a live owner +
 * physical/generation fence. Missing/corrupt files fail closed, never become an empty cache.
 * Pending is fsynced BEFORE mint: a lost result cannot be permission to mint again.
 */
export async function cachedOwnerAppLink(options: {
  directory: string
  uid?: number
  input: unknown
  now?: () => number
  authorize: () => Promise<void>
  issue: () => Promise<{ secret: string; expiresAt: string }>
}): Promise<{ secret: string; expiresAt: string }> {
  const parsed = managedBigbrainHostRequestSchema.safeParse(options.input)
  if (!parsed.success || parsed.data.action !== 'owner-invite') throw new Error('invalid_request')
  const request = parsed.data
  const now = options.now ?? Date.now
  const checkWindow = () => {
    const status = managedBigbrainInviteWindowStatus(
      { issuedAt: request.issuedAt, expiresAt: request.expiresAt },
      now()
    )
    if (status !== 'current')
      throw new Error(status === 'expired' ? 'invite_expired' : status === 'not_yet_valid' ? 'busy' : 'invalid_request')
  }
  checkWindow()
  await options.authorize()
  const cache = await readPrivateJson(options.directory, 'owner-invites.json', ownerInviteCacheSchema, {
    uid: options.uid,
  })
  const hash = `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`
  const existing = cache.invites.find((e) => e.requestId === request.requestId)
  if (existing) {
    if (existing.inputHash !== hash) throw new Error('request_conflict')
    if (existing.phase !== 'complete' || existing.secret === null) throw new Error('operation_failed')
    await options.authorize()
    checkWindow()
    return { secret: existing.secret, expiresAt: existing.expiresAt }
  }
  const live = cache.invites.filter((e) => Date.parse(e.expiresAt) > now())
  if (live.length >= MANAGED_BIGBRAIN_MAX_ACTIVE_INVITES) throw new Error('busy')
  checkWindow()
  const pending: z.infer<typeof entrySchema> = {
    requestId: request.requestId,
    inputHash: hash,
    expiresAt: new Date(request.expiresAt).toISOString(),
    phase: 'pending',
    secret: null,
  }
  const save = (entry: z.infer<typeof entrySchema>) =>
    writePrivateJson(
      options.directory,
      'owner-invites.json',
      { schema: 1, invites: [...live, entry] },
      ownerInviteCacheSchema,
      { uid: options.uid }
    )
  await save(pending)
  await options.authorize()
  checkWindow()
  let result: z.infer<typeof resultSchema>
  try {
    result = resultSchema.parse(await options.issue())
  } catch {
    throw new Error('operation_failed')
  }
  if (Date.parse(result.expiresAt) !== Date.parse(request.expiresAt)) throw new Error('upstream_protocol')
  await save({ ...pending, phase: 'complete', secret: result.secret, expiresAt: result.expiresAt })
  await options.authorize()
  checkWindow()
  return result
}

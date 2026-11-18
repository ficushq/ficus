import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { zValidator } from '../lib/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { Permissions } from '@ficus/shared'
import { db, squads } from '../db'
import { requireAnySquadCleanupPermission, requireAnySquadPermission, requireSquadPermission } from '../middleware'
import {
  auditActor,
  hasAnyPermission,
  hasAnySlotCleanupPermission,
  hasPermission,
  type Identity,
} from '../services/rbac'
import {
  DEFAULT_SLOT_HISTORY_LIMIT,
  MAX_SLOT_CAPACITY,
  MAX_SLOT_CLAIM_TIMEOUT_MS,
  MAX_SLOT_HISTORY_LIMIT,
  MAX_SLOT_USAGE_LENGTH,
  MIN_SLOT_CLAIM_TIMEOUT_MS,
  SLOT_KEY_PATTERN,
  SlotServiceError,
  claimSlot,
  getPool,
  listPools,
  listSlotHistory,
  registerPool,
  releaseSlot,
  renewSlot,
  resolveClaimContext,
  resolveWaiterContext,
  subscribeSlot,
  unregisterPool,
  unsubscribeSlot,
  updatePoolDetailed,
  type SlotPoolMutationResponse,
  type SlotPoolRecord,
} from '../services/slots'
import { formatSlotClaimTimeout } from '../services/slots/format'

const keySchema = z.string().trim().toLowerCase().regex(SLOT_KEY_PATTERN)
const uuidSchema = z.uuid()
// Guidance is trimmed before the length check so surrounding whitespace never
// counts against the prompt budget; blank or null clears it.
const usageSchema = z
  .string()
  .trim()
  .max(MAX_SLOT_USAGE_LENGTH, `usage must be at most ${MAX_SLOT_USAGE_LENGTH} characters`)
  .nullable()
const registerSchema = z.object({
  key: keySchema,
  capacity: z.int().min(1).max(MAX_SLOT_CAPACITY).optional(),
  claimTimeoutMs: z.int().min(MIN_SLOT_CLAIM_TIMEOUT_MS).max(MAX_SLOT_CLAIM_TIMEOUT_MS).optional(),
  usage: usageSchema.optional(),
  hostShared: z.boolean().optional(),
  capacityFollowsHost: z.boolean().optional(),
})
/** Partial update: send only the fields to change. `key` renames the pool. */
const updateSchema = registerSchema
  .omit({ key: true })
  .extend({ enabled: z.boolean().optional(), key: keySchema.optional() })
  .refine(
    (body) =>
      body.capacity !== undefined ||
      body.claimTimeoutMs !== undefined ||
      body.usage !== undefined ||
      body.enabled !== undefined ||
      body.hostShared !== undefined ||
      body.capacityFollowsHost !== undefined ||
      body.key !== undefined,
    {
      message: 'capacity, claimTimeoutMs, usage, enabled, hostShared, capacityFollowsHost, or key is required',
    }
  )
const historyQuerySchema = z.object({
  limit: z.preprocess(
    (value) =>
      value === undefined
        ? DEFAULT_SLOT_HISTORY_LIMIT
        : typeof value === 'string' && /^\d+$/.test(value)
          ? Number(value)
          : value,
    z.int().min(1).max(MAX_SLOT_HISTORY_LIMIT)
  ),
  cursor: z.string().min(1).max(1000).optional(),
})
const slotUsePermissions = [Permissions.SLOTS_USE, Permissions.SLOTS_WRITE]
const useGuard = requireAnySquadPermission(slotUsePermissions, 'squadId')
const cleanupGuard = requireAnySquadCleanupPermission(slotUsePermissions, 'squadId')
const writeGuard = requireSquadPermission(Permissions.SLOTS_WRITE, 'squadId')

/**
 * Archived (soft-deleted) squads are inert for every slot route, even for
 * callers whose role assignments are retained. Mirrors the squad routes'
 * archived guard (410 Gone) and reveals nothing else: a missing squad keeps
 * its existing not-found behavior, and permission checks run first so foreign
 * callers never learn whether a squad is archived.
 */
const notArchivedGuard = createMiddleware(async (c, next) => {
  const squadId = c.req.param('squadId')
  if (!squadId) return c.json({ error: 'Squad ID required' }, 400)
  const [row] = await db.select({ archivedAt: squads.archivedAt }).from(squads).where(eq(squads.id, squadId))
  if (row?.archivedAt) return c.json({ error: 'Squad is archived' }, 410)
  return next()
})

function agentOwner(identity: Identity, squadId: string): string {
  if (identity.type !== 'agent' || identity.squadId !== squadId) {
    throw new SlotServiceError('agent_identity_required', 'An agent identity in this squad is required.', 403)
  }
  return identity.agentId
}

function validKey(raw: string): string {
  const parsed = keySchema.safeParse(raw)
  if (!parsed.success) throw new SlotServiceError('invalid_slot_key', 'Invalid slot pool key.', 400)
  return parsed.data
}

function validUuid(raw: string, kind: 'claim' | 'waiter'): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SlotServiceError(kind === 'claim' ? 'claim_not_found' : 'waiter_not_found', `Invalid ${kind} ID.`, 404)
  }
  return parsed.data
}

const HOST_SHARED_NOTE =
  "It is host-shared: its claims also draw on the machine host's slot budget, which every squad on that machine shares. For a pool that protects something other than box memory or CPU, turn that off with `ficus slot update <key> --no-host-shared`."
const NOT_HOST_SHARED_NOTE = 'It is not host-shared: only its own capacity limits it.'

/** How a mutation message names the pool's capacity. */
function capacityPhrase(pool: SlotPoolRecord): string {
  return pool.capacityFollowsHost
    ? `no cap of its own (its capacity follows the machine host's budget; ${pool.capacity} where no budget applies)`
    : `capacity ${pool.capacity}`
}

function registerResponse(pool: SlotPoolRecord): SlotPoolMutationResponse {
  return {
    outcome: 'registered',
    message: `Slot pool "${pool.key}" is registered with ${capacityPhrase(pool)} and a ${formatSlotClaimTimeout(
      pool.claimTimeoutMs
    )} claim timeout${pool.usage ? ' and usage guidance' : ''}. ${pool.hostShared ? HOST_SHARED_NOTE : NOT_HOST_SHARED_NOTE}`,
    pool,
  }
}

function updateResponse(
  pool: SlotPoolRecord,
  input: {
    capacity?: number
    claimTimeoutMs?: number
    usage?: string | null
    enabled?: boolean
    hostShared?: boolean
    capacityFollowsHost?: boolean
  },
  releasedWaiters: number,
  renamedFrom?: string
): SlotPoolMutationResponse {
  const changes: string[] = []
  if (input.capacity !== undefined || input.capacityFollowsHost !== undefined) changes.push(capacityPhrase(pool))
  if (input.claimTimeoutMs !== undefined) changes.push(`a ${formatSlotClaimTimeout(pool.claimTimeoutMs)} claim timeout`)
  if (input.usage !== undefined) changes.push(pool.usage ? 'updated usage guidance' : 'no usage guidance')
  const sentences = renamedFrom
    ? [`Slot pool "${renamedFrom}" is now "${pool.key}". Its claims, waiters and history stay with it.`]
    : []
  if (changes.length > 0) sentences.push(`Slot pool "${pool.key}" now has ${changes.join(' and ')}.`)
  if (input.enabled !== undefined) {
    if (pool.disabledAt) {
      sentences.push(
        `Slot pool "${pool.key}" is disabled: it is not enforced and is omitted from agent prompts.` +
          (releasedWaiters > 0
            ? ` ${releasedWaiters} queued waiter${releasedWaiters === 1 ? ' was' : 's were'} canceled and notified.`
            : '')
      )
    } else {
      sentences.push(`Slot pool "${pool.key}" is enabled.`)
    }
  }
  if (input.hostShared !== undefined) {
    sentences.push(
      pool.hostShared
        ? `Slot pool "${pool.key}" is host-shared: its claims also draw on the machine host's slot budget, which every squad on that machine shares.`
        : `Slot pool "${pool.key}" is no longer host-shared: only its own capacity limits it.`
    )
  }
  if (sentences.length === 0) sentences.push(`Slot pool "${pool.key}" is unchanged.`)
  return { outcome: 'updated', message: sentences.join(' '), pool }
}

function unregisterResponse(pool: SlotPoolRecord): SlotPoolMutationResponse {
  return {
    outcome: 'unregistered',
    message: `Slot pool "${pool.key}" is unregistered. Terminal history is retained for bounded recovery.`,
    pool,
  }
}

export const slotsRouter = new Hono()
slotsRouter.onError((error, c) => {
  if (error instanceof SlotServiceError) return c.json({ error: error.message, code: error.code }, error.httpStatus)
  throw error
})

slotsRouter.get('/:squadId/slots', useGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  const identity: Identity = c.get('identity')
  const diagnostics = await hasPermission(identity, Permissions.SLOTS_WRITE, squadId)
  return c.json(
    await listPools(squadId, { agentId: identity.type === 'agent' ? identity.agentId : undefined, diagnostics })
  )
})

slotsRouter.get(
  '/:squadId/slots/:key/history',
  useGuard,
  notArchivedGuard,
  zValidator('query', historyQuerySchema),
  async (c) => {
    const squadId = c.req.param('squadId')
    const identity: Identity = c.get('identity')
    const diagnostics = await hasPermission(identity, Permissions.SLOTS_WRITE, squadId)
    return c.json(
      await listSlotHistory(
        squadId,
        validKey(c.req.param('key')),
        { agentId: identity.type === 'agent' ? identity.agentId : undefined, diagnostics },
        c.req.valid('query')
      )
    )
  }
)

slotsRouter.get('/:squadId/slots/:key', useGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  const identity: Identity = c.get('identity')
  const diagnostics = await hasPermission(identity, Permissions.SLOTS_WRITE, squadId)
  return c.json(
    await getPool(squadId, validKey(c.req.param('key')), {
      agentId: identity.type === 'agent' ? identity.agentId : undefined,
      diagnostics,
    })
  )
})

slotsRouter.post('/:squadId/slots', writeGuard, notArchivedGuard, zValidator('json', registerSchema), async (c) => {
  const identity: Identity = c.get('identity')
  const pool = await registerPool({
    squadId: c.req.param('squadId'),
    ...c.req.valid('json'),
    createdBy: auditActor(identity),
  })
  return c.json(registerResponse(pool), 201)
})

slotsRouter.patch('/:squadId/slots/:key', writeGuard, notArchivedGuard, zValidator('json', updateSchema), async (c) => {
  const { key: newKey, ...input } = c.req.valid('json')
  const { pool, releasedWaiters, renamedFrom } = await updatePoolDetailed(
    c.req.param('squadId'),
    validKey(c.req.param('key')),
    { ...input, ...(newKey === undefined ? {} : { newKey }) }
  )
  return c.json(updateResponse(pool, input, releasedWaiters, renamedFrom))
})

slotsRouter.delete('/:squadId/slots/:key', writeGuard, notArchivedGuard, async (c) => {
  return c.json(unregisterResponse(await unregisterPool(c.req.param('squadId'), validKey(c.req.param('key')))))
})

/**
 * `?subscribe=false` keeps the pre-merge behaviour: report `unavailable`
 * instead of joining the queue. Anything else (including an absent flag)
 * queues, which is what almost every caller wanted the blocked claim to do.
 */
function subscribeFlag(raw: string | undefined): boolean {
  return raw !== 'false'
}

slotsRouter.post('/:squadId/slots/:key/claims', useGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  return c.json(
    await claimSlot(squadId, validKey(c.req.param('key')), agentOwner(c.get('identity'), squadId), {
      subscribe: subscribeFlag(c.req.query('subscribe')),
    })
  )
})

slotsRouter.post('/:squadId/slots/:key/claims/:claimId/renew', useGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  return c.json(
    await renewSlot(
      squadId,
      validKey(c.req.param('key')),
      agentOwner(c.get('identity'), squadId),
      validUuid(c.req.param('claimId'), 'claim')
    )
  )
})

slotsRouter.delete('/:squadId/slots/:key/claims/:claimId', cleanupGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  return c.json(
    await releaseSlot(
      squadId,
      validKey(c.req.param('key')),
      agentOwner(c.get('identity'), squadId),
      validUuid(c.req.param('claimId'), 'claim')
    )
  )
})

slotsRouter.post('/:squadId/slots/:key/waiters', useGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  return c.json(await subscribeSlot(squadId, validKey(c.req.param('key')), agentOwner(c.get('identity'), squadId)))
})

slotsRouter.delete('/:squadId/slots/:key/waiters/:waiterId', cleanupGuard, notArchivedGuard, async (c) => {
  const squadId = c.req.param('squadId')
  return c.json(
    await unsubscribeSlot(
      squadId,
      validKey(c.req.param('key')),
      agentOwner(c.get('identity'), squadId),
      validUuid(c.req.param('waiterId'), 'waiter')
    )
  )
})

/**
 * UUID-addressed claim and waiter operations.
 *
 * Mounted at `/api/slots`, with no squad in the path: the resource id resolves
 * to its pool, the pool names the squad, and authority is checked against THAT
 * squad. A caller without rights there gets the same 404 as for an unknown id,
 * so ids cannot be probed across squads.
 */
export const slotResourcesRouter = new Hono()
slotResourcesRouter.onError((error, c) => {
  if (error instanceof SlotServiceError) return c.json({ error: error.message, code: error.code }, error.httpStatus)
  throw error
})

type SlotAccess = 'use' | 'cleanup'

async function authorizeResolvedSquad(
  c: Context,
  squadId: string,
  access: SlotAccess,
  notFound: SlotServiceError
): Promise<Identity> {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) throw notFound
  c.set('authzChecked', true)
  const allowed =
    access === 'cleanup'
      ? await hasAnySlotCleanupPermission(identity, slotUsePermissions, squadId)
      : await hasAnyPermission(identity, slotUsePermissions, squadId)
  // 404, not 403: a caller with no authority in the owning squad must not learn
  // that this id exists.
  if (!allowed) throw notFound
  return identity
}

slotResourcesRouter.post('/claims/:claimId/renew', async (c) => {
  const claimId = validUuid(c.req.param('claimId'), 'claim')
  const notFound = new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
  const { squadId, key } = await resolveClaimContext(claimId)
  const identity = await authorizeResolvedSquad(c, squadId, 'use', notFound)
  return c.json(await renewSlot(squadId, key, agentOwner(identity, squadId), claimId))
})

slotResourcesRouter.delete('/claims/:claimId', async (c) => {
  const claimId = validUuid(c.req.param('claimId'), 'claim')
  const notFound = new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
  const { squadId, key } = await resolveClaimContext(claimId)
  const identity = await authorizeResolvedSquad(c, squadId, 'cleanup', notFound)
  return c.json(await releaseSlot(squadId, key, agentOwner(identity, squadId), claimId))
})

slotResourcesRouter.delete('/waiters/:waiterId', async (c) => {
  const waiterId = validUuid(c.req.param('waiterId'), 'waiter')
  const notFound = new SlotServiceError('waiter_not_found', 'Slot waiter was not found.', 404)
  const { squadId, key } = await resolveWaiterContext(waiterId)
  const identity = await authorizeResolvedSquad(c, squadId, 'cleanup', notFound)
  return c.json(await unsubscribeSlot(squadId, key, agentOwner(identity, squadId), waiterId))
})

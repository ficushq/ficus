import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { zValidator } from '@hono/zod-validator'
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
  updatePool,
  type SlotPoolMutationResponse,
  type SlotPoolRecord,
} from '../services/slots'

const keySchema = z.string().trim().toLowerCase().regex(SLOT_KEY_PATTERN)
const uuidSchema = z.string().uuid()
const registerSchema = z.object({
  key: keySchema,
  capacity: z.number().int().min(1).max(MAX_SLOT_CAPACITY).optional(),
  claimTimeoutMs: z.number().int().min(MIN_SLOT_CLAIM_TIMEOUT_MS).max(MAX_SLOT_CLAIM_TIMEOUT_MS).optional(),
})
const updateSchema = registerSchema
  .omit({ key: true })
  .refine((body) => body.capacity !== undefined || body.claimTimeoutMs !== undefined, {
    message: 'capacity or claimTimeoutMs is required',
  })
const historyQuerySchema = z.object({
  limit: z.preprocess(
    (value) =>
      value === undefined
        ? DEFAULT_SLOT_HISTORY_LIMIT
        : typeof value === 'string' && /^\d+$/.test(value)
          ? Number(value)
          : value,
    z.number().int().min(1).max(MAX_SLOT_HISTORY_LIMIT)
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

function describeClaimTimeout(claimTimeoutMs: number): string {
  if (claimTimeoutMs % 86_400_000 === 0) return `${claimTimeoutMs / 86_400_000}d`
  if (claimTimeoutMs % 3_600_000 === 0) return `${claimTimeoutMs / 3_600_000}h`
  if (claimTimeoutMs % 60_000 === 0) return `${claimTimeoutMs / 60_000}m`
  return `${Math.round(claimTimeoutMs / 1_000)}s`
}

function registerResponse(pool: SlotPoolRecord): SlotPoolMutationResponse {
  return {
    outcome: 'registered',
    message: `Slot pool "${pool.key}" is registered with capacity ${pool.capacity} and a ${describeClaimTimeout(
      pool.claimTimeoutMs
    )} claim timeout.`,
    pool,
  }
}

function updateResponse(
  pool: SlotPoolRecord,
  input: { capacity?: number; claimTimeoutMs?: number }
): SlotPoolMutationResponse {
  const changes: string[] = []
  if (input.capacity !== undefined) changes.push(`capacity ${pool.capacity}`)
  if (input.claimTimeoutMs !== undefined) changes.push(`${describeClaimTimeout(pool.claimTimeoutMs)} claim timeout`)
  return {
    outcome: 'updated',
    message: `Slot pool "${pool.key}" now has ${changes.join(' and ')}.`,
    pool,
  }
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
  const input = c.req.valid('json')
  return c.json(updateResponse(await updatePool(c.req.param('squadId'), validKey(c.req.param('key')), input), input))
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

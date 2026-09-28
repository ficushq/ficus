import { Hono, type Context, type Next } from 'hono'
import { z } from 'zod'
import { Permissions } from '@ficus/shared'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import { auditActor } from '../services/rbac/audit-actor'
import { parseJsonBody } from './json-body'
import { narrowScope, resolvePermissionSquadScope, scopeAllows, type Identity } from '../services/rbac'
import {
  getRecommendationDetail,
  listRecommendations,
  recommendationSquadId,
  updateRecommendationStatus,
} from '../services/operations-analyst/repository'
import {
  InvalidRecommendationCursorError,
  RecommendationCursorResetRequiredError,
} from '../services/operations-analyst/cursor'

const status = z.enum(['open', 'acknowledged', 'dismissed', 'resolved'])
const uuid = z.string().uuid()
const identitySubject = (identity: Identity): string => {
  if (identity.type === 'user') return `user:${identity.userId}`
  if (identity.type === 'agent') return identity.userId ? `user:${identity.userId}` : `agent:${identity.agentId}`
  if (identity.type === 'system') return `system:${[...identity.scopes].sort().join(',')}`
  return 'legacy'
}

const validateRecommendationId = async (c: Context, next: Next) =>
  uuid.safeParse(c.req.param('id')).success ? next() : c.json({ error: 'Invalid id' }, 400)
export const operationsRecommendationsRouter = new Hono()
operationsRecommendationsRouter.get('/', async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const parsed = z
    .object({
      status: status.optional(),
      squadId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(1000).optional(),
    })
    .safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
  let squadScope = await resolvePermissionSquadScope(identity, Permissions.RECOMMENDATIONS_READ)
  if (parsed.data.squadId) {
    if (!scopeAllows(squadScope, parsed.data.squadId)) return c.json({ error: 'Forbidden' }, 403)
    squadScope = narrowScope(squadScope, parsed.data.squadId)
  }
  try {
    return c.json(
      await listRecommendations({
        squadScope,
        status: parsed.data.status,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
        cursorContext: {
          status: parsed.data.status,
          squadId: parsed.data.squadId,
          identitySubject: identitySubject(identity),
          squadScope,
        },
      })
    )
  } catch (error) {
    if (error instanceof RecommendationCursorResetRequiredError) {
      return c.json(
        {
          error: 'Recommendation access changed; restart pagination',
          code: 'RECOMMENDATIONS_CURSOR_RESET_REQUIRED',
        },
        409
      )
    }
    if (error instanceof InvalidRecommendationCursorError) {
      return c.json({ error: 'Invalid cursor', code: 'RECOMMENDATIONS_CURSOR_INVALID' }, 400)
    }
    throw error
  }
})
operationsRecommendationsRouter.get(
  '/:id',
  validateRecommendationId,
  requireEntityPermission(Permissions.RECOMMENDATIONS_READ, (c) => recommendationSquadId(c.req.param('id'))),
  async (c) => {
    const value = await getRecommendationDetail(c.req.param('id'))
    return value ? c.json(value) : c.json({ error: 'Not found' }, 404)
  }
)
operationsRecommendationsRouter.patch(
  '/:id/status',
  validateRecommendationId,
  requireEntityPermission(Permissions.RECOMMENDATIONS_UPDATE, (c) => recommendationSquadId(c.req.param('id'))),
  async (c) => {
    const parsedBody = await parseJsonBody(c)
    if (!parsedBody.ok) return c.json({ error: 'Invalid JSON body' }, 400)
    const body = z.object({ status }).strict().safeParse(parsedBody.value)
    if (!body.success) return c.json({ error: 'Invalid body' }, 400)
    const result = await updateRecommendationStatus(
      c.req.param('id'),
      body.data.status,
      auditActor(c.get('identity') as Identity)
    )
    if (result === 'not-found') return c.json({ error: 'Not found' }, 404)
    if (result === 'conflict') return c.json({ error: 'Invalid status transition' }, 409)
    return c.json(await getRecommendationDetail(c.req.param('id')))
  }
)

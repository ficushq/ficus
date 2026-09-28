import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  SQUAD_ACTIVITY_KINDS,
  type GlobalActivityPresence,
  type GlobalSquadActivityPage,
  type SquadActivityKind,
} from '@ficus/shared'
import type { Identity } from '../services/rbac'
import { resolveGlobalActivityAccess } from '../services/squad-activity/access'
import { projectGlobalActivity } from '../services/squad-activity/global-activity'
import { ActivityCursorExpiredError, InvalidActivityCursorError } from '../services/squad/activity-cursor'
import { projectGlobalActivityPresence } from '../services/squad-activity/global-presence'

/**
 * Cross-squad activity requires no single squad-scoped permission (each row's
 * visibility is resolved per-squad below) — only that the caller is an
 * authenticated identity at all. Sets `authzChecked` so the authz-sentinel
 * backstop (apps/core/src/middleware/authz-sentinel.ts) doesn't 500 an
 * otherwise-successful response.
 */
const requireAuthenticatedIdentity = createMiddleware(async (c, next) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  return next()
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const activityRouter = new Hono()
  .get('/presence', requireAuthenticatedIdentity, async (c) => {
    const body: GlobalActivityPresence = await projectGlobalActivityPresence(c.get('identity') as Identity)
    return c.json(body)
  })
  .get('/', requireAuthenticatedIdentity, async (c) => {
    const identity = c.get('identity') as Identity
    const rawLimit = c.req.query('limit')
    const limit = rawLimit === undefined ? 50 : Number(rawLimit)
    const rawVerbose = c.req.query('verbose')
    const agentIds = [...new Set(c.req.queries('agentId') ?? [])].sort()
    const kinds = [...new Set(c.req.queries('kind') ?? [])].sort()
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (rawVerbose !== undefined && rawVerbose !== 'true' && rawVerbose !== 'false') ||
      agentIds.some((id) => !UUID.test(id)) ||
      kinds.some((kind) => !SQUAD_ACTIVITY_KINDS.includes(kind as SquadActivityKind))
    )
      return c.json({ error: 'Invalid activity query' }, 400)

    const squadAccess = await resolveGlobalActivityAccess(identity)
    try {
      const page = await projectGlobalActivity({
        limit,
        verbose: rawVerbose === 'true',
        agentIds,
        kinds: kinds as SquadActivityKind[],
        cursor: c.req.query('cursor'),
        squadAccess: squadAccess.map(({ squadId, access }) => ({ squadId, access })),
      })
      const squadsMap: GlobalSquadActivityPage['squads'] = {}
      for (const { squadId, squadName } of squadAccess) squadsMap[squadId] = { name: squadName }
      const body: GlobalSquadActivityPage = { ...page, squads: squadsMap }
      return c.json(body)
    } catch (error) {
      if (error instanceof ActivityCursorExpiredError)
        return c.json({ error: 'Activity cursor expired', code: 'activity_cursor_expired' }, 400)
      if (error instanceof InvalidActivityCursorError)
        return c.json({ error: 'Invalid activity cursor', code: 'invalid_cursor' }, 400)
      throw error
    }
  })

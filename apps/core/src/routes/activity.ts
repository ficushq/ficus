import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  ACTIVITY_SETTLED_KINDS,
  SQUAD_ACTIVITY_KINDS,
  type ActivitySettledKind,
  type ActivitySettledSummary,
  type GlobalActivityPresence,
  type GlobalSquadActivityPage,
  type SquadActivityKind,
} from '@ficus/shared'
import type { Identity } from '../services/rbac'
import { resolveGlobalActivityAccess } from '../services/squad-activity/access'
import { projectGlobalActivity } from '../services/squad-activity/global-activity'
import { ActivityCursorExpiredError, InvalidActivityCursorError } from '../services/squad/activity-cursor'
import { projectGlobalActivityPresence } from '../services/squad-activity/global-presence'
import { countSettledActivity, settledPeriodStart } from '../services/squad-activity/settled'

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

/** An ISO instant (`since`), or undefined when absent or not one. */
function parseInstant(value: string | undefined): Date | undefined {
  if (!value || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? undefined : date
}

/** Optional `squadId` narrowing: never widens what the caller may read, only selects from it. */
function selectSquads<T extends { squadId: string }>(entries: T[], squadIds: string[]): T[] {
  return squadIds.length === 0 ? entries : entries.filter((entry) => squadIds.includes(entry.squadId))
}

export const activityRouter = new Hono()
  .get('/presence', requireAuthenticatedIdentity, async (c) => {
    const body: GlobalActivityPresence = await projectGlobalActivityPresence(c.get('identity') as Identity)
    return c.json(body)
  })
  // Counts for the Feed's "since your last visit" line: work settled without a person.
  .get('/settled', requireAuthenticatedIdentity, async (c) => {
    const since = parseInstant(c.req.query('since'))
    const squadIds = [...new Set(c.req.queries('squadId') ?? [])].sort()
    if (!since || since.valueOf() > Date.now() || squadIds.some((id) => !UUID.test(id)))
      return c.json({ error: 'Invalid settled activity query' }, 400)
    const squadAccess = selectSquads(await resolveGlobalActivityAccess(c.get('identity') as Identity), squadIds)
    const body: ActivitySettledSummary = await countSettledActivity(
      squadAccess.map(({ squadId, access }) => ({ squadId, access })),
      since
    )
    c.header('Cache-Control', 'no-store')
    return c.json(body)
  })
  .get('/', requireAuthenticatedIdentity, async (c) => {
    const identity = c.get('identity') as Identity
    const rawLimit = c.req.query('limit')
    const limit = rawLimit === undefined ? 50 : Number(rawLimit)
    const rawVerbose = c.req.query('verbose')
    const agentIds = [...new Set(c.req.queries('agentId') ?? [])].sort()
    const kinds = [...new Set(c.req.queries('kind') ?? [])].sort()
    const workStreamId = c.req.query('workStreamId') || undefined
    const squadIds = [...new Set(c.req.queries('squadId') ?? [])].sort()
    const settledKind = c.req.query('settled')
    const settledSince = parseInstant(c.req.query('since'))
    // The count's `through`: only with `settled`, so the list stops where the count did.
    const rawSettledUntil = c.req.query('until')
    const settledUntil = parseInstant(rawSettledUntil)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (rawVerbose !== undefined && rawVerbose !== 'true' && rawVerbose !== 'false') ||
      agentIds.some((id) => !UUID.test(id)) ||
      (workStreamId !== undefined && !UUID.test(workStreamId)) ||
      kinds.some((kind) => !SQUAD_ACTIVITY_KINDS.includes(kind as SquadActivityKind)) ||
      squadIds.some((id) => !UUID.test(id)) ||
      (settledKind !== undefined &&
        (!ACTIVITY_SETTLED_KINDS.includes(settledKind as ActivitySettledKind) || !settledSince)) ||
      (rawSettledUntil !== undefined && (settledKind === undefined || !settledUntil))
    )
      return c.json({ error: 'Invalid activity query' }, 400)

    const squadAccess = selectSquads(await resolveGlobalActivityAccess(identity), squadIds)
    // The same raised start as the count, so the rows listed are exactly the rows counted.
    const settled =
      settledKind && settledSince
        ? {
            kind: settledKind as ActivitySettledKind,
            since: settledPeriodStart(settledSince).since.toISOString(),
            ...(settledUntil ? { until: settledUntil.toISOString() } : {}),
          }
        : undefined
    try {
      const page = await projectGlobalActivity({
        limit,
        verbose: rawVerbose === 'true',
        agentIds,
        kinds: kinds as SquadActivityKind[],
        workStreamId,
        ...(settled ? { settled } : {}),
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

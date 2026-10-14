import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { FARM_WATCHING_MAX_AGENTS, type FarmWatchingResponse } from '@ficus/shared'
import { agents, db } from '../db'
import { getAccessibleSquadIds, hasPermission, type Identity } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { moodCache, reportWatching, robotMoodsEnabled } from '../services/robot-moods'

/*
 * The farm app's own API. `POST /watching` is the farm saying which robots are
 * on screen (on every view change, and every 20s while its tab is visible), so
 * robot moods (services/robot-moods) are worked out only for robots someone is
 * looking at. People only, by the instance-wide farm:read; only robots the
 * caller could list (the same rule as GET /api/agents) are kept.
 */

const uuid = z.string().uuid()
const watchingBody = z.object({ agentIds: z.array(z.string().max(100)).max(FARM_WATCHING_MAX_AGENTS) })

export interface FarmRouterDeps {
  isEnabled: () => boolean
  report: (agentIds: string[]) => void
  moods: (agentIds: string[]) => FarmWatchingResponse['moods']
  visibleAgentIds: (identity: Identity, agentIds: string[]) => Promise<string[]>
}

/** The agents among these the caller could list: their own private ones, and those in squads they can see. */
export async function visibleAgentIds(identity: Identity, agentIds: string[]): Promise<string[]> {
  if (!agentIds.length) return []
  const rows = await db
    .select({ id: agents.id, squadId: agents.squadId, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(inArray(agents.id, agentIds))
  const accessible = await getAccessibleSquadIds(identity)
  const userId = identity.type === 'user' ? identity.userId : undefined
  return rows
    .filter((row) => {
      if (row.ownerUserId) return row.ownerUserId === userId
      if (accessible === 'all') return true
      return row.squadId != null && accessible.includes(row.squadId)
    })
    .map((row) => row.id)
}

const defaultDeps: FarmRouterDeps = {
  isEnabled: robotMoodsEnabled,
  report: reportWatching,
  moods: (agentIds) => moodCache.get(agentIds),
  visibleAgentIds,
}

export function createFarmRouter(overrides: Partial<FarmRouterDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides }
  const router = new Hono()
  router.use('*', bodyLimit({ maxSize: 16 * 1024 }))

  router.post('/watching', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity || identity.type !== 'user') return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    if (!(await hasPermission(identity, 'farm:read'))) return c.json({ error: 'Forbidden' }, 403)
    const parsed = watchingBody.safeParse(await parseOptionalJsonObjectBody(c, {}))
    if (!parsed.success) return c.json({ error: `agentIds must be at most ${FARM_WATCHING_MAX_AGENTS} ids` }, 400)

    // Off: nothing is watched and nothing is worked out; the farm just learns it's off.
    if (!deps.isEnabled()) return c.json({ enabled: false, moods: {} } satisfies FarmWatchingResponse)
    const requested = [...new Set(parsed.data.agentIds)].filter((id) => uuid.safeParse(id).success)
    const visible = await deps.visibleAgentIds(identity, requested)
    deps.report(visible)
    return c.json({ enabled: true, moods: deps.moods(visible) } satisfies FarmWatchingResponse)
  })

  return router
}

export const farmRouter = createFarmRouter()

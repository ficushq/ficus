import { workflowSourceSchema } from '@ficus/shared'
import { authorizeWorkflowSource } from '../services/workflows/access'
import { WorkflowError } from '../services/workflows/catalog'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { Schedule } from '../entities/Schedule'
import { Agent } from '../entities/Agent'
import { inArray } from 'drizzle-orm'
import { agents, db } from '../db'
import type { ScheduleScopeType } from '@ficus/shared'
import { filterToAccessibleSquads, requireEntityPermission } from '../middleware/require-entity-permission'
import { hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'
import { ScheduleExecutionError } from '../services/scheduling/failure-classifier'

const schedulesRouter = new Hono()

function safeScheduleError(error: unknown, fallback = 'Schedule request failed.'): string {
  return error instanceof ScheduleExecutionError ? error.safeSummary : fallback
}

function scheduleSquadId(
  schedule: Pick<Schedule, 'scopeType' | 'scopeId'>,
  agentSquads: ReadonlyMap<string, string | null>
): string | null {
  return schedule.scopeType === 'squad' ? schedule.scopeId : (agentSquads.get(schedule.scopeId) ?? null)
}

async function loadScheduleSquadId(c: Context): Promise<string | null> {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) throw new Error('Schedule not found')
  if (schedule.scopeType === 'squad') return schedule.scopeId
  // Agent-scoped schedules resolve to the owning agent's squad so the entity
  // permission check is squad-scoped (previously null -> unscoped check).
  if (schedule.scopeType === 'agent') {
    const agent = await Agent.find(schedule.scopeId)
    return agent?.squadId ?? null
  }
  return null
}

async function canAccessScheduleScope(
  identity: Identity,
  permission: string,
  scopeType: ScheduleScopeType,
  scopeId: string
) {
  if (scopeType === 'squad') return hasPermission(identity, permission, scopeId)
  // Resolve an agent scope to the owning agent's squad so the check is
  // squad-scoped. Previously this was an UNSCOPED check, letting a squad-bound
  // agent create/read/update/delete/trigger schedules targeting ANY squad's
  // agents. Fail closed when the agent's squad can't be resolved.
  if (scopeType === 'agent') {
    const agent = await Agent.find(scopeId)
    if (!agent?.squadId) return false
    return hasPermission(identity, permission, agent.squadId)
  }
  return hasPermission(identity, permission)
}

async function requireBodySchedulePermission(c: Context, permission: string, body: Record<string, unknown>) {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)

  const scopeType = body.scopeType as ScheduleScopeType | undefined
  const scopeId = body.scopeId as string | undefined
  if (!scopeType || !scopeId) return c.json({ error: 'Forbidden' }, 403)

  if (!(await canAccessScheduleScope(identity, permission, scopeType, scopeId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  c.set('authzChecked', true)
  return null
}

// GET /api/schedules
schedulesRouter.get('/', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)

  const scopeType = c.req.query('scopeType') as ScheduleScopeType | undefined
  const scopeId = c.req.query('scopeId')
  const enabledParam = c.req.query('enabled')
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined
  const kind = c.req.query('kind')
  const excludeKind = c.req.query('excludeKind')

  const schedules = await Schedule.list({ scopeType, scopeId, enabled, kind, excludeKind })
  const agentScopeIds = [
    ...new Set(schedules.filter((schedule) => schedule.scopeType === 'agent').map((schedule) => schedule.scopeId)),
  ]
  const agentScopeRows = agentScopeIds.length
    ? await db.select({ id: agents.id, squadId: agents.squadId }).from(agents).where(inArray(agents.id, agentScopeIds))
    : []
  const agentSquads = new Map(agentScopeRows.map((agent) => [agent.id, agent.squadId] as const))
  const visibleSchedules = await filterToAccessibleSquads(identity, schedules, (schedule) =>
    scheduleSquadId(schedule, agentSquads)
  )
  const visibleSquadIds = [
    ...new Set(
      visibleSchedules
        .map((schedule) => scheduleSquadId(schedule, agentSquads))
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const readableSquads = new Set(
    (
      await Promise.all(
        visibleSquadIds.map(
          async (squadId) => [squadId, await hasPermission(identity, 'schedules:read', squadId)] as const
        )
      )
    )
      .filter(([, readable]) => readable)
      .map(([squadId]) => squadId)
  )
  const readableSchedules = visibleSchedules.filter((schedule) => {
    const squadId = scheduleSquadId(schedule, agentSquads)
    return squadId ? readableSquads.has(squadId) : false
  })
  c.set('authzChecked', true)
  return c.json(readableSchedules.map((s) => s.toJson()))
})

// GET /api/schedules/:id
schedulesRouter.get('/:id', requireEntityPermission('schedules:read', loadScheduleSquadId), async (c) => {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Not found' }, 404)
  return c.json(schedule.toJson())
})

// POST /api/schedules
schedulesRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const denial = await requireBodySchedulePermission(c, 'schedules:create', body)
    if (denial) return denial
    if (body.action?.type === 'create_work_stream' && body.action.workflow)
      await authorizeWorkflowSource(c.get('identity')!, workflowSourceSchema.parse(body.action.workflow), body.scopeId)
    const schedule = await Schedule.create(body)
    return c.json(schedule.toJson(), 201)
  } catch (error) {
    if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
    return c.json({ error: safeScheduleError(error, 'Invalid schedule request.') }, 400)
  }
})

// PATCH /api/schedules/:id
schedulesRouter.patch('/:id', requireEntityPermission('schedules:update', loadScheduleSquadId), async (c) => {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Not found' }, 404)

  try {
    const body = await c.req.json()
    if (body.scopeType !== undefined || body.scopeId !== undefined) {
      const nextScopeType = (body.scopeType ?? schedule.scopeType) as ScheduleScopeType
      const nextScopeId = (body.scopeId ?? schedule.scopeId) as string
      const identity: Identity | undefined = c.get('identity')
      if (!identity || !(await canAccessScheduleScope(identity, 'schedules:update', nextScopeType, nextScopeId))) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }
    const action = body.action ?? schedule.action
    if (action.type === 'create_work_stream' && action.workflow)
      await authorizeWorkflowSource(
        c.get('identity')!,
        workflowSourceSchema.parse(action.workflow),
        body.scopeId ?? schedule.scopeId
      )
    await schedule.update(body)
    return c.json(schedule.toJson())
  } catch (error) {
    if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
    return c.json({ error: safeScheduleError(error, 'Invalid schedule request.') }, 400)
  }
})

// DELETE /api/schedules/:id
schedulesRouter.delete('/:id', requireEntityPermission('schedules:delete', loadScheduleSquadId), async (c) => {
  await Schedule.delete(c.req.param('id'))
  return c.body(null, 204)
})

// POST /api/schedules/:id/trigger
schedulesRouter.post('/:id/trigger', requireEntityPermission('schedules:trigger', loadScheduleSquadId), async (c) => {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Not found' }, 404)

  try {
    await schedule.trigger()
    return c.json({ triggered: true, schedule: schedule.toJson() })
  } catch (error) {
    return c.json({ error: safeScheduleError(error, 'Scheduled action failed. Inspect Core logs for details.') }, 500)
  }
})

// POST /api/schedules/:id/enable
schedulesRouter.post('/:id/enable', requireEntityPermission('schedules:update', loadScheduleSquadId), async (c) => {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Not found' }, 404)

  try {
    await schedule.enable()
    return c.json(schedule.toJson())
  } catch (error) {
    return c.json({ error: safeScheduleError(error) }, 400)
  }
})

// POST /api/schedules/:id/disable
schedulesRouter.post('/:id/disable', requireEntityPermission('schedules:update', loadScheduleSquadId), async (c) => {
  const schedule = await Schedule.find(c.req.param('id'))
  if (!schedule) return c.json({ error: 'Not found' }, 404)

  await schedule.disable()
  return c.json(schedule.toJson())
})

// POST /api/schedules/:id/webhook/enable
schedulesRouter.post(
  '/:id/webhook/enable',
  requireEntityPermission('schedules:update', loadScheduleSquadId),
  async (c) => {
    const schedule = await Schedule.find(c.req.param('id'))
    if (!schedule) return c.json({ error: 'Not found' }, 404)

    // Get base URL from request or config
    const baseUrl = c.req.header('x-forwarded-host')
      ? `${c.req.header('x-forwarded-proto') || 'https'}://${c.req.header('x-forwarded-host')}`
      : new URL(c.req.url).origin

    try {
      const result = await schedule.enableWebhook(baseUrl)
      return c.json(result)
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
      return c.json({ error: safeScheduleError(error, 'Invalid schedule request.') }, 400)
    }
  }
)

// POST /api/schedules/:id/webhook/disable
schedulesRouter.post(
  '/:id/webhook/disable',
  requireEntityPermission('schedules:update', loadScheduleSquadId),
  async (c) => {
    const schedule = await Schedule.find(c.req.param('id'))
    if (!schedule) return c.json({ error: 'Not found' }, 404)

    await schedule.disableWebhook()
    return c.json(schedule.toJson())
  }
)

// POST /api/schedules/:id/webhook/regenerate-token
schedulesRouter.post(
  '/:id/webhook/regenerate-token',
  requireEntityPermission('schedules:update', loadScheduleSquadId),
  async (c) => {
    const schedule = await Schedule.find(c.req.param('id'))
    if (!schedule) return c.json({ error: 'Not found' }, 404)

    // Get base URL from request or config
    const baseUrl = c.req.header('x-forwarded-host')
      ? `${c.req.header('x-forwarded-proto') || 'https'}://${c.req.header('x-forwarded-host')}`
      : new URL(c.req.url).origin

    try {
      const result = await schedule.regenerateWebhookToken(baseUrl)
      return c.json(result)
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status)
      return c.json({ error: safeScheduleError(error, 'Invalid schedule request.') }, 400)
    }
  }
)

export { schedulesRouter }

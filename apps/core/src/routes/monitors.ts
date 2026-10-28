import { Hono } from 'hono'
import { Monitor, type MonitorStatus } from '../entities/Monitor'
import { Agent } from '../entities/Agent'
import { monitorSupervisor } from '../services/monitors/monitor-supervisor'
import { getSandboxManager } from '../services/sandbox'
import { monitorDir, monitorWorkRoot, shellQuote } from '../services/monitors/launcher'
import { requireAgentResourcePermission } from '../middleware/require-agent-resource-permission'
import {
  getAccessibleSquadIds,
  hasAgentResourcePermission,
  hasPermission,
  identityUserId,
  isUserlessAgentIdentity,
  type AgentResourceTarget,
} from '../services/rbac'
import type { Identity } from '../services/rbac'
import { routeParam } from '../lib/route-param'

const VALID_STATUSES = new Set<MonitorStatus>([
  'starting',
  'running',
  'exited',
  'failed',
  'timed-out',
  'canceling',
  'canceled',
  'overload',
])
const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const monitorsRouter = new Hono()

function parseStatus(value?: string): { status?: MonitorStatus[]; error?: string } {
  if (!value) return {}
  const statuses = value.split(',').filter(Boolean)
  if (statuses.length === 0) return { error: 'status must include at least one value' }
  const invalid = statuses.find((status) => !VALID_STATUSES.has(status as MonitorStatus))
  if (invalid) return { error: `invalid status: ${invalid}` }
  return { status: statuses as MonitorStatus[] }
}

function validateId(value: string, name: string): string | null {
  if (!value || !ID_PATTERN.test(value)) return `${name} must contain only letters, numbers, underscores, or hyphens`
  return null
}

function parseTail(value?: string): { tail?: number; error?: string } {
  if (value === undefined) return { tail: 100 }
  if (!/^\d+$/.test(value)) return { error: 'tail must be a positive integer' }
  const tail = Number(value)
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 500) return { error: 'tail must be between 1 and 500' }
  return { tail }
}

async function monitorAgentTarget(id: string): Promise<AgentResourceTarget | null> {
  if (validateId(id, 'id') || !UUID_PATTERN.test(id)) return { squadId: null, ownerUserId: null }
  const monitor = await Monitor.find(id)
  if (!monitor) return null
  return Agent.find(monitor.agentId)
}

monitorsRouter.get('/', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)

  const parsed = parseStatus(c.req.query('status'))
  if (parsed.error) return c.json({ error: parsed.error }, 400)
  const agentId = c.req.query('agentId')
  const squadId = c.req.query('squadId')
  if (agentId && squadId) return c.json({ error: 'agentId and squadId cannot both be provided' }, 400)
  if (agentId) {
    const error = validateId(agentId, 'agentId')
    if (error) return c.json({ error }, 400)
  }
  if (squadId) {
    const error = validateId(squadId, 'squadId')
    if (error) return c.json({ error }, 400)
  }

  if (agentId) {
    const agent = await Agent.find(agentId)
    if (!(await hasAgentResourcePermission(identity, agent, 'monitors:read'))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const rows = await Monitor.listForAgent(agentId, { status: parsed.status })
    return c.json(rows.map((monitor) => monitor.toJson()))
  }

  if (squadId) {
    const allowed = await hasPermission(identity, 'monitors:read', squadId)
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    const rows = await Monitor.listForSquad(squadId, { status: parsed.status })
    return c.json(rows.map((monitor) => monitor.toJson()))
  }

  // No filter: listRecent across ALL squads → filtered-list
  // First determine what squads the identity can access
  const accessible = await getAccessibleSquadIds(identity)
  const rows = await Monitor.listRecent(200, { status: parsed.status })
  const uniqueAgentIds = [...new Set(rows.map((m) => m.agentId))]
  const agentMap = new Map<string, AgentResourceTarget | null>()
  for (const agentId of uniqueAgentIds) agentMap.set(agentId, await Agent.find(agentId))

  const accessibleSet = accessible === 'all' ? null : new Set(accessible)
  const ownerUserId = identityUserId(identity)
  const unownedAllowed = !isUserlessAgentIdentity(identity) && (await hasPermission(identity, 'monitors:read'))
  const visibleRows = rows.filter((monitor) => {
    const target = agentMap.get(monitor.agentId)
    if (!target) return false
    if (target.squadId) return accessibleSet === null || accessibleSet.has(target.squadId)
    if (target.ownerUserId) return ownerUserId === target.ownerUserId
    return unownedAllowed
  })
  if (accessibleSet?.size === 0 && visibleRows.length === 0) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return c.json(visibleRows.map((monitor) => monitor.toJson()))
})

monitorsRouter.get(
  '/:id',
  requireAgentResourcePermission('monitors:read', (c) => monitorAgentTarget(routeParam(c, 'id'))),
  async (c) => {
    const id = c.req.param('id')
    const error = validateId(id, 'id')
    if (error) return c.json({ error }, 400)
    const monitor = await Monitor.find(id)
    if (!monitor) return c.json({ error: 'Not found' }, 404)
    return c.json(monitor.toJson())
  }
)

monitorsRouter.get(
  '/:id/logs',
  requireAgentResourcePermission('monitors:read', (c) => monitorAgentTarget(routeParam(c, 'id'))),
  async (c) => {
    const id = c.req.param('id')
    const idError = validateId(id, 'id')
    if (idError) return c.json({ error: idError }, 400)
    const parsedTail = parseTail(c.req.query('tail'))
    if (parsedTail.error) return c.json({ error: parsedTail.error }, 400)
    const monitor = await Monitor.find(id)
    if (!monitor) return c.json({ error: 'Not found' }, 404)
    const manager = getSandboxManager()
    const squadId = (await Agent.find(monitor.agentId))?.squadId ?? undefined
    const workRoot = monitorWorkRoot({ squadId, sandboxId: monitor.sandboxId })
    const logFile = `${monitorDir(workRoot, monitor.id)}/logs/current.log`
    if ((await manager.execStatus(monitor.sandboxId, ['bash', '-lc', `test -f ${shellQuote(logFile)}`])) !== 0) {
      return c.json({ lines: [], note: 'log file not found' })
    }
    const out = await manager.exec(monitor.sandboxId, [
      'bash',
      '-lc',
      `tail -n ${parsedTail.tail} ${shellQuote(logFile)}`,
    ])
    return c.json({ lines: out.toString().split('\n').filter(Boolean) })
  }
)

monitorsRouter.post(
  '/:id/cancel',
  requireAgentResourcePermission('monitors:write', (c) => monitorAgentTarget(routeParam(c, 'id')), {
    allowGlobalOverride: true,
  }),
  async (c) => {
    const id = c.req.param('id')
    const error = validateId(id, 'id')
    if (error) return c.json({ error }, 400)
    const monitor = await Monitor.find(id)
    if (!monitor) return c.json({ error: 'Not found' }, 404)
    await monitorSupervisor.cancel(monitor.id)
    const fresh = await Monitor.mustFind(monitor.id)
    return c.json(fresh.toJson())
  }
)

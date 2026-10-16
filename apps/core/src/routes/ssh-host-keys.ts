import type { Context } from 'hono'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { eq, inArray } from 'drizzle-orm'
import { db, machines, squads, sshTrustTargets } from '../db'
import { createLogger } from '../lib/infra/logger'
import { requirePermission, requireSquadPermission } from '../middleware'
import { userSessionRequired } from '../services/auth/user-session-required'
import type { MemoryConfig } from '../services/memory/sync/types'
import { hasPermission, type Identity } from '../services/rbac'
import type { HostKeyScanner } from '../services/remote-hosts/host-keys'
import {
  ensureTrustTarget,
  getTrustTarget,
  memoryGitTrustSpec,
  refreshTrustTarget,
  rejectTrustKey,
  toPublicTrustTargets,
  TrustDecisionError,
  trustTrustKey,
  type TrustTarget,
  type TrustTargetSpec,
} from '../services/ssh-trust'

const log = createLogger('ssh-host-keys-routes')

/**
 * Host keys of the SSH endpoints Core connects to itself (`services/ssh-trust`):
 * machines and exe.dev (instance surface, `machines:*`), and squad memory git
 * remotes (squad surface, `memory:*`). Fetching keys never trusts one; trusting
 * or rejecting a key is a decision only a signed-in PERSON may make — never an
 * agent, a system token or the ownerless bootstrap session, whatever
 * permissions they hold.
 */

const MACHINE_KINDS = ['machine', 'exe-machine', 'exe-api']

function machineIdOf(target: Pick<TrustTarget, 'scope'>): string | null {
  return target.scope.match(/^machine:(.+)$/)?.[1] ?? null
}

/** The memory git endpoints a squad's current sync config uses. */
async function memoryGitSpecs(squadId: string): Promise<TrustTargetSpec[]> {
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  const memory = (squad?.metadata as { memory?: MemoryConfig } | null)?.memory
  const specs = new Map<string, TrustTargetSpec>()
  for (const provider of memory?.sync?.providers ?? []) {
    if (provider.type !== 'git' || typeof provider.repoUrl !== 'string') continue
    const spec = memoryGitTrustSpec(squadId, provider.repoUrl)
    if (spec) specs.set(spec.scope, spec)
  }
  return [...specs.values()]
}

export function createSshHostKeysRouter(deps: { scanner?: HostKeyScanner } = {}) {
  const app = new Hono()

  async function requirePerson(c: Context, action: string): Promise<{ userId: string } | { response: Response }> {
    const identity = c.get('identity') as Identity | undefined
    if (identity?.type === 'user') return { userId: identity.userId }
    return { response: await userSessionRequired(c, identity, action) }
  }

  /**
   * Guard for one endpoint: memory git needs the squad's memory:write, every
   * other endpoint machines:write. Marks the request authz-checked (also on
   * deny paths, like the shared guards) and stashes the target.
   */
  const requireTargetWrite = createMiddleware<{ Variables: { trustTarget: TrustTarget } }>(async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const target = await getTrustTarget(c.req.param('id') as string)
    if (!target) return c.json({ error: 'Not found' }, 404)
    const allowed =
      target.kind === 'memory-git'
        ? !!target.squadId && (await hasPermission(identity, 'memory:write', target.squadId))
        : await hasPermission(identity, 'machines:write')
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('trustTarget', target)
    return next()
  })

  async function view(targetId: string) {
    const target = await getTrustTarget(targetId)
    return target ? (await toPublicTrustTargets([target]))[0] : null
  }

  // GET /api/ssh-host-keys — machines (of existing machine rows) and exe.dev.
  app.get('/', requirePermission('machines:read'), async (c) => {
    const targets = await db.select().from(sshTrustTargets).where(inArray(sshTrustTargets.kind, MACHINE_KINDS))
    const ids = targets.map(machineIdOf).filter((id): id is string => !!id)
    const existing = new Set(
      ids.length
        ? (await db.select({ id: machines.id }).from(machines).where(inArray(machines.id, ids))).map((m) => m.id)
        : []
    )
    const live = targets.filter((t) => {
      const id = machineIdOf(t)
      return id === null || existing.has(id)
    })
    const views = await toPublicTrustTargets(live)
    return c.json(views.map((v, i) => ({ ...v, machineId: machineIdOf(live[i]) })))
  })

  // GET /api/ssh-host-keys/squad/:squadId — the squad's memory git remotes.
  app.get('/squad/:squadId', requireSquadPermission('memory:read', 'squadId'), async (c) => {
    const targets: TrustTarget[] = []
    for (const spec of await memoryGitSpecs(c.req.param('squadId'))) targets.push(await ensureTrustTarget(spec))
    return c.json(await toPublicTrustTargets(targets))
  })

  // POST /api/ssh-host-keys/:id/scan — fetch the endpoint's keys (no login); new ones are pending.
  app.post('/:id/scan', requireTargetWrite, async (c) => {
    const target = c.get('trustTarget')
    const { error } = await refreshTrustTarget(target, deps.scanner)
    return c.json({ ...(await view(target.id)), ...(error ? { fetchError: error } : {}) })
  })

  async function decide(c: Context, decision: 'trust' | 'reject') {
    const target = c.get('trustTarget') as TrustTarget
    const person = await requirePerson(c, 'confirm SSH host keys')
    if ('response' in person) return person.response
    const keyId = c.req.param('keyId') as string
    try {
      if (decision === 'trust') await trustTrustKey(target.id, keyId, person.userId)
      else await rejectTrustKey(target.id, keyId, person.userId)
    } catch (err) {
      if (err instanceof TrustDecisionError) return c.json({ error: err.message }, err.status)
      throw err
    }
    log.info(`host key ${keyId} for ${target.scope}: ${decision} by user ${person.userId}`)
    return c.json(await view(target.id))
  }

  // POST /api/ssh-host-keys/:id/keys/:keyId/trust|reject — a PERSON's decision.
  app.post('/:id/keys/:keyId/trust', requireTargetWrite, (c) => decide(c, 'trust'))
  app.post('/:id/keys/:keyId/reject', requireTargetWrite, (c) => decide(c, 'reject'))

  return app
}

export default createSshHostKeysRouter()

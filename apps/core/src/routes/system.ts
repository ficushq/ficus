import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { createLogger } from '../lib/infra/logger'
import { getLocalEventForwardingDiagnostics, notify } from '../lib/infra/local-events'
import { resourceDiagnostics } from '../lib/infra/resource-diagnostics'
import { RESTART_EXIT_CODE, SYSTEM_RESTART_CHANNEL } from '../lib/infra/system-restart'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'
import { MaintenanceLeaseConflict, maintenanceStore } from '../services/maintenance'
import { getSandboxManager } from '../services/sandbox/factory'
import { sandboxRecoveryWatch } from '../services/sandbox/recovery-watch'
import { wsManager } from '../services/ws/manager'
import { storageMonitorService } from '../services/storage/monitor'
import { parseJsonBody } from './json-body'

const log = createLogger('system')
const app = new Hono()

const adminHoldSchema = z.object({ active: z.boolean(), reason: z.string().trim().max(500).optional() }).strict()
const leaseSchema = z
  .object({ holder: z.string().trim().min(1).max(200), ttlSeconds: z.number().int().min(120).max(600) })
  .strict()
const leaseIdSchema = z.string().uuid()

const ensureMaintenanceInitialized: MiddlewareHandler = async (_c, next) => {
  // Idempotent INSERT ... ON CONFLICT is intentionally performed per request:
  // startup and API traffic may race, and tests/restore flows can recreate the
  // database after this router module was loaded.
  await maintenanceStore.initialize()
  await next()
}
app.use('/pause', ensureMaintenanceInitialized)
app.use('/pause/*', ensureMaintenanceInitialized)

let signalMaintenanceImpl = async (generation: number): Promise<void> => {
  await notify('instance_maintenance_changed', String(generation))
}

export function setSignalMaintenanceForTests(impl?: (generation: number) => Promise<void>): void {
  signalMaintenanceImpl = impl ?? (async (generation) => notify('instance_maintenance_changed', String(generation)))
}

async function signalMaintenance(generation: number): Promise<void> {
  try {
    await signalMaintenanceImpl(generation)
  } catch (error) {
    // The mutation is already committed. Delivery only accelerates worker
    // convergence; the database poller is the authoritative backstop.
    log.warn(`Best-effort maintenance signal failed for generation ${generation}:`, error)
  }
}

app.get('/pause', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const snapshot = await maintenanceStore.read()
  return c.json({
    effective: snapshot.effective,
    phase: snapshot.phase,
  })
})

app.get('/pause/details', requirePermission('system:pause'), async (c) => c.json(await maintenanceStore.read()))

app.put('/pause/admin', requirePermission('system:pause'), async (c) => {
  const identity: Identity = c.get('identity')
  if (identity.type === 'system') return c.json({ error: 'System tokens cannot change the administrator hold' }, 403)
  const body = await parseJsonBody(c)
  const parsed = adminHoldSchema.safeParse(body.ok ? body.value : undefined)
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400)
  const result = await maintenanceStore.setAdminHold({ ...parsed.data, actor: auditActor(identity) })
  await signalMaintenance(result.generation)
  return c.json(result)
})

app.put('/pause/platform-lease/:leaseId', requirePermission('system:pause'), async (c) => {
  const identity: Identity = c.get('identity')
  if (identity.type !== 'system') return c.json({ error: 'Platform leases require a system token' }, 403)
  const leaseId = leaseIdSchema.safeParse(c.req.param('leaseId'))
  const parsedBody = await parseJsonBody(c)
  const body = leaseSchema.safeParse(parsedBody.ok ? parsedBody.value : undefined)
  if (!leaseId.success || !body.success) return c.json({ error: 'Invalid request' }, 400)
  try {
    const result = await maintenanceStore.acquireOrRenewLease({
      leaseId: leaseId.data,
      ownerTokenId: identity.systemTokenId,
      actor: auditActor(identity),
      ...body.data,
    })
    await signalMaintenance(result.generation)
    return c.json(result)
  } catch (error) {
    if (error instanceof MaintenanceLeaseConflict) return c.json({ error: error.message }, 409)
    throw error
  }
})

app.delete('/pause/platform-lease/:leaseId', requirePermission('system:pause'), async (c) => {
  const identity: Identity = c.get('identity')
  if (identity.type !== 'system') return c.json({ error: 'Platform leases require a system token' }, 403)
  const leaseId = leaseIdSchema.safeParse(c.req.param('leaseId'))
  if (!leaseId.success) return c.json({ error: 'Invalid lease ID' }, 400)
  try {
    const result = await maintenanceStore.releaseLease({
      leaseId: leaseId.data,
      ownerTokenId: identity.systemTokenId,
      actor: auditActor(identity),
    })
    await signalMaintenance(result.generation)
    return c.json(result)
  } catch (error) {
    if (error instanceof MaintenanceLeaseConflict) return c.json({ error: error.message }, 409)
    throw error
  }
})

app.get('/storage', requirePermission('system:logs'), async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(await storageMonitorService.read())
})

app.post('/storage/refresh', requirePermission('system:logs'), async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(await storageMonitorService.refresh())
})

app.get('/storage/status', requirePermission('system:logs'), async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(await storageMonitorService.status())
})

app.get('/diagnostics', requirePermission('system:logs'), (c) => {
  const memory = process.memoryUsage()
  const websockets = wsManager.getDiagnostics()
  const lifecycle = resourceDiagnostics.snapshot()
  const portForwardOwner = getSandboxManager().getResourceDiagnostics?.().portForward ?? {
    tracked: 0,
    live: 0,
    starting: 0,
    admissionOwners: 0,
  }
  c.header('Cache-Control', 'no-store')
  return c.json({
    process: {
      role: 'api' as const,
      uptimeSeconds: process.uptime(),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBufferBytes: memory.arrayBuffers,
    },
    resources: {
      ...lifecycle,
      port_forward: { ...lifecycle.port_forward, ...portForwardOwner },
      websocket: { active: websockets.clients },
      websocket_subscription: { active: websockets.subscriptions },
      recovery_watch: sandboxRecoveryWatch.getDiagnostics(),
      local_event_forward: getLocalEventForwardingDiagnostics(),
    },
  })
})

/**
 * How long the api waits for the worker to acknowledge the restart signal
 * before restarting itself regardless. The transport already bounds a hung peer
 * at 5s; this is tighter because an operator is waiting on the response and the
 * signal is best-effort either way.
 */
const RESTART_SIGNAL_TIMEOUT_MS = 2_000

/**
 * Ask the worker to restart too. Best-effort and bounded: if the worker is
 * down, unreachable or slow, the api STILL restarts (the operator asked for a
 * restart, and a worker that is already down will be brought back by its own
 * supervisor). Failure is logged, never surfaced.
 */
async function signalWorkerRestart(): Promise<void> {
  const payload = JSON.stringify({ requestedAt: new Date().toISOString(), source: 'api' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      notify(SYSTEM_RESTART_CHANNEL, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('worker restart signal timed out')), RESTART_SIGNAL_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    log.warn('Best-effort worker restart signal failed; restarting the api anyway:', error)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Restart BOTH Ficus processes. Useful after updating secrets that are read once
 * at startup (e.g., Discord gateway token).
 *
 * tau-api and tau-worker are separate units with no coupling, so this handler
 * first signals the worker over local-events (`SYSTEM_RESTART_CHANNEL`; the
 * worker runs its graceful shutdown and exits non-zero — see
 * `lib/infra/system-restart.ts`), then exits this process. The exit is delayed
 * so the 200 below reaches the caller first.
 *
 * Exit NON-ZERO on an intentional restart (PR #1051): systemd runs both units
 * with `Restart=on-failure` (scripts/setup/systemd/ficus-*.service.tmpl), which
 * restarts ONLY on a non-zero exit — a clean exit(0) is treated as an
 * intentional success and the unit stays DOWN. K8s (`restartPolicy: Always`)
 * restarts on any exit code, so non-zero is correct for both orchestrators.
 */
app.post('/restart', requirePermission('system:restart'), async (c) => {
  log.info('Restart requested via API — signalling worker, then exiting for supervisor restart')
  await signalWorkerRestart()
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 500)
  return c.json({ restarting: true })
})

export default app

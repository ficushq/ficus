import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getBunServer } from 'hono/bun'
import { createLogger } from '../lib/infra/logger'
import { getSandboxProvisionErrorResponse } from './sandbox-provision-error'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { AmbiguousPrefixError, uuidPrefixCondition } from '../db/prefix-match'
import type { CreateLocalDeploymentInput, LocalDeployment } from '@ficus/shared'
import { db, appDeployments } from '../db'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Squad } from '../entities/Squad'
import { ensureSquadSandbox } from '../services/sandbox/ensure'
import {
  archiveLocalDeploymentRecord,
  createLocalDeployment,
  getLocalDeployment,
  listLocalDeployments,
  stopLocalDeploymentRecord,
} from '../services/deploy/local-deployment-service'
import { LocalDeploymentProcessSupervisor } from '../services/deploy/local-deployment-process-supervisor'
import { LocalDeploymentLogPathOutsideWorkspaceError } from '../services/deploy/local-deployment-log-path'
import {
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
  startManagedLocalDeployment,
} from '../services/deploy/local-deployment-health'
import { normalizeLocalDeploymentInput } from '../services/deploy/local-deployment-validation'
import { type LocalAppProxyServer, proxyLocalDeploymentRequest } from '../services/deploy/local-deployment-proxy'
import { localDeploymentProxyJsonError } from '../services/deploy/local-deployment-proxy-response'
import { deploymentProviders } from '../services/deploy/providers'
import { requirePermission, requireSquadPermission } from '../middleware'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import {
  LocalDeploymentPortInUseError,
  LocalDeploymentPortUnavailableError,
} from '../services/deploy/local-deployment-ports'

const AMBIGUOUS_LOCAL_DEPLOYMENT_LINK_ERROR = 'This app link is no longer unique — get a fresh URL.'

const deploymentEnvironmentSchema = z.enum(['preview', 'staging', 'production'])
const deploymentStatusSchema = z.enum(['planned', 'deploying', 'ready', 'failed', 'rolled_back', 'destroyed'])
const deploymentCostRiskSchema = z.enum(['none', 'low', 'metered', 'paid_required'])
const metadataSchema = z.record(z.string(), z.unknown()).refine((metadata) => !containsSecretLikeKey(metadata), {
  message: 'Deployment metadata must not contain secrets or tokens',
})

const createDeploymentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(100),
  url: z.string().url().optional().nullable(),
  providerProjectUrl: z.string().url().optional().nullable(),
  environment: deploymentEnvironmentSchema.optional(),
  status: deploymentStatusSchema.optional(),
  costRisk: deploymentCostRiskSchema.optional(),
  logsCommand: z.string().optional().nullable(),
  rollbackCommand: z.string().optional().nullable(),
  metadata: metadataSchema.optional(),
})

const updateDeploymentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().url().optional().nullable(),
  providerProjectUrl: z.string().url().optional().nullable(),
  environment: deploymentEnvironmentSchema.optional(),
  status: deploymentStatusSchema.optional(),
  costRisk: deploymentCostRiskSchema.optional(),
  logsCommand: z.string().optional().nullable(),
  rollbackCommand: z.string().optional().nullable(),
  metadata: metadataSchema.optional(),
})

interface DeploymentsRouteDependencies {
  ensureSquadSandbox: typeof ensureSquadSandbox
  supervisor: Pick<
    LocalDeploymentProcessSupervisor,
    | 'startManagedLocalDeployment'
    | 'stopLocalDeployment'
    | 'tailLogs'
    | 'streamLogs'
    | 'resolveAttachedLogPath'
    | 'tailAttachedLogs'
    | 'streamAttachedLogs'
  >
  /** The route only ever refreshes BY ID (the health module also accepts an
   *  already-loaded row, which only the health poller has). */
  refreshLocalDeploymentHealth: (localDeploymentId: string) => Promise<LocalDeployment>
  restartManagedLocalDeployment: typeof restartManagedLocalDeployment
  proxyLocalDeploymentRequest: typeof proxyLocalDeploymentRequest
}

const log = createLogger('deployments')

/**
 * Only a MANAGED local deployment has logs: Ficus starts it through the launcher
 * script, which tees the app's combined output into
 * `<workspace>/.ficus/local-deployments/<id>/logs/current.log`. An ATTACHED one
 * is a process Ficus never started — the agent ran it itself and only registered
 * the port — so that file is never written by anything.
 *
 * Both log endpoints used to read it regardless of mode, and `streamLogs` even
 * `touch`es it before `tail -F`, so an attached app produced a 200 SSE response
 * that stayed open forever emitting nothing: the web viewer sat on "Waiting for
 * logs…" indefinitely (no error to show, because nothing failed), while every
 * open viewer leaked a connection and a `tail -F` child following an empty file.
 * Answer with the reason instead, in the same `[ficus] ` channel the launcher
 * banner and the `[stderr] ` notices already use, so every client (web, CLI,
 * agents) renders it as the first log line rather than waiting on nothing.
 */
const ATTACHED_LOGS_NOTICE =
  '[ficus] No logs are captured for this app: it is attached — Ficus did not start it, so it never sees its output. ' +
  'Its output is wherever the process was started (its terminal, tmux session, or a log file it writes itself). ' +
  'To have Ficus capture logs, register the app as managed so Ficus runs the command.'

/**
 * An attached app DID register a log path, but the file is not there / not
 * readable in its sandbox (yet). Same one-line `[ficus]` channel so the viewer
 * gets a reason instead of silence, without failing the request.
 */
const ATTACHED_LOG_UNAVAILABLE_NOTICE = (logPath: string) =>
  `[ficus] No logs yet: the registered log file does not exist or could not be read in the sandbox: ${logPath}`

let dependencyOverrides: Partial<DeploymentsRouteDependencies> = {}

function getDependencies(): DeploymentsRouteDependencies {
  return {
    ensureSquadSandbox: dependencyOverrides.ensureSquadSandbox ?? ensureSquadSandbox,
    supervisor: dependencyOverrides.supervisor ?? new LocalDeploymentProcessSupervisor(),
    refreshLocalDeploymentHealth: dependencyOverrides.refreshLocalDeploymentHealth ?? refreshLocalDeploymentHealth,
    restartManagedLocalDeployment: dependencyOverrides.restartManagedLocalDeployment ?? restartManagedLocalDeployment,
    proxyLocalDeploymentRequest: dependencyOverrides.proxyLocalDeploymentRequest ?? proxyLocalDeploymentRequest,
  }
}

export function configureDeploymentsRouteDependencies(overrides: Partial<DeploymentsRouteDependencies> = {}): void {
  dependencyOverrides = overrides
}

/**
 * Resolve the squadId for an app deployment by its id.
 * Returns null when the deployment is not found (fail-closed: unscoped check
 * so admins pass, unprivileged callers get 403 from requireEntityPermission).
 */
async function appDeploymentSquadId(id: string): Promise<string | null> {
  try {
    const deployment = await findAppDeployment(id)
    return deployment?.squadId ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the squadId for a local deployment by its id.
 * Returns null when the local deployment is not found (fail-closed).
 */
async function localDeploymentSquadId(id: string): Promise<string | null> {
  try {
    const localDeployment = await getLocalDeployment(id)
    return localDeployment?.squadId ?? null
  } catch {
    return null
  }
}

export const deploymentsRouter = new Hono()
  .get('/deploy/providers', requirePermission('deployments:read'), (c) => c.json(deploymentProviders))

  .get(
    '/deployments/:deploymentId',
    requireEntityPermission('deployments:read', (c) => appDeploymentSquadId(c.req.param('deploymentId'))),
    async (c) => {
      const deployment = await findAppDeployment(c.req.param('deploymentId'))
      if (!deployment) return c.json({ error: 'Deployment not found' }, 404)
      return c.json(toAppDeployment(deployment))
    }
  )
  .get('/squads/:id/deployments', requireSquadPermission('deployments:read', 'id'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const conditions = [eq(appDeployments.squadId, squad.id)]
    if (c.req.query('includeArchived') !== 'true') conditions.push(isNull(appDeployments.archivedAt))
    const deployments = await db
      .select()
      .from(appDeployments)
      .where(and(...conditions))
      .orderBy(desc(appDeployments.createdAt))
    return c.json(deployments.map(toAppDeployment))
  })
  .post(
    '/squads/:id/deployments',
    requireSquadPermission('deployments:write', 'id'),
    zValidator('json', createDeploymentSchema),
    async (c) => {
      const squad = await Squad.find(c.req.param('id'))
      if (!squad) return c.json({ error: 'Squad not found' }, 404)
      const input = c.req.valid('json')
      const [deployment] = await db
        .insert(appDeployments)
        .values({
          squadId: squad.id,
          name: input.name,
          provider: input.provider,
          url: input.url ?? null,
          providerProjectUrl: input.providerProjectUrl ?? null,
          environment: input.environment ?? 'preview',
          status: input.status ?? 'planned',
          costRisk: input.costRisk ?? 'none',
          logsCommand: input.logsCommand ?? null,
          rollbackCommand: input.rollbackCommand ?? null,
          metadata: input.metadata ?? {},
        })
        .returning()
      return c.json(toAppDeployment(deployment), 201)
    }
  )
  .delete(
    '/deployments/:deploymentId',
    requireEntityPermission('deployments:delete', (c) => appDeploymentSquadId(c.req.param('deploymentId'))),
    async (c) => {
      const deploymentId = await findAppDeploymentId(c.req.param('deploymentId'))
      if (!deploymentId) return c.json({ error: 'Deployment not found' }, 404)

      const [deployment] = await db
        .update(appDeployments)
        .set({ archivedAt: new Date(), status: 'destroyed', updatedAt: new Date() })
        .where(eq(appDeployments.id, deploymentId))
        .returning()
      return c.json(toAppDeployment(deployment))
    }
  )
  .patch(
    '/deployments/:deploymentId',
    requireEntityPermission('deployments:write', (c) => appDeploymentSquadId(c.req.param('deploymentId'))),
    zValidator('json', updateDeploymentSchema),
    async (c) => {
      const deploymentId = await findAppDeploymentId(c.req.param('deploymentId'))
      if (!deploymentId) return c.json({ error: 'Deployment not found' }, 404)

      const input = c.req.valid('json')
      const [deployment] = await db
        .update(appDeployments)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(appDeployments.id, deploymentId))
        .returning()
      return c.json(toAppDeployment(deployment))
    }
  )
  /**
   * Task C2 — reverse-proxy to the running local-deployment app.
   *
   * This route is intentionally NOT guarded with requireSquadPermission or
   * requireEntityPermission. In-browser asset loads (HTML, JS, CSS) cannot carry a
   * Bearer token, so a traditional RBAC guard would break the app for all browsers.
   *
   * Auth is handled by the global identityMiddleware's _ficus_token query-param bypass:
   * each local deployment has a unique browserAccessToken embedded in its urlPathOrHost.
   * identityMiddleware validates that token and calls next() without setting an identity,
   * so no identity is present on the context for this handler.
   *
   * We set publicRoute = true so any downstream runtime sentinel (e.g. an authzChecked
   * enforcer) knows this route was intentionally left open to browser traffic.
   */
  .all('/app/:localDeploymentId/*', async (c) => {
    c.set('publicRoute', true)
    const routeParameter = c.req.param('localDeploymentId')
    const localDeploymentId = c.get('resolvedLocalDeploymentId') ?? routeParameter
    const path = c.req.path.split(`/api/app/${routeParameter}/`)[1] ?? ''
    try {
      // Bun's server (index.ts hands it to app.fetch as env) accepts WebSocket
      // upgrades and extends this request's idle timeout for a slow app.
      const server = c.env ? getBunServer<LocalAppProxyServer>(c) : undefined
      return await getDependencies().proxyLocalDeploymentRequest(localDeploymentId, c.req.raw, path, server)
    } catch (err) {
      if (err instanceof AmbiguousPrefixError) {
        return localDeploymentProxyJsonError(AMBIGUOUS_LOCAL_DEPLOYMENT_LINK_ERROR, 409)
      }
      // Reaching the app can fail for reasons that are not a Ficus crash: a cold
      // machine, a dropped SSH forward, a runtime with no target support. A bare
      // 500 told an operator nothing — which is how the VM gap presented — so
      // name the layer that failed and keep the cause in the log only.
      log.error(`Local app proxy failed for ${localDeploymentId}`, err)
      return localDeploymentProxyJsonError(
        'Local app is not reachable from Ficus right now. Check the deployment health.',
        502
      )
    }
  })
  .get('/squads/:id/local-deployments', requireSquadPermission('deployments:read', 'id'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    return c.json(await listLocalDeployments(squad.id, { includeArchived: c.req.query('includeArchived') === 'true' }))
  })
  .post('/squads/:id/local-deployments', requireSquadPermission('deployments:write', 'id'), async (c) => {
    const squad = await Squad.find(c.req.param('id'))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)

    let input: CreateLocalDeploymentInput
    try {
      input = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const deps = getDependencies()
    try {
      normalizeLocalDeploymentInput(input, { squadId: squad.id })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }

    let localDeployment: LocalDeployment | null = null
    try {
      await deps.ensureSquadSandbox(squad)
      localDeployment = await createLocalDeployment(squad, input)

      if (localDeployment.mode === 'managed') {
        localDeployment = await startManagedLocalDeployment(localDeployment.id, {
          ensureSquadSandbox: deps.ensureSquadSandbox,
          supervisor: deps.supervisor,
        })
      }

      localDeployment = await deps.refreshLocalDeploymentHealth(localDeployment.id)
      return c.json(localDeployment, 201)
    } catch (err) {
      // Port conflicts are the caller's to fix (omit `port`, or pick another),
      // and no row was created — so they must not be marked crashed, and they
      // are not a server fault. Checked before the crash bookkeeping below,
      // which assumes a deployment exists.
      if (err instanceof LocalDeploymentPortInUseError) return c.json({ error: err.message }, 409)
      if (err instanceof LocalDeploymentPortUnavailableError) return c.json({ error: err.message }, 503)
      // Launch/refresh own guarded failure bookkeeping. Do not turn an
      // unverified transport outcome into a crash or overwrite stop intent.
      const provisioning = getSandboxProvisionErrorResponse(err)
      if (provisioning) {
        if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
        return c.json(provisioning.body, provisioning.status)
      }
      return c.json({ error: (err as Error).message }, 400)
    }
  })
  .get(
    '/local-deployments/:localDeploymentId',
    requireEntityPermission('deployments:read', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)
      return c.json(localDeployment)
    }
  )
  .get(
    '/local-deployments/:localDeploymentId/logs',
    requireEntityPermission('deployments:read', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)
      if (localDeployment.mode === 'attached') {
        if (!localDeployment.logPath) {
          return c.json({ localDeploymentId: localDeployment.id, lines: [ATTACHED_LOGS_NOTICE] })
        }
        const deps = getDependencies()
        try {
          await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
          const result = await deps.supervisor.tailAttachedLogs(
            localDeployment.sandboxId,
            localDeployment.logPath,
            parseTail(c.req.query('tail'))
          )
          const lines =
            result.kind === 'lines' ? result.lines : [ATTACHED_LOG_UNAVAILABLE_NOTICE(localDeployment.logPath)]
          return c.json({ localDeploymentId: localDeployment.id, lines })
        } catch (err) {
          if (err instanceof LocalDeploymentLogPathOutsideWorkspaceError) return c.json({ error: err.message }, 400)
          throw err
        }
      }
      const deps = getDependencies()
      await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
      const tail = parseTail(c.req.query('tail'))
      const lines = await deps.supervisor.tailLogs(localDeployment.sandboxId, localDeployment.id, tail)
      return c.json({ localDeploymentId: localDeployment.id, lines })
    }
  )
  .get(
    '/local-deployments/:localDeploymentId/logs/stream',
    requireEntityPermission('deployments:read', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)
      // Disable reverse-proxy buffering so log lines stream live instead of arriving in one
      // burst when the stream closes (matches the agent/chat SSE endpoints).
      c.header('X-Accel-Buffering', 'no')
      c.header('Cache-Control', 'no-cache, no-transform')
      // Attached: either a one-line reason (no path registered / file not
      // available) followed by close — following nothing would hold a
      // connection and a `tail -F` child open forever — or the registered file.
      if (localDeployment.mode === 'attached') {
        if (!localDeployment.logPath) {
          return streamSSE(c, async (stream) => {
            await stream.writeSSE({ event: 'lines', data: JSON.stringify({ lines: [ATTACHED_LOGS_NOTICE] }) })
          })
        }
        const deps = getDependencies()
        try {
          await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
          // Resolve inside the sandbox per connection: containment is re-pinned
          // against the deployment's own workspace on every read/reconnect.
          const { resolved, exists } = await deps.supervisor.resolveAttachedLogPath(
            localDeployment.sandboxId,
            localDeployment.logPath
          )
          if (!exists) {
            const notice = ATTACHED_LOG_UNAVAILABLE_NOTICE(localDeployment.logPath)
            return streamSSE(c, async (stream) => {
              await stream.writeSSE({ event: 'lines', data: JSON.stringify({ lines: [notice] }) })
            })
          }
          return streamSSE(c, async (stream) =>
            withDeviceStreamRevocation(c.get('authContext'), stream, async (signal) =>
              pumpTailStream(stream, signal, (onLine, onError) =>
                deps.supervisor.streamAttachedLogs(
                  localDeployment.sandboxId,
                  resolved,
                  parseTail(c.req.query('tail')),
                  onLine,
                  onError
                )
              )
            )
          )
        } catch (err) {
          if (err instanceof LocalDeploymentLogPathOutsideWorkspaceError) return c.json({ error: err.message }, 400)
          throw err
        }
      }
      const deps = getDependencies()
      await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
      return streamSSE(c, async (stream) =>
        withDeviceStreamRevocation(c.get('authContext'), stream, async (signal) =>
          pumpTailStream(stream, signal, (onLine, onError) =>
            deps.supervisor.streamLogs(
              localDeployment.sandboxId,
              localDeployment.id,
              parseTail(c.req.query('tail')),
              onLine,
              onError
            )
          )
        )
      )
    }
  )
  .post(
    '/local-deployments/:localDeploymentId/restart',
    requireEntityPermission('deployments:write', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)
      try {
        return c.json(await getDependencies().restartManagedLocalDeployment(localDeployment.id, { allowStopped: true }))
      } catch (err) {
        const provisioning = getSandboxProvisionErrorResponse(err)
        if (provisioning) {
          if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
          return c.json(provisioning.body, provisioning.status)
        }
        return c.json({ error: (err as Error).message }, 400)
      }
    }
  )
  .delete(
    '/local-deployments/:localDeploymentId',
    requireEntityPermission('deployments:delete', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)

      const archived = await archiveLocalDeploymentRecord(localDeployment.id)
      const deps = getDependencies()
      if (localDeployment.mode === 'managed' && localDeployment.processId) {
        try {
          await deps.supervisor.stopLocalDeployment(localDeployment.sandboxId, localDeployment.processId)
        } catch (err) {
          if ((err as Error).message.includes('Sandbox not found')) {
            try {
              await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
              await deps.supervisor.stopLocalDeployment(localDeployment.sandboxId, localDeployment.processId)
            } catch (retryErr) {
              log.warn(`Failed to stop localDeployment process while archiving ${localDeployment.id}:`, retryErr)
            }
          } else {
            log.warn(`Failed to stop localDeployment process while archiving ${localDeployment.id}:`, err)
          }
        }
      }

      return c.json(archived)
    }
  )
  .post(
    '/local-deployments/:localDeploymentId/stop',
    requireEntityPermission('deployments:write', (c) => localDeploymentSquadId(c.req.param('localDeploymentId'))),
    async (c) => {
      const localDeployment = await getLocalDeployment(c.req.param('localDeploymentId'))
      if (!localDeployment) return c.json({ error: 'Local deployment not found' }, 404)

      const stopped = await stopLocalDeploymentRecord(localDeployment.id)
      const deps = getDependencies()
      await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
      if (localDeployment.mode === 'managed' && localDeployment.processId) {
        await deps.supervisor.stopLocalDeployment(localDeployment.sandboxId, localDeployment.processId)
      }

      return c.json(stopped)
    }
  )

type AppDeploymentRow = typeof appDeployments.$inferSelect

async function findAppDeployment(id: string): Promise<AppDeploymentRow | null> {
  const rows = await db.select().from(appDeployments).where(uuidPrefixCondition(appDeployments.id, id)).limit(2)
  if (rows.length === 0) return null
  if (rows.length > 1) throw new AmbiguousPrefixError('deployment', id)
  return rows[0]
}

async function findAppDeploymentId(id: string): Promise<string | null> {
  const deployment = await findAppDeployment(id)
  return deployment?.id ?? null
}

function toAppDeployment(row: AppDeploymentRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function containsSecretLikeKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|password|credential/i.test(key)) return true
    if (containsSecretLikeKey(child)) return true
  }
  return false
}

function parseTail(value: string | undefined): number {
  if (!value) return 100
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 100
  return Math.min(parsed, 1000)
}

/**
 * Shared SSE pump for the log-stream endpoint: buffers lines from a start()
 * callback (a supervisor stream handle) and flushes them as `lines` events
 * until the HTTP stream or the auth revocation signal aborts. Used by both the
 * managed and the attached stream so revocation/cleanup semantics stay
 * identical.
 */
async function pumpTailStream(
  stream: {
    aborted: boolean
    sleep: (ms: number) => Promise<unknown>
    writeSSE: (input: { event: string; data: string }) => Promise<void>
  },
  signal: AbortSignal,
  start: (onLine: (line: string) => void, onError: (error: Error) => void) => { cancel: () => void }
): Promise<void> {
  const pending: string[] = []
  const handle = start(
    (line: string) => pending.push(line),
    (error: Error) => pending.push(`[stderr] ${error.message}`)
  )

  try {
    while (!stream.aborted && !signal.aborted) {
      if (pending.length > 0) {
        await stream.writeSSE({ event: 'lines', data: JSON.stringify({ lines: pending.splice(0) }) })
      }
      await stream.sleep(100)
    }
  } finally {
    handle.cancel()
  }
}

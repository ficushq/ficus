import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { withDedicatedDbTransaction } from '../../db'
import type { LocalDeployment } from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'
import {
  getLocalDeployment,
  listRestartableManagedLocalDeploymentsForSandbox,
  listSandboxIdsWithLiveManagedLocalDeployments,
  markLocalDeploymentsStoppedForSandbox,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { ensureSquadSandbox } from '../sandbox/ensure'
import { isBoxMigrating } from '../machines/queries'
import {
  LocalDeploymentLaunchFailedError,
  LocalDeploymentProcessSupervisor,
  managedLocalDeploymentSessionName,
} from './local-deployment-process-supervisor'
import { observeLocalDeployment, type ScheduleObservationTimeout } from './local-deployment-observation'
import { resolveLocalDeploymentTarget } from './local-deployment-target'

const log = createLogger('local-deployment-health')

export class LocalDeploymentHealthUnavailableError extends Error {
  constructor() {
    super('Sandbox unavailable; app health is unverified. Reconciliation will retry when the box is available.')
  }
}

interface LocalDeploymentHealthDependencies {
  scheduleObservationTimeout?: ScheduleObservationTimeout
  waitForReadinessInterval?: (signal: AbortSignal, ms: number) => Promise<void>
  probeLocalDeploymentHttp: (host: string, port: number, timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>
  ensureSquadSandbox: typeof ensureSquadSandbox
  supervisor: Pick<
    LocalDeploymentProcessSupervisor,
    'hasSession' | 'startManagedLocalDeployment' | 'stopLocalDeployment'
  >
  resolveLocalDeploymentTarget: typeof resolveLocalDeploymentTarget
  /** Reads the box's migration fence (`machine_boxes.migrating`) — the SAME
   *  fence box-migrate.ts's fenceBoxForMigration sets. Consulted by
   *  {@link restartManagedLocalDeployment}'s default `skipIfMigrating` guard;
   *  overridable in tests. */
  isBoxMigrating: typeof isBoxMigrating
}

let dependencyOverrides: Partial<LocalDeploymentHealthDependencies> = {}

function getDependencies(): LocalDeploymentHealthDependencies {
  return {
    scheduleObservationTimeout: dependencyOverrides.scheduleObservationTimeout,
    probeLocalDeploymentHttp: dependencyOverrides.probeLocalDeploymentHttp ?? probeLocalDeploymentHttp,
    ensureSquadSandbox: dependencyOverrides.ensureSquadSandbox ?? ensureSquadSandbox,
    supervisor: dependencyOverrides.supervisor ?? new LocalDeploymentProcessSupervisor(),
    resolveLocalDeploymentTarget: dependencyOverrides.resolveLocalDeploymentTarget ?? resolveLocalDeploymentTarget,
    isBoxMigrating: dependencyOverrides.isBoxMigrating ?? isBoxMigrating,
  }
}

export function configureLocalDeploymentHealthDependencies(
  overrides: Partial<LocalDeploymentHealthDependencies> = {}
): void {
  dependencyOverrides = overrides
}

/**
 * TCP accept is NOT readiness: an SSH -L listener accepts before opening its
 * remote channel. Require an HTTP response from the app, without redirects or
 * reading an unbounded body. Auth/route errors prove a web server is ready;
 * server errors, EOF, malformed responses and timeouts do not.
 */
export async function probeLocalDeploymentHttp(
  host: string,
  port: number,
  timeoutMs = 2000,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const request = http.request({ host, port, path: '/', method: 'GET', agent: false })
    const deadline = setTimeout(() => finish(false), timeoutMs)

    function finish(result: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      request.destroy()
      resolve(result)
    }

    const abort = () => finish(false)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      finish(false)
      return
    }
    request.once('response', (response) => {
      const status = response.statusCode ?? 0
      response.destroy()
      finish(status >= 200 && status < 500)
    })
    request.once('error', () => finish(false))
    request.end()
  })
}

/**
 * Reconcile a snapshot using a compare-and-set write. A stop/archive or newer
 * restart observed during I/O must win over this older health result.
 * Transport failure means unverified/unhealthy, never proof of a crash; throw
 * after recording it so the poller does not restart on that uncertain result.
 */
export async function refreshLocalDeploymentHealth(target: string | LocalDeployment): Promise<LocalDeployment> {
  // Capture caller-owned records before I/O; later mutations must not change
  // the lifecycle snapshot that produced the evidence or its write guard.
  const localDeployment = { ...(typeof target === 'string' ? await requireLocalDeployment(target) : target) }
  if (localDeployment.status === 'stopped' || localDeployment.archivedAt) return localDeployment

  const deps = getDependencies()
  const update = (input: Parameters<typeof updateLocalDeploymentRecord>[1]) =>
    updateLocalDeploymentRecord(localDeployment.id, input, { expectedRecord: localDeployment, onlyLive: true })
  let observed: { missingSession: boolean; healthy: boolean }
  try {
    // No mutating ensure in the observation deadline. The poller owns recovery
    // separately; cold/unreachable executor state is unverified, not a crash.
    observed = await observeLocalDeployment(
      localDeployment.id,
      // Shared evidence must belong to the SAME CAS snapshot and target, not
      // merely the same app id (tmux session names survive every restart).
      JSON.stringify([
        localDeployment.updatedAt,
        localDeployment.status,
        localDeployment.processId,
        localDeployment.restartCount,
        localDeployment.sandboxId,
        localDeployment.port,
        localDeployment.mode,
      ]),
      async (signal) => {
        if (localDeployment.mode === 'managed') {
          const processId = localDeployment.processId ?? managedLocalDeploymentSessionName(localDeployment.id)
          const exists = await deps.supervisor.hasSession(localDeployment.sandboxId, processId, signal)
          signal.throwIfAborted()
          if (!exists) return { missingSession: true, healthy: false }
        }
        const target = await deps.resolveLocalDeploymentTarget(localDeployment.sandboxId, localDeployment.port)
        signal.throwIfAborted()
        const healthy = await deps.probeLocalDeploymentHttp(target.host, target.port, 2000, signal)
        signal.throwIfAborted()
        return { missingSession: false, healthy }
      },
      deps.scheduleObservationTimeout
    )
  } catch {
    await update({ status: 'unhealthy' })
    throw new LocalDeploymentHealthUnavailableError()
  }
  const initialGrace =
    localDeployment.status === 'starting' && Date.now() - new Date(localDeployment.createdAt).getTime() < 10_000
  if (observed.missingSession)
    return initialGrace ? update({ status: 'starting' }) : update({ status: 'crashed', keepSandboxAlive: false })
  if (observed.healthy)
    return update({
      status: 'running',
      keepSandboxAlive: true,
      ...(localDeployment.mode === 'managed' && !localDeployment.processId
        ? { processId: managedLocalDeploymentSessionName(localDeployment.id) }
        : {}),
    })
  return update({ status: initialGrace ? 'starting' : 'unhealthy' })
}

const readinessChecks = new Map<string, { controller: AbortController; settled: Promise<void> }>()

function startReadinessCheck(localDeploymentId: string): void {
  readinessChecks.get(localDeploymentId)?.controller.abort()
  const controller = new AbortController()
  const settled = waitForLocalDeploymentHealthy(localDeploymentId, controller.signal)
    .catch(() => {})
    .finally(() => {
      if (readinessChecks.get(localDeploymentId)?.controller === controller) readinessChecks.delete(localDeploymentId)
    })
  readinessChecks.set(localDeploymentId, { controller, settled })
}

export async function stopLocalDeploymentReadinessChecks(): Promise<void> {
  const checks = [...readinessChecks.values()]
  for (const check of checks) check.controller.abort()
  await Promise.all(checks.map((check) => check.settled))
}

async function waitForLocalDeploymentHealthy(
  localDeploymentId: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  intervalMs = 500
): Promise<void> {
  const start = Date.now()
  while (!signal.aborted && Date.now() - start < timeoutMs) {
    await (dependencyOverrides.waitForReadinessInterval
      ? dependencyOverrides.waitForReadinessInterval(signal, intervalMs)
      : delay(intervalMs, undefined, { signal }))
    try {
      const localDeployment = await refreshLocalDeploymentHealth(localDeploymentId)
      if (localDeployment.status === 'running') return
      if (localDeployment.status === 'crashed' || localDeployment.status === 'stopped' || localDeployment.archivedAt)
        return
    } catch {
      // Keep polling briefly; the regular reconciler will handle persistent failures.
    }
  }
}

export interface RestartLocalDeploymentOptions {
  /**
   * Whether to skip the restart while the deployment's box is mid-migration
   * (`machine_boxes.migrating`). Default `true` — the safe default for EVERY
   * restart TRIGGER (the health poller's crashed/unhealthy self-heal, and
   * ensureSquadSandbox's ensure-triggered restart): without it, a squad
   * migration's quiesce (which marks a managed-always deployment `crashed` so
   * it stays restartable — see {@link stopLocalDeploymentsForSandbox}) is
   * silently undone by a poller tick resurrecting the process on the OLD box
   * mid-archive, racing the tar with live writes.
   *
   * `false` is the ONE deliberate exception: box-migrate.ts's own post-move
   * restart (the row is already repointed to the target; the fence is just a
   * vestige of its own not-yet-finished call — see the module's fence-clear
   * ordering). This still reads the SAME `migrating` column via
   * {@link isBoxMigrating} — it is not a second flag, just a call site that
   * knows it is the migration and chooses not to be gated by its own fence.
   */
  skipIfMigrating?: boolean
  /** Only an explicit operator restart may start a stopped deployment. */
  allowStopped?: boolean
  /** First launch, including managed apps with restartPolicy never. */
  initial?: boolean
  /** Automatic recovery must inspect again after ensure, before killing a session. */
  onlyIfNeeded?: boolean
}

/**
 * Restarts in flight in this process, by deployment id. Each start kills the
 * deployment's tmux session and creates it again under the same name, so two
 * overlapping starts collide: the second `tmux new-session` fails with
 * "duplicate session". A worker restart made that routine — every execution
 * resuming on a squad box ran ensureSquadSandbox's restart at once — so a
 * concurrent caller joins the restart already under way instead.
 */
const restartsInFlight = new Map<string, Promise<LocalDeployment>>()

export function startManagedLocalDeployment(
  localDeploymentId: string,
  collaborators: {
    ensureSquadSandbox: typeof ensureSquadSandbox
    supervisor: Pick<LocalDeploymentProcessSupervisor, 'startManagedLocalDeployment' | 'stopLocalDeployment'>
  }
): Promise<LocalDeployment> {
  const observationSupervisor = getDependencies().supervisor
  return runManagedLocalDeployment(
    localDeploymentId,
    { initial: true },
    {
      ensureSquadSandbox: collaborators.ensureSquadSandbox,
      supervisor: {
        hasSession: (...args) => observationSupervisor.hasSession(...args),
        startManagedLocalDeployment: (args) => collaborators.supervisor.startManagedLocalDeployment(args),
        stopLocalDeployment: (...args) => collaborators.supervisor.stopLocalDeployment(...args),
      },
    }
  )
}

export function restartManagedLocalDeployment(
  localDeploymentId: string,
  opts: RestartLocalDeploymentOptions = {}
): Promise<LocalDeployment> {
  return runManagedLocalDeployment(localDeploymentId, opts)
}

function runManagedLocalDeployment(
  localDeploymentId: string,
  opts: RestartLocalDeploymentOptions,
  collaborators?: Partial<LocalDeploymentHealthDependencies>
): Promise<LocalDeployment> {
  const inFlight = restartsInFlight.get(localDeploymentId)
  if (inFlight) return inFlight
  const restart = restartManagedLocalDeploymentOnce(localDeploymentId, opts, collaborators).finally(() => {
    restartsInFlight.delete(localDeploymentId)
  })
  restartsInFlight.set(localDeploymentId, restart)
  return restart
}

async function restartManagedLocalDeploymentOnce(
  localDeploymentId: string,
  opts: RestartLocalDeploymentOptions,
  collaborators: Partial<LocalDeploymentHealthDependencies> = {}
): Promise<LocalDeployment> {
  const localDeployment = await requireLocalDeployment(localDeploymentId)
  if (localDeployment.archivedAt || (localDeployment.status === 'stopped' && !opts.allowStopped)) return localDeployment
  if (localDeployment.mode !== 'managed') {
    return localDeployment
  }
  if (!opts.initial && localDeployment.restartPolicy !== 'always') {
    return localDeployment
  }
  if (!localDeployment.command?.trim()) {
    throw new Error('Managed localDeployment cannot restart without a command')
  }

  const { ensureSquadSandbox, supervisor, isBoxMigrating: checkMigrating } = { ...getDependencies(), ...collaborators }
  if (opts.skipIfMigrating !== false && (await checkMigrating(localDeployment.sandboxId))) {
    log.info(
      `Skipping restart of managed localDeployment ${localDeploymentId}: box ${localDeployment.sandboxId} is mid-migration`
    )
    return localDeployment
  }
  try {
    if (!opts.initial) await ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
  } catch {
    await updateLocalDeploymentRecord(
      localDeployment.id,
      { status: 'unhealthy' },
      {
        expectedRecord: localDeployment,
      }
    )
    throw new Error('Sandbox unavailable; managed app recovery will retry when the box is available.')
  }
  // API and worker have separate in-memory maps. Fence the short launch/write
  // phase across Core processes too, using a bounded try-lock on a dedicated
  // connection (never hold a shared pool slot while calling other DB helpers).
  // The lock is automatically released on commit, failure or Core loss. A
  // losing caller leaves recovery to the owner or a subsequent poller tick.
  return withDedicatedDbTransaction(async (tx) => {
    const [lock] = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`local-deployment-restart:${localDeployment.id}`}, 0)) as acquired`
    )
    if (!lock.acquired) return requireLocalDeployment(localDeployment.id)
    const current = await requireLocalDeployment(localDeployment.id)
    // A second Core process may have completed recovery while we ensured the
    // box. Its new generation wins; do not immediately kill/restart it again.
    if (current.restartCount !== localDeployment.restartCount || (!opts.initial && current.restartPolicy !== 'always'))
      return current
    if (opts.initial && current.processId) return current
    const explicitlyRestartingStopped = opts.allowStopped && localDeployment.status === 'stopped'
    if (
      current.archivedAt ||
      (current.status === 'stopped' &&
        (!explicitlyRestartingStopped || current.updatedAt !== localDeployment.updatedAt))
    )
      return current

    if (opts.onlyIfNeeded) {
      // Inspect under the SAME launch fence: a creation in another Core may
      // have completed (without changing restartCount) while we ensured.
      const observed = await refreshLocalDeploymentHealth(current.id)
      if (
        observed.status === 'running' ||
        observed.status === 'starting' ||
        observed.status === 'stopped' ||
        observed.archivedAt
      )
        return observed
    }

    let processId: string
    try {
      ;({ processId } = await supervisor.startManagedLocalDeployment({
        localDeploymentId: current.id,
        sandboxId: current.sandboxId,
        command: current.command!,
        cwd: current.cwd,
        port: current.port,
      }))
    } catch (error) {
      const confirmedFailure = error instanceof LocalDeploymentLaunchFailedError
      let recorded = await updateLocalDeploymentRecord(
        current.id,
        confirmedFailure ? { status: 'crashed', keepSandboxAlive: false } : { status: 'unhealthy' },
        {
          expectedRecord: current,
        }
      )
      if (
        !confirmedFailure &&
        !recorded.archivedAt &&
        recorded.restartCount === current.restartCount &&
        ['starting', 'restarting', 'crashed'].includes(recorded.status)
      ) {
        // An older observation can win the first CAS while launch I/O is in
        // flight. Its missing old session does not prove the new launch failed.
        // Reconcile that same generation, but never overwrite stop/new recovery.
        recorded = await updateLocalDeploymentRecord(
          current.id,
          { status: 'unhealthy' },
          {
            expectedRecord: recorded,
            onlyLive: true,
          }
        )
      }
      if (recorded.status === 'stopped' || recorded.archivedAt) {
        // An unknown stream may have launched before disconnecting. Stop intent
        // still owns this stable session, even without a returned processId.
        try {
          await supervisor.stopLocalDeployment(current.sandboxId, managedLocalDeploymentSessionName(current.id))
        } catch {
          log.warn(`LocalDeployment ${current.id}: stop cleanup unverified; check box connectivity`)
        }
      }
      throw new Error(
        confirmedFailure
          ? 'Managed app launch failed; check startup logs. Automatic recovery will retry after cooldown.'
          : 'Managed app launch outcome is unverified; check box connectivity. Reconciliation will inspect before retrying.'
      )
    }

    const restarted = await updateLocalDeploymentRecord(
      current.id,
      {
        status: opts.initial ? 'starting' : 'restarting',
        keepSandboxAlive: true,
        processId,
        restartCount: current.restartCount + (opts.initial ? 0 : 1),
      },
      explicitlyRestartingStopped ? { expectedRecord: current } : { onlyLive: true }
    )

    // A stop/archive that won during launch is authoritative. The session name
    // is stable; explicitly reap the process the losing restart just created.
    if (restarted.status === 'stopped' || restarted.archivedAt) {
      await supervisor.stopLocalDeployment(current.sandboxId, processId)
      return restarted
    }
    if (!opts.initial) startReadinessCheck(current.id)
    return restarted
  })
}

export async function ensureSandboxesForLiveManagedLocalDeployments(): Promise<void> {
  const sandboxIds = await listSandboxIdsWithLiveManagedLocalDeployments()
  for (const sandboxId of sandboxIds) {
    await ensureSquadSandbox(sandboxId.replace(/^squad_/, ''))
  }
}

/**
 * Bring a box's managed deployments back up after the box (re)appears. A
 * deployment whose tmux session is still alive is left alone: Core restarting
 * does not stop the box, so killing a healthy app here only cost it a restart
 * (and raced any other start). A live-but-unhealthy app is the health poller's
 * to restart. One deployment failing does not stop the rest; the first error
 * is rethrown once every deployment has been tried.
 */
export async function restartManagedLocalDeploymentsForSandbox(
  sandboxId: string,
  opts: RestartLocalDeploymentOptions = {}
): Promise<void> {
  const { supervisor } = getDependencies()
  const localDeployments = await listRestartableManagedLocalDeploymentsForSandbox(sandboxId)
  let firstError: unknown
  for (const localDeployment of localDeployments) {
    try {
      if (localDeployment.processId && (await supervisor.hasSession(sandboxId, localDeployment.processId))) continue
      await restartManagedLocalDeployment(localDeployment.id, { ...opts, onlyIfNeeded: true })
    } catch (err) {
      log.warn(`Failed to restart managed localDeployment ${localDeployment.id} on ${sandboxId}:`, err)
      firstError ??= err
    }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Quiesce a sandbox's local deployments for a box migration: ACTUALLY terminate
 * the running managed processes (kill their tmux sessions on the box) BEFORE
 * marking the DB rows stopped/crashed. A box migration archives ~/workspace off
 * the (still-running) old box, so an app writing to the workspace mid-tar would
 * produce an inconsistent archive — the kill must land before the pull.
 *
 * managed-always rows are marked `crashed` (not `stopped`) by
 * markLocalDeploymentsStoppedForSandbox, so they remain in the restartable set
 * for {@link restartManagedLocalDeploymentsForSandbox} to bring back up on the
 * TARGET box once the move is proven.
 *
 * The session kill is `tmux kill-session ... || true` (a no-op on an absent
 * session), so this only rejects if the box exec transport itself fails — in
 * which case the migration must abort pre-archive rather than tar a live tree.
 */
export async function stopLocalDeploymentsForSandbox(sandboxId: string): Promise<void> {
  const supervisor = new LocalDeploymentProcessSupervisor()
  const live = await listRestartableManagedLocalDeploymentsForSandbox(sandboxId)
  for (const localDeployment of live) {
    if (localDeployment.processId) {
      await supervisor.stopLocalDeployment(sandboxId, localDeployment.processId)
    }
  }
  await markLocalDeploymentsStoppedForSandbox(sandboxId)
}

async function requireLocalDeployment(localDeploymentId: string): Promise<LocalDeployment> {
  const localDeployment = await getLocalDeployment(localDeploymentId)
  if (!localDeployment) {
    throw new Error('Sandbox localDeployment not found')
  }
  return localDeployment
}

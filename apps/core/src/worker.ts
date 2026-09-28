import './boot/legacy-env'
import { RuntimeReadiness } from './lib/infra/readiness'
import { forwardAssistantUpdates, reconcileAssistantSummaries } from './services/assistant-conversation-updates'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  listen,
  notify,
  closeLocalEvents,
  configureLocalEvents,
  getLocalEventForwardingDiagnostics,
  startWorkerEventServer,
} from './lib/infra/local-events'
import { createPeriodicRunner } from './lib/infra/PeriodicRunner'
import { subsystem, startSubsystems, stopSubsystems, type Subsystem } from './lib/infra/subsystem'
import { createWorkerRestartHandler, RESTART_EXIT_CODE, SYSTEM_RESTART_CHANNEL } from './lib/infra/system-restart'
import { createLogger, installConsoleContentSanitizer } from './lib/infra/logger'
import {
  handleControlSignal,
  getActiveSessionCount,
  setStreamBufferFactory,
  shutdownActiveSessions,
  concurrencyLimiter,
} from './services/execution'
import { attemptPickup, pickupQueuedExecutions, getMaxConcurrentAgents } from './services/execution/pickup'
import { scheduler, scheduleHealthNotifier } from './services/scheduling'
import { reconcileSchedulesOnStartup } from './services/scheduling/reconciliation'
import { streamManager } from './services/streaming/buffer'
import type { StreamEvent } from '@ficus/shared'
import { Execution } from './entities/Execution'
import type { Machine } from './services/machines/queries'
import { ensureSessionDataDir } from './lib/infra/session-files'
import { waitForDbAndMigrate, db } from './db'
import { installPgTeardownRejectionGuard } from './db/connection'
import { reconcileKeylessAmtpRegistrations } from './services/amtp/registration-reconciliation'
import { sql } from 'drizzle-orm'

import { eventEmitter } from './lib/infra/event-emitter'
import { ensureHomeDir } from './lib/utils/home'
import { initSquadEventHandlers } from './services/squad/event-handlers'
import { registerCleanupHandlers } from './services/agents/cleanup'
import { registerSandboxWarmupHandlers } from './services/sandbox/warmup-handlers'
import {
  ignoredK8sEnvWarning,
  isDockerRuntimeValue,
  isK8sRuntime,
  requireSandboxRuntime,
} from './services/sandbox/runtime'
import { beyondLoopback, workerBindHost } from './lib/infra/bind-host'
import { claimPeriodicSandboxMaintenance } from './services/sandbox/factory'
import { setPrecompactionLifecycleSink, registerPrecompactionEviction } from './services/agent/precompaction/registry'
import { precompactionLifecycleSink } from './services/execution/session-state'
import { Agent } from './entities/Agent'
import { registerBuiltinHooks } from './services/turn-hooks'
import {
  startLocalDeploymentHealthPoller,
  stopLocalDeploymentHealthPoller,
} from './services/deploy/local-deployment-health-poller'
import { monitorSupervisor } from './services/monitors'
import { registerOnboardingEventSources } from './services/onboarding/events'
import { registerAgentActivityEventHandlers } from './services/agents/activity-summary'
import { registerSquadActivityEventHandlers } from './services/squad-activity/event-handlers'
import { registerWorkStreamContinuationEventHandlers } from './services/work-streams/continuation'
import { databaseClockNow } from './db/clock'
import { registerWorkStreamPlatformFailureNoticeHandlers } from './services/work-streams/platform-failure-notice'
import {
  PRUNE_INTERVAL_MS,
  REPAIR_INTERVAL_MS,
  pruneSquadActivity,
  runActivityRepairTick,
} from './services/squad-activity/maintenance'

installConsoleContentSanitizer()
const log = createLogger('worker', undefined, { color: 'magenta' })

const WORKER_PORT = Number(process.env.WORKER_PORT) || 3002
// Loopback unless FICUS_WORKER_BIND/HOST says otherwise (or we are in k8s, where
// pod-IP probes need all interfaces) — same rule as every other local service.
const workerHost = workerBindHost(process.env, isK8sRuntime() || !!process.env.KUBERNETES_SERVICE_HOST)
const POLL_INTERVAL_MS = 5_000
const AMTP_OUTBOX_INTERVAL_MS = 5_000
const startTime = Date.now()

// Periodic sandbox maintenance — the k8s manager's 60s squad-pod reconcile
// pass — is worker-owned, the same rule the vm runtime already follows (its
// lifecycle runner is started only here). The API still builds a sandbox
// manager for the request path (ensure/exec/spawnShell), but running the pass
// in both processes did the identical cluster + DB work twice every minute.
// Claim at module load, before anything can lazily construct the manager.
claimPeriodicSandboxMaintenance()

// Wire stream buffer factory into unified executor
setStreamBufferFactory((id: string) => {
  return streamManager.create(id)
})

// --- Stream HTTP Server ---

export const workerApp = new Hono()
const readiness = new RuntimeReadiness('worker', process.env.FICUS_RUNTIME_INSTANCE_ID)
workerApp.get('/ready', () => readiness.response())

workerApp.get('/health', (c) => {
  return c.json({
    status: 'online',
    activeSessions: getActiveSessionCount(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    maxConcurrent: getMaxConcurrentAgents(),
    providerConcurrency: concurrencyLimiter.snapshot(),
    localEventForward: getLocalEventForwardingDiagnostics(),
  })
})

// Unified stream endpoint — keyed by execution ID (buffer is created per execution)
workerApp.get('/stream/:id', (c) => {
  const id = c.req.param('id')
  const buffer = streamManager.get(id)

  if (!buffer) {
    return c.json({ error: 'Stream not found' }, 404)
  }

  return streamSSE(c, async (stream) => {
    const eventQueue: StreamEvent[] = []
    let signalResolve: (() => void) | null = null

    const callback = (event: StreamEvent) => {
      eventQueue.push(event)
      if (signalResolve) {
        signalResolve()
        signalResolve = null
      }
    }

    const catchupEvents = buffer.subscribe(callback)

    if (catchupEvents.length > 0) {
      await stream.writeSSE({
        event: 'catchup',
        data: JSON.stringify({ events: catchupEvents }),
      })
    }

    try {
      let lastPing = Date.now()

      // Single loop: drain events, send pings, check for completion
      while (true) {
        // Drain all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }

        // If buffer is done/error and no more events, send done signal and exit.
        // Both 'done' and 'error' statuses send the done SSE event so the client
        // knows the stream has terminated (prevents endless reconnection attempts).
        if (buffer.status !== 'streaming' && eventQueue.length === 0) {
          await stream.writeSSE({ event: 'done', data: '' })
          break
        }

        // Send periodic pings
        if (Date.now() - lastPing >= 5000) {
          await stream.writeSSE({ event: 'ping', data: '' })
          lastPing = Date.now()
        }

        // Wait for new event or timeout (short interval to stay responsive)
        await Promise.race([
          new Promise<void>((resolve) => {
            signalResolve = resolve
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ])
      }
    } finally {
      buffer.unsubscribe(callback)
    }
  })
})

// --- Job Processing ---
//
// The single queued→running pickup path lives in services/execution/pickup.ts
// (`attemptPickup` / `pickupQueuedExecutions`). Worker.ts only wires the three
// triggers (poll, event, watchdog — the last calls attemptPickup directly
// from queue-watchdog.ts) into it.

async function tryPickupExecutionForTest(executionId: string): Promise<boolean> {
  const exec = await Execution.find(executionId)
  if (!exec) return false
  return (await attemptPickup(exec)) === 'started'
}

export { pickupQueuedExecutions as tryPickupExecutionsForTest, tryPickupExecutionForTest }

// NOT redundant with transitionTo's local release: the concurrency limiter is
// per-process, so a terminal transition initiated in the API process must
// release the WORKER's slot via these distributed events. release() is
// map-delete idempotent, so double-release with the local path is safe.
function registerConcurrencyReleaseListeners(): () => void {
  const releaseSlot = ({ executionId }: { executionId: string; agentId: string; status: string }) => {
    concurrencyLimiter.release(executionId)
  }
  const unsubscribeCompleted = eventEmitter.on('execution.completed', releaseSlot)
  const unsubscribeFailed = eventEmitter.on('execution.failed', releaseSlot)
  const unsubscribeStopped = eventEmitter.on('execution.stopped', releaseSlot)

  return () => {
    unsubscribeCompleted()
    unsubscribeFailed()
    unsubscribeStopped()
  }
}

export { registerConcurrencyReleaseListeners as registerConcurrencyReleaseListenersForTest }

// --- Startup ---

export async function drainLegacyPausedExecutionsForStartup(): Promise<number> {
  // Compare through text so this remains a safe no-op after execution_status no
  // longer contains the legacy labels.
  // `ended_at` is UTC wall time written by the database clock everywhere else (see
  // `db/clock.ts`); `NOW()` here would use the session TimeZone and, inside a transaction, the
  // transaction's start rather than the statement's.
  const legacy = await db.execute(sql`
    UPDATE executions
    SET status = 'stopped', ended_at = COALESCE(ended_at, ${databaseClockNow()})
    WHERE status::text IN ('pausing', 'paused')
    RETURNING id
  `)
  return legacy.length
}

export interface BootArtifactReconcileDeps {
  isVmRuntime?: () => boolean
  listMachines?: () => Promise<Machine[]>
  ensureMachineArtifacts?: (machine: Machine) => Promise<void>
}

/**
 * Boot-time fleet artifact reconcile (vm runtime only): push the current
 * machine artifacts (box-provision.sh + sandbox-server bundle + tau CLI) to
 * every `ready` machine.
 *
 * Why at boot: ensureBox's healthy fast-path returns BEFORE
 * ensureMachineArtifacts, so after a deploy an existing machine whose boxes
 * are all healthy would only receive a rebuilt artifact on its next FULL
 * ensure (new box / re-provision / migrate) — the new CLI would be absent from
 * those machines until then. This sweep delivers changed artifacts fleet-wide
 * promptly; per-machine version stamps make unchanged machines a cheap no-op
 * (and the artifact builds themselves are memoized per process).
 *
 * Best-effort by design: each machine is ensured under its own try/catch — an
 * unreachable machine logs a warning and never crashes boot or starves the
 * rest of the fleet. Invoked fire-and-forget from startup() so boot is not
 * gated on SSH to every machine. No-op on the container/k8s runtimes.
 */
export async function reconcileMachineArtifactsAtBoot(deps: BootArtifactReconcileDeps = {}): Promise<void> {
  const isVmRuntime = deps.isVmRuntime ?? (await import('./services/sandbox')).isVmRuntime
  if (!isVmRuntime()) return
  const listMachines = deps.listMachines ?? (await import('./services/machines/queries')).listMachines
  const ensureMachineArtifacts =
    deps.ensureMachineArtifacts ??
    (await import('./services/machines/machine-artifacts-registry')).ensureMachineArtifacts

  const ready = (await listMachines()).filter((m) => m.status === 'ready')
  if (ready.length === 0) return
  let failures = 0
  for (const machine of ready) {
    try {
      await ensureMachineArtifacts(machine)
    } catch (err) {
      failures++
      log.warn(`Boot artifact reconcile: ensure failed for machine ${machine.id} (${machine.name}):`, err)
    }
  }
  log.info(`Boot artifact reconcile: ensured artifacts on ${ready.length - failures}/${ready.length} ready machine(s)`)
}

export interface BootBootstrapReconcileDeps {
  isVmRuntime?: () => boolean
  listMachines?: () => Promise<Machine[]>
  currentBootstrapVersion?: () => string
  bootstrapMachine?: (machine: Machine) => Promise<unknown>
  claimMachineForBootstrap?: (id: string, from: readonly string[]) => Promise<Machine | null>
  failMachineBootstrapClaim?: (id: string, lastError: string) => Promise<void>
}

/**
 * Boot-time bootstrap-drift reconcile (vm runtime only): re-run `bootstrap.sh`
 * on every `ready` machine whose stored `bootstrapVersion` differs from the
 * version the running core would produce.
 *
 * Why this exists: `install_browser` and everything else in `bootstrap.sh` runs
 * only when a machine is first provisioned (placement.bootstrapMachine). The
 * per-host artifacts (server bundle, CLI, box-provision.sh) are reconciled
 * separately (reconcileMachineArtifactsAtBoot), but a change to bootstrap.sh
 * itself never reached an existing host — it just left a stale bootstrapVersion
 * for "a future reconciler" to act on. This is that reconciler: a core upgrade
 * that changed bootstrap.sh restarts the worker, and this sweep re-bootstraps
 * the drifted hosts so the change lands fleet-wide. bootstrap.sh is idempotent
 * (install_browser skips an already-present Chromium; apt/bun/nix are
 * check-then-act), so re-running it is safe; bootstrapMachine restamps
 * bootstrapVersion, so the next boot is a no-op.
 *
 * Best-effort, per-machine try/catch, fire-and-forget from startup(), no-op on
 * container/k8s runtimes — same posture as the artifact reconcile.
 */
export async function reconcileMachineBootstrapAtBoot(deps: BootBootstrapReconcileDeps = {}): Promise<void> {
  const isVmRuntime = deps.isVmRuntime ?? (await import('./services/sandbox')).isVmRuntime
  if (!isVmRuntime()) return
  const queries = await import('./services/machines/queries')
  const listMachines = deps.listMachines ?? queries.listMachines
  const claimMachineForBootstrap = deps.claimMachineForBootstrap ?? queries.claimMachineForBootstrap
  const failMachineBootstrapClaim = deps.failMachineBootstrapClaim ?? queries.failMachineBootstrapClaim
  const bootstrapModule = await import('./services/machines/bootstrap')
  const bootstrapMachine = deps.bootstrapMachine ?? bootstrapModule.bootstrapMachine
  const currentBootstrapVersion = deps.currentBootstrapVersion ?? bootstrapModule.currentBootstrapVersion

  const target = currentBootstrapVersion()
  const drifted = (await listMachines()).filter((m) => m.status === 'ready' && m.bootstrapVersion !== target)
  if (drifted.length === 0) return
  let failures = 0
  let skipped = 0
  for (const machine of drifted) {
    // Claim the row first, exactly like POST /machines/:id/bootstrap, so an
    // operator-triggered bootstrap and this sweep never run bootstrap.sh on
    // the same host at once. Only a still-ready machine is ours to take.
    const claimed = await claimMachineForBootstrap(machine.id, ['ready'])
    if (!claimed) {
      skipped++
      log.info(`Boot bootstrap reconcile: ${machine.name} is no longer ready (bootstrap already running?); skipping`)
      continue
    }
    try {
      log.info(
        `Boot bootstrap reconcile: re-bootstrapping ${machine.name} ` +
          `(${machine.bootstrapVersion?.slice(0, 12) ?? 'none'} → ${target.slice(0, 12)})`
      )
      await bootstrapMachine(claimed)
    } catch (err) {
      failures++
      log.warn(`Boot bootstrap reconcile: re-bootstrap failed for machine ${machine.id} (${machine.name}):`, err)
      await failMachineBootstrapClaim(machine.id, err instanceof Error ? err.message : String(err)).catch(() => {})
    }
  }
  log.info(
    `Boot bootstrap reconcile: re-bootstrapped ${drifted.length - failures - skipped}/${drifted.length} drifted machine(s)` +
      (skipped > 0 ? ` (${skipped} skipped: no longer ready)` : '')
  )
}

interface FleetAlertRuntimeLifecycle {
  start(): void
  stop(): Promise<void>
}

export function createFleetAlertSubsystem(
  loadRuntime: () => Promise<FleetAlertRuntimeLifecycle> = async () =>
    (await import('./services/fleet-alerts/runtime')).fleetAlertRuntime
): Subsystem {
  let runtime: FleetAlertRuntimeLifecycle | undefined
  return subsystem(
    'fleet-alert-runtime',
    async () => {
      runtime = await loadRuntime()
      runtime.start()
    },
    async () => {
      await runtime?.stop()
    }
  )
}

// Ordered start/stop subsystem list — boot iterates this forward, shutdown
// (gracefulShutdown, via stopSubsystems) iterates it in reverse. List order
// matches today's boot call order exactly.
let unregisterSquadActivity: (() => void) | null = null
let unregisterAgentActivity: (() => void) | null = null
const activityRepairRunner = createPeriodicRunner({
  name: 'squad-activity-repair',
  intervalMs: REPAIR_INTERVAL_MS,
  // Not at boot: the immediate full-window sweep landed exactly when a
  // restarted worker is busiest (resuming executions, re-warming sandboxes)
  // and competed with them for the pool. The sweep is a convergence net, not
  // a startup requirement — first pass one interval after boot is fine.
  runImmediately: false,
  task: runActivityRepairTick,
})
const activityPruneRunner = createPeriodicRunner({
  name: 'squad-activity-prune',
  intervalMs: PRUNE_INTERVAL_MS,
  task: async () => {
    await pruneSquadActivity()
  },
})

let firstActivityRepairTimer: ReturnType<typeof setTimeout> | null = null

const assistantUpdateRunner = createPeriodicRunner({
  name: 'assistant-update-forwarding',
  intervalMs: 5000,
  task: async () => {
    await forwardAssistantUpdates()
    await reconcileAssistantSummaries()
  },
})
const subsystems: Subsystem[] = [
  subsystem(
    'assistant-update-forwarding',
    () => assistantUpdateRunner.start(),
    () => assistantUpdateRunner.stop()
  ),
  subsystem(
    'agent-private-archive-lifecycle',
    async () => {
      const { startAgentPrivateArchiveJanitor } = await import('./services/sandbox/private-archive')
      startAgentPrivateArchiveJanitor()
    },
    async () => {
      const { stopAgentPrivateArchiveJanitor } = await import('./services/sandbox/private-archive')
      await stopAgentPrivateArchiveJanitor()
    }
  ),
  subsystem(
    'slot-reconciliation',
    async () => {
      const { startSlotReconciliation } = await import('./services/slots')
      startSlotReconciliation()
    },
    async () => {
      const { stopSlotReconciliation } = await import('./services/slots')
      await stopSlotReconciliation()
    }
  ),
  subsystem(
    'slot-terminal-retention',
    async () => {
      const { startSlotTerminalRetention } = await import('./services/slots')
      startSlotTerminalRetention()
    },
    async () => {
      const { stopSlotTerminalRetention } = await import('./services/slots')
      await stopSlotTerminalRetention()
    }
  ),
  subsystem(
    'squad-activity-materialization',
    () => {
      unregisterSquadActivity = registerSquadActivityEventHandlers()
      // Keeps agents.last_message_at/_human_/preview current. Registered in
      // BOTH processes: either can be the one that writes a message, and the
      // summary must not depend on which.
      unregisterAgentActivity = registerAgentActivityEventHandlers()
      activityRepairRunner.start()
      activityPruneRunner.start()
      // First convergence sweep after a short jittered delay, not at boot and
      // not a full interval away: at boot it competed with execution resume
      // for the pool, but waiting the whole hour means a restart-cycling
      // worker (deploys; the crash loop this guards against) may never
      // repair — and crashes are exactly when live events were dropped.
      const firstRunDelayMs = (3 + Math.random() * 7) * 60_000
      firstActivityRepairTimer = setTimeout(() => {
        void activityRepairRunner.trigger()
      }, firstRunDelayMs)
      firstActivityRepairTimer.unref?.()
    },
    async () => {
      if (firstActivityRepairTimer) clearTimeout(firstActivityRepairTimer)
      firstActivityRepairTimer = null
      unregisterSquadActivity?.()
      unregisterSquadActivity = null
      unregisterAgentActivity?.()
      unregisterAgentActivity = null
      await activityRepairRunner.stop()
      await activityPruneRunner.stop()
    }
  ),
  subsystem(
    'admission-process-liveness',
    () => {},
    async () => {
      const { stopAdmissionProcessLiveness } = await import('./services/maintenance/process-liveness')
      await stopAdmissionProcessLiveness()
    }
  ),
  subsystem(
    'maintenance-controller',
    () => {},
    async () => {
      const { maintenanceWorkerController } = await import('./services/maintenance')
      await maintenanceWorkerController.stop()
    }
  ),
  subsystem(
    'integration-export',
    async () => {
      const { integrationExportRuntime } = await import('./services/integrations/runtime')
      integrationExportRuntime.start()
    },
    async () => {
      const { integrationExportRuntime } = await import('./services/integrations/runtime')
      await integrationExportRuntime.stop()
    }
  ),
  subsystem(
    'integration-credential-cleanup',
    async () => {
      const { integrationCredentialCleanupWorker } = await import('./services/integrations/runtime')
      integrationCredentialCleanupWorker.start()
    },
    async () => {
      const { integrationCredentialCleanupWorker } = await import('./services/integrations/runtime')
      await integrationCredentialCleanupWorker.stop()
    }
  ),
  subsystem(
    'integration-projection',
    async () => {
      const { integrationProjectionWorker, initializeIntegrationDefaults } =
        await import('./services/integrations/runtime')
      await initializeIntegrationDefaults()
      integrationProjectionWorker.start()
    },
    async () => {
      const { integrationProjectionWorker } = await import('./services/integrations/runtime')
      await integrationProjectionWorker.stop()
    }
  ),
  subsystem(
    'integration-oauth-flow-recovery',
    async () => {
      const { integrationAuthorizationFlowRecoveryWorker } = await import('./services/integrations/runtime')
      integrationAuthorizationFlowRecoveryWorker.start()
    },
    async () => {
      const { integrationAuthorizationFlowRecoveryWorker } = await import('./services/integrations/runtime')
      await integrationAuthorizationFlowRecoveryWorker.stop()
    }
  ),
  subsystem(
    'integration-oauth-refresh',
    async () => {
      const { integrationRefreshWorker } = await import('./services/integrations/runtime')
      integrationRefreshWorker.start()
    },
    async () => {
      const { integrationRefreshWorker } = await import('./services/integrations/runtime')
      await integrationRefreshWorker.stop()
    }
  ),
  subsystem(
    'integration-revocation',
    async () => {
      const { integrationRevocationWorker } = await import('./services/integrations/runtime')
      integrationRevocationWorker.start()
    },
    async () => {
      const { integrationRevocationWorker } = await import('./services/integrations/runtime')
      await integrationRevocationWorker.stop()
    }
  ),
  subsystem(
    'integration-revalidation',
    async () => {
      const { integrationRevalidationWorker } = await import('./services/integrations/runtime')
      integrationRevalidationWorker.start()
    },
    async () => {
      const { integrationRevalidationWorker } = await import('./services/integrations/runtime')
      await integrationRevalidationWorker.stop()
    }
  ),
  // Start schedule scheduler
  subsystem(
    'scheduler',
    () => scheduler.start(),
    () => scheduler.stop()
  ),
  subsystem(
    'monitor-supervisor',
    () => monitorSupervisor.recoverOnStartup(),
    () => monitorSupervisor.shutdownAll()
  ),
  // Poll active sandbox localDeployment health so restarting/unhealthy localDeployments converge to running/crashed.
  subsystem(
    'local-deployment-health-poller',
    () => startLocalDeploymentHealthPoller(),
    () => stopLocalDeploymentHealthPoller()
  ),
  // Periodically probe provider health (e.g. OpenRouter /credits) so exhausted
  // providers are recovered proactively rather than only on the next request.
  subsystem(
    'provider-health-probe-scheduler',
    async () => {
      const { startProbeScheduler } = await import('./services/provider-health/probe-scheduler')
      startProbeScheduler()
    },
    async () => {
      const { stopProbeScheduler } = await import('./services/provider-health/probe-scheduler')
      await stopProbeScheduler()
    }
  ),
  createFleetAlertSubsystem(),
  // Periodically resume agents halted by provider exhaustion once a provider
  // recovers, with flap guards (terminated/squad-active/active-execution checks
  // + persisted exponential backoff).
  subsystem(
    'provider-health-auto-restart-sweep',
    async () => {
      const { startAutoRestartSweep } = await import('./services/provider-health/auto-restart')
      startAutoRestartSweep()
    },
    async () => {
      const { stopAutoRestartSweep } = await import('./services/provider-health/auto-restart')
      await stopAutoRestartSweep()
    }
  ),
  // Recovery watch: notifies working agents (steer or queued execution) once a
  // dead sandbox they depend on is back — pod running AND devbox-ready — and
  // re-ensures dead boxes as part of its sweep. Registered from the exec layer
  // and the pod reconciler.
  subsystem(
    'sandbox-recovery-watch',
    async () => {
      const { startSandboxRecoveryWatch } = await import('./services/sandbox/recovery-watch')
      startSandboxRecoveryWatch()
    },
    async () => {
      const { stopSandboxRecoveryWatch } = await import('./services/sandbox/recovery-watch')
      await stopSandboxRecoveryWatch()
    }
  ),
  subsystem(
    'sandbox-provision-recovery',
    async () => {
      const { startSandboxProvisionRecovery } = await import('./services/sandbox/k8s/provision-recovery')
      startSandboxProvisionRecovery()
    },
    async () => {
      const { stopSandboxProvisionRecovery } = await import('./services/sandbox/k8s/provision-recovery')
      await stopSandboxProvisionRecovery()
    }
  ),
  // VM sandbox lifecycle: the 60s periodic loop that gives the vm runtime the
  // lifecycle the k8s manager already has — idle-reap parkable boxes, sweep
  // machine health, reconcile orphaned boxes, and spec-drift + warmup. Inert on
  // k8s/docker (start no-ops when the runtime isn't vm), so it registers here
  // unconditionally after the recovery watch.
  subsystem(
    'vm-sandbox-lifecycle',
    async () => {
      const { startVmSandboxLifecycle } = await import('./services/sandbox/vm/lifecycle')
      startVmSandboxLifecycle()
    },
    async () => {
      const { stopVmSandboxLifecycle } = await import('./services/sandbox/vm/lifecycle')
      await stopVmSandboxLifecycle()
    }
  ),
  subsystem(
    'work-stream-continuation',
    async () => (await import('./services/work-streams/continuation')).startWorkStreamContinuationSweep(),
    async () => (await import('./services/work-streams/continuation')).stopWorkStreamContinuationSweep()
  ),
  subsystem(
    'question-answer-delivery',
    async () => (await import('./services/agents/question-answer-delivery')).startQuestionAnswerDeliverySweep(),
    async () => (await import('./services/agents/question-answer-delivery')).stopQuestionAnswerDeliverySweep()
  ),
  // Platform usage-sample reporter: every 5 minutes, POSTs the live machines
  // fleet to the hosted platform's shadow-metering ingest endpoint. Inert
  // (one log line, no runner) unless FICUS_PLATFORM_INGEST_URL is set — which
  // only happens on an instance the platform itself provisioned — so it
  // registers here unconditionally like vm-sandbox-lifecycle above.
  subsystem(
    'platform-usage-reporter',
    async () => {
      const { startUsageReporter } = await import('./services/machines/usage-reporter')
      startUsageReporter()
    },
    async () => {
      const { stopUsageReporter } = await import('./services/machines/usage-reporter')
      await stopUsageReporter()
    }
  ),
  subsystem(
    'abandoned-lease-watch',
    async () => (await import('./services/execution/abandoned-lease-watch')).startAbandonedLeaseWatch(),
    async () => (await import('./services/execution/abandoned-lease-watch')).stopAbandonedLeaseWatch()
  ),
  subsystem(
    'operations-analyst',
    async () => (await import('./services/operations-analyst/scheduler')).startOperationsAnalyst(),
    async () => (await import('./services/operations-analyst/scheduler')).stopOperationsAnalyst()
  ),
  // Catch-all: stop any periodic runner a service forgot to wire in above.
  // stop() is idempotent, so the explicit stops (which also clear module
  // state) are unaffected. This list has drifted before — the recovery watch
  // shipped without a stop here until the registry made it moot.
  subsystem(
    'periodic-runners:catch-all',
    () => {},
    async () => {
      const { stopAllPeriodicRunners } = await import('./lib/infra/PeriodicRunner')
      await stopAllPeriodicRunners()
    }
  ),
]

async function startup(): Promise<void> {
  log.info('Starting...')

  // Fail fast on a missing/unknown FICUS_SANDBOX_RUNTIME: the worker is the
  // process that actually runs turns, so booting it against an unconfigured
  // runtime only defers the failure to the first agent's first tool call.
  const sandboxRuntime = requireSandboxRuntime()

  // Every FICUS_K8S_* key applies ONLY to the k8s runtime. Say so once at boot,
  // or a stale line an operator left behind when they switched runtimes reads
  // as live configuration.
  const ignoredK8sEnv = ignoredK8sEnvWarning()
  if (ignoredK8sEnv) log.warn(ignoredK8sEnv)

  // A NAMED runtime still has to be usable. selectRuntime() is where
  // docker-sysbox-without-sysbox fails — and it deliberately does NOT downgrade
  // to socket mode, because that would hand agents the host's docker socket
  // after the operator asked for the isolated runtime. Same argument as above:
  // find out at boot, not on the first tool call. Imported lazily so a k8s / vm
  // / host worker never pulls the docker manager into its boot path.
  if (isDockerRuntimeValue(sandboxRuntime)) {
    const { selectRuntime } = await import('./services/sandbox/docker/manager')
    // NB: on docker-sysbox this shells out to `docker info` to look for the
    // sysbox runtime, so a worker that starts before dockerd is up fails here
    // and self-heals through systemd's Restart=on-failure (the units order
    // After=docker.service, so this is the boot-race backstop, not the plan).
    selectRuntime()
  }

  ensureHomeDir()
  ensureSessionDataDir()

  await waitForDbAndMigrate()
  const reconciled = await reconcileKeylessAmtpRegistrations()
  if (reconciled.length > 0) log.warn('[worker] Closed historical keyless AMTP registrations', reconciled)

  // Establish the durable admission fence and drain any recovered running work
  // before startup recovery or normal pickup can dispatch another turn.
  const { maintenanceStore, maintenanceWorkerController } = await import('./services/maintenance')
  const { startAdmissionProcessLiveness } = await import('./services/maintenance/process-liveness')
  await maintenanceStore.initialize()
  // Losing the admission liveness lock is an in-app restart request, NOT a
  // `systemctl stop`: the default handler SIGTERMs the process, which exits 0
  // and leaves the worker DOWN under Restart=on-failure (observed on chowmein).
  // Route it through the non-zero-exit restart path so a genuine loss recovers.
  await startAdmissionProcessLiveness(() => {
    void restartWorkerForLivenessLoss()
  })
  await maintenanceWorkerController.start()

  // Initialize secret store with periodic refresh for worker process.
  // Cross-process invalidation (local-events) picks up API-side writes ~instantly;
  // the periodic refresh (5 min — see SECRET_STORE_REFRESH_INTERVAL_MS) stays as
  // a belt-and-braces fallback for a MISSED notification only.
  const { getSecretStore } = await import('./services/secrets')
  const secretStore = getSecretStore()
  await secretStore.initialize()
  secretStore.startPeriodicRefresh()
  await secretStore.startCrossProcessInvalidation()
  const [{ setLogContentSanitizer }, { getContentSafetyRegistry }] = await Promise.all([
    import('./lib/infra/logger'),
    import('./services/security/content-safety-registry'),
  ])
  setLogContentSanitizer((args) => getContentSafetyRegistry().redact(args))

  // This process's own SecretStore instance/cache needs its own onboarding
  // onChange listener (GitHub/Slack/Discord token changes) — see
  // services/onboarding/events.ts. Also re-emits on squad.created/archived.
  registerOnboardingEventSources()

  // Register the built-in machine providers in the WORKER too. Executions run
  // here, so this is where resolvePlacement (via the runners' ensure*Sandbox →
  // box-manager) looks up the exe provider to auto-provision a VM box. Only the
  // api process registered them before (the machines router does it as an import
  // side-effect), so a vm-runtime worker saw an empty registry: getMachineProvider
  // ('exe') threw, placement fell through to the BYO least-loaded path, and every
  // squad/agent turn failed with "no ready shared machine registered" instead of
  // provisioning an exe VM. Runs after secretStore.initialize() so getExeSshKey()
  // can read the configured account key. Idempotent (re-registering overwrites).
  const { registerBuiltinMachineProviders } = await import('./services/machines/providers')
  await registerBuiltinMachineProviders()

  // Initialize settings store and hydrate provider health from DB so
  // exhausted providers survive restarts.
  const { getSettingsStore } = await import('./services/settings')
  const settingsStore = getSettingsStore()
  await settingsStore.initialize()
  settingsStore.startPeriodicRefresh()
  // Execution pickup runs in THIS process, but settings are written by the api
  // process — without this the worker would not see a new MAX_CONCURRENT_AGENTS
  // cap until the next periodic refresh (5 min — see
  // SETTINGS_STORE_REFRESH_INTERVAL_MS). Best-effort fast path; the periodic
  // refresh above stays the guarantee.
  await settingsStore.startCrossProcessInvalidation()

  // Notifications go out through the channel transports from this process too;
  // they read the same connection snapshot the api keeps, refreshed here on a timer.
  const { channelConnections } = await import('./services/integrations/channels/connections')
  await channelConnections.refresh()
  createPeriodicRunner({
    name: 'channel-connections-refresh',
    intervalMs: 30_000,
    task: () => channelConnections.refresh(),
  }).start()

  const { reconcileAgentQuestionAttentionOnce } = await import('./services/agents/question-attention-reconciliation')
  // Question attention repair is unconditional (the rollout flag is retired): one bounded batch
  // at startup plus a 60-second periodic tick. The sweep defaults to 100 rows and becomes
  // quiescent once durable resolution removes repaired rows from its predicate.
  const runQuestionAttentionMaintenance = async () => {
    const repairResult = await reconcileAgentQuestionAttentionOnce()
    if (repairResult.processed > 0) log.info('Agent question attention repair progress', repairResult)
  }
  await runQuestionAttentionMaintenance()
  createPeriodicRunner({
    name: 'agent-question-attention-maintenance',
    intervalMs: 60_000,
    runImmediately: false,
    task: runQuestionAttentionMaintenance,
  }).start()

  // `POST /api/system/restart` runs in the api process, which cannot reach this
  // one (separate systemd/pm2 units, no coupling) — it asks us to restart over
  // the same transport. Run the graceful shutdown (requeue owned executions)
  // and exit NON-ZERO so `Restart=on-failure` brings the worker back; SIGTERM
  // keeps exiting 0. See lib/infra/system-restart.ts.
  await listen(
    SYSTEM_RESTART_CHANNEL,
    createWorkerRestartHandler({
      shutdown: () => beginWorkerShutdown('API restart request', RESTART_EXIT_CODE),
      exit: (code) => process.exit(Math.max(shutdownExitCode, code)),
      log,
    })
  )

  const { providerHealth } = await import('./services/provider-health/registry')
  providerHealth.enablePersistence()
  await providerHealth.hydrateFromPersistence()

  // Ensure env-var/runtime-only auth is visible to synchronous model-selection
  // paths before queued execution pickup or periodic drains can start sessions.
  const { warmModelRuntimeForStartup } = await import('./services/agent/auth-backend')
  await warmModelRuntimeForStartup()

  // Register turn completion hooks
  registerBuiltinHooks()

  // Initialize distributed event emitter over the loopback HTTP transport
  eventEmitter.initialize('worker', notify)
  await eventEmitter.startListening(listen)

  // This event-driven backstop must exist before startup recovery or pickup can
  // transition a queued execution to running while a watchdog wait is open.
  registerWorkStreamContinuationEventHandlers()
  // Exactly-once owner notification for pre-tool platform refusals — same
  // event-driven, post-commit discipline as the continuation handlers.
  registerWorkStreamPlatformFailureNoticeHandlers()

  // Pick up queued executions via distributed events
  const pickupIfQueued = async ({ executionId, status }: { executionId: string; agentId: string; status: string }) => {
    if (status !== 'queued') return
    const exec = await Execution.find(executionId)
    if (!exec) return
    await attemptPickup(exec)
  }
  eventEmitter.on('execution.created', pickupIfQueued)
  eventEmitter.on('execution.queued', pickupIfQueued)
  registerConcurrencyReleaseListeners()

  // Listen for unified control signals
  await listen('agent_control', (payload) => {
    try {
      const signal = JSON.parse(payload)
      log.info(`Received control signal: ${signal.action} for agent ${signal.agentId}`)
      handleControlSignal(signal).catch((error) => {
        log.error('Error handling control signal:', signal, error)
      })
    } catch (error) {
      log.error('Invalid control signal:', payload, error)
    }
  })

  // Startup recovery
  log.info('Running startup recovery...')

  // Repair pre-admission duplicate rows before any recovery or pickup can run.
  const { reconcileDuplicateActiveExecutions } = await import('./services/execution/admission-reconciliation')
  const duplicateCount = await reconcileDuplicateActiveExecutions()
  if (duplicateCount > 0) log.warn(`Stopped ${duplicateCount} duplicate active execution(s) during startup`)

  // 1. Recover new-style executions
  const { recoverInterruptedExecutionsForStartup } = await import('./services/execution/startup-recovery')
  for (const executionId of await recoverInterruptedExecutionsForStartup()) {
    log.info(`Re-queued interrupted execution ${executionId}`)
  }

  // One-time migration drain: legacy pause states are no longer reachable.
  const legacyCount = await drainLegacyPausedExecutionsForStartup()
  if (legacyCount > 0) {
    log.info(`Migrated ${legacyCount} legacy pausing/paused executions to stopped`)
  }

  // Handle stale stopping executions
  const stoppingExecutions = await Execution.list({ status: 'stopping' })
  for (const exec of stoppingExecutions) {
    log.info(`Completing stop for execution ${exec.id}`)
    await exec.stop()
  }

  // Recover agents stuck in compacting status (process died during compaction)
  const compactingAgents = await Agent.list({ status: 'compacting' })
  for (const agent of compactingAgents) {
    log.info(`Reset compacting agent ${agent.id} to idle`)
    await agent.finishCompaction()
  }

  // NOTE deliberately ABSENT here: box migration fences are NOT cleared at
  // worker boot. Migrations execute in the API process (routes/machines.ts →
  // migrateBox/rebalanceFleet), so a fence observed here may be LIVE in an
  // in-flight API-side migrate — clearing it would let the pickup below start
  // the deferred turn on the OLD box mid-move (turn killed + ~/.private writes
  // lost when the migrate repoints/userdels it). Pickup only DEFERS on a
  // fence, so a stale one merely delays a turn until the API boot clears it
  // (the fence-recovery barrier in index.ts / services/machines/queries.ts).

  // Repair stale schedule attempts, targets, and system watchdogs before the
  // scheduler or any newly picked-up work can observe inconsistent state.
  await reconcileSchedulesOnStartup()
  await scheduleHealthNotifier.drain({ now: new Date() })
  const { reconcileSlotsOnce } = await import('./services/slots')
  await reconcileSlotsOnce()

  // Reconcile late pre-lifecycle termination writes before any queued work can
  // start for an owner that is already final by its durable audit timestamp.
  const { runLegacyTerminatedAgentSweep } = await import('./services/agent/lifecycle')
  await runLegacyTerminatedAgentSweep({ maxCandidates: 5 })

  // One-time reconciliation for orphaned executions whose agent no longer
  // exists or is terminated (the 2026-09-04 dead-fleet incident): settle them
  // terminally BEFORE pickup, so the queue watchdog cannot keep nudging rows
  // no agent can ever run. Bounded and idempotent; never touches live or
  // dormant agents' executions.
  const { settleOrphanedExecutionsOnce } = await import('./services/execution/orphan-settlement')
  const settledOrphans = await settleOrphanedExecutionsOnce({ maxCandidates: 25 })
  if (settledOrphans > 0) log.warn(`Settled ${settledOrphans} orphaned execution(s) of removed agents during startup`)

  // 2. Pick up queued executions
  await pickupQueuedExecutions()

  void (async () => {
    try {
      const { getSandboxManager, isHostRuntime, isK8sRuntime, isVmRuntime } = await import('./services/sandbox')
      if (isK8sRuntime()) {
        const manager = getSandboxManager() as import('./services/sandbox/k8s/manager').K8sSandboxManager
        const clusterOk = await manager.podManager.checkClusterConnectivity()
        if (clusterOk) await manager.reconcileSquadPods()
      } else if (isVmRuntime()) {
        // Report machine availability; WARN (not fail) when no ready machine exists.
        const { listMachines } = await import('./services/machines/queries')
        const ready = (await listMachines()).filter((m) => m.status === 'ready')
        if (ready.length === 0) {
          log.warn('VM sandbox runtime: no ready machines registered; sandboxes cannot start until one is registered')
        } else {
          log.info(`VM sandbox runtime: ${ready.length} ready machine(s) available`)
        }
        // Kick a first lifecycle pass at boot (mirror the k8s branch calling
        // reconcileSquadPods), before the periodic runner's first scheduled tick.
        const { runVmSandboxLifecycleFirstPass } = await import('./services/sandbox/vm/lifecycle')
        await runVmSandboxLifecycleFirstPass()
      } else if (isHostRuntime()) {
        // Runs AFTER pickupQueuedExecutions() above, which is safe: every
        // squad-scoped ensure re-reads the squad row first
        // (refreshHostWorkspaceOverride), so a turn picked up before this
        // hydrate still resolves the configured workspace, not a stale default.
        const { hydrateHostWorkspaceOverrides } = await import('./services/sandbox/host/workspace-overrides-hydrate')
        log.info(`Host runtime: loaded ${await hydrateHostWorkspaceOverrides()} squad workspace override(s)`)
        // Re-materialize every granted squad's SSH config once at boot: squads
        // granted before host-mode support still carry ~/.ssh-style managed
        // blocks, which on host resolve against the OPERATOR's home
        // (issue #1331). Idempotent and failure-isolated per squad.
        const { backfillSquadSshConfigs } = await import('./services/remote-hosts/backfill')
        log.info(`Host runtime: re-materialized SSH configs for ${await backfillSquadSshConfigs()} granted squad(s)`)
      }
    } catch (err) {
      log.warn('Sandbox runtime startup reconciliation failed:', err)
    }
  })()

  // Deliver changed machine artifacts (box-provision.sh, server bundle, tau CLI)
  // fleet-wide at boot — see reconcileMachineArtifactsAtBoot. Fire-and-forget: boot must not
  // be gated on SSH to every machine; per-machine failures are logged inside.
  // Re-bootstrap drifted hosts (e.g. a bootstrap.sh change like install_browser)
  // BEFORE the artifact reconcile, so a host that needs a fresh bootstrap gets
  // it before we push artifacts onto it. Both are best-effort and independent.
  void reconcileMachineBootstrapAtBoot().catch((err) => log.warn('Boot bootstrap reconcile failed:', err))
  void reconcileMachineArtifactsAtBoot().catch((err) => log.warn('Boot artifact reconcile failed:', err))

  void (async () => {
    try {
      const { warmupActiveSquadSandboxes } = await import('./services/sandbox/squad-warmup')
      await warmupActiveSquadSandboxes(log)
    } catch (err) {
      log.warn('Squad sandbox warmup failed:', err)
    }
  })()

  void (async () => {
    try {
      const { warmupWorkStreamAgentSandboxes } = await import('./services/sandbox/work-stream-warmup')
      await warmupWorkStreamAgentSandboxes(log)
    } catch (err) {
      log.warn('Work-stream agent sandbox warmup failed:', err)
    }
  })()

  void (async () => {
    try {
      const { warmupCliHelpCaches } = await import('./lib/utils/cli-help')
      await warmupCliHelpCaches()
    } catch (err) {
      log.warn('CLI help warmup failed:', err)
    }
  })()

  // Start polling interval
  createPeriodicRunner({
    name: 'execution-poll',
    intervalMs: POLL_INTERVAL_MS,
    runImmediately: false, // already called pickupQueuedExecutions() above
    task: async () => {
      await pickupQueuedExecutions()
    },
  }).start()

  {
    const { runQueueWatchdogOnce, WATCHDOG_INTERVAL_MS } = await import('./services/execution/queue-watchdog')
    createPeriodicRunner({
      name: 'queue-watchdog',
      intervalMs: WATCHDOG_INTERVAL_MS,
      runImmediately: false,
      task: async () => {
        await runQueueWatchdogOnce()
      },
    }).start()
  }

  createPeriodicRunner({
    name: 'amtp-outbox',
    intervalMs: AMTP_OUTBOX_INTERVAL_MS,
    runImmediately: false,
    task: async () => {
      const { drainOutboxOnce } = await import('./services/amtp/outbox-delivery')
      await drainOutboxOnce()
    },
  }).start()

  // Start core periodic subsystems in order (scheduler, monitor supervisor,
  // health pollers/sweeps, periodic-runner catch-all) — see `subsystems` above.
  await startSubsystems(subsystems, log)

  // One-shot startup drain: resumes any agent still parked in waiting-input
  // by the pre-recovery-watch halt path. No-op when nothing is parked.
  const { drainSandboxHaltedAgentsOnce } = await import('./services/sandbox/restart')
  void drainSandboxHaltedAgentsOnce().catch((err) => log.warn('Sandbox halted-agent drain failed:', err))

  createPeriodicRunner({
    name: 'storage-monitor',
    intervalMs: 60_000,
    runImmediately: true,
    task: async () => {
      const { runStorageMonitor } = await import('./services/storage/monitor')
      await runStorageMonitor()
    },
  }).start()

  // Initialize squad event handlers for manager notifications
  initSquadEventHandlers()

  // Initialize agent cleanup handlers (auto-terminate when work streams complete)
  registerCleanupHandlers()
  // Work-stream admission: promote queued streams when slots free, with a
  // periodic reconciler as the backstop for missed promotion events
  // (registered like the queue watchdog above).
  {
    const { registerAdmissionHandlers, runAdmissionReconcilerOnce } = await import('./services/work-streams/admission')
    registerAdmissionHandlers()
    createPeriodicRunner({
      name: 'work-stream-admission',
      intervalMs: 60_000,
      runImmediately: false,
      task: async () => {
        await runAdmissionReconcilerOnce()
      },
    }).start()
  }
  // Warm work-stream agents' sandboxes on spawn + assignment so handoffs are instant
  {
    const { reconcileFlows } = await import('./services/workflows/execution')
    createPeriodicRunner({
      name: 'workflow-dispatch',
      intervalMs: 15_000,
      runImmediately: true,
      task: async () => {
        const { reconcileWorkStreamPauses } = await import('./services/work-streams/pause')
        await reconcileWorkStreamPauses()
        await reconcileFlows()
      },
    }).start()
  }
  {
    const { reconcileWorktreeCleanup } = await import('./services/work-streams/worktree-cleanup-reconciler')
    createPeriodicRunner({
      name: 'worktree-cleanup',
      intervalMs: 15_000,
      runImmediately: true,
      task: reconcileWorktreeCleanup,
    }).start()
  }
  registerSandboxWarmupHandlers()
  setPrecompactionLifecycleSink(precompactionLifecycleSink)
  registerPrecompactionEviction()

  log.info(
    `Ready. Listening on http://${workerHost}:${WORKER_PORT}, max ${getMaxConcurrentAgents()} concurrent agents.`
  )
}

// --- Graceful Shutdown ---

/**
 * Everything a clean stop needs EXCEPT the exit itself, so callers pick the
 * exit code: a `systemctl stop` (SIGTERM) exits 0, an API-requested restart
 * exits non-zero (`RESTART_EXIT_CODE`) so `Restart=on-failure` brings the
 * worker back.
 */
async function shutdownWorker(reason: string): Promise<void> {
  readiness.markStopping()
  log.info(`Received ${reason}, shutting down...`)

  // Abort all active sessions — saves partial messages to DB via agent_end
  const executionIds = await shutdownActiveSessions()

  // Live sessions and sessionless rows still owned by this process are requeued
  // through one recovery boundary below. Each successful requeue commits its
  // agent-level shutdown notice and admission downgrade in the same transaction.

  // Sessions this process was running are included by ID. Rows we still OWN whose
  // session already died (fence abort, crashed runner) are invisible to that
  // sweep and would otherwise survive as permanently `running` — the agent looks
  // busy forever and holds a concurrency slot. Release them before we exit
  // rather than leaving the next boot to prove we are dead.
  const { requeueOwnedExecutionsForShutdown } = await import('./services/execution/startup-recovery')
  try {
    for (const id of await requeueOwnedExecutionsForShutdown(executionIds)) {
      log.info(`Re-queued owned execution ${id} during shutdown`)
    }
  } catch (error) {
    // Never block shutdown on this: the abandoned-lease watchdog recovers the
    // same rows on the next sweep, just later.
    log.warn('Shutdown requeue of owned executions failed:', error)
  }

  await stopSubsystems(subsystems, log)

  // Best-effort bounded flush of the worker-owned provider-health snapshot.
  const { providerHealth } = await import('./services/provider-health/registry')
  await providerHealth.flushPersistence(5_000)

  // Release this process's sandbox resources — VM RUNTIME ONLY. Executions run
  // in the WORKER, so this process holds the majority of the vm runtime's SSH
  // `-L` tunnel forwards; VmSandboxManager.cleanup() cancels ONLY this
  // process's forwards — never `-O exit` on the shared ControlMaster, which the
  // api process and every box's reverse-tunnel callback still use. Without
  // this, every worker SIGTERM permanently strands its listeners inside the
  // long-lived shared master. The gate matters: DockerSandboxManager.cleanup()
  // STOPS every tracked container, so an ungated call would make every worker
  // deploy interrupt running agents on the docker tier (whose containers have
  // always survived worker restarts); docker/k8s keep their historical
  // no-cleanup-on-worker-shutdown behavior.
  const { getSandboxManager, isVmRuntime } = await import('./services/sandbox')
  if (isVmRuntime()) {
    await getSandboxManager().cleanup()
  }

  await closeLocalEvents()
}

// exit(0) is CORRECT here: systemd expects a `systemctl stop` to succeed. Only
// an API-requested or liveness-loss restart exits non-zero on purpose. Every
// entry point awaits this same promise so races cannot run shutdown twice or
// exit while another entry point is still persisting recovery state. A restart
// request wins over a concurrent stop request.
let shutdownPromise: Promise<void> | undefined
let shutdownExitCode = 0

function beginWorkerShutdown(reason: string, exitCode: number): Promise<void> {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode)
  shutdownPromise ??= shutdownWorker(reason)
  return shutdownPromise
}

async function exitAfterWorkerShutdown(reason: string, exitCode: number): Promise<never> {
  await beginWorkerShutdown(reason, exitCode)
  process.exit(shutdownExitCode)
}

async function gracefulShutdown(signal: string): Promise<void> {
  readiness.markStopping()
  await exitAfterWorkerShutdown(signal, 0)
}

/**
 * The admission process-liveness lock was lost. Reconnecting in-place is unsafe
 * (a successor could prove this process dead while an old in-memory Pi object is
 * still alive), so the worker must restart. Unlike a `systemctl stop` SIGTERM
 * (exit 0), this is an in-app restart request: exit NON-ZERO so
 * `Restart=on-failure` brings the worker straight back rather than leaving it
 * down. The default process-liveness handler SIGTERMed (exit 0) and stranded
 * the worker — observed crash-looping tenant chowmein.
 */
async function restartWorkerForLivenessLoss(): Promise<void> {
  log.error('Admission process-liveness lock lost — restarting worker (exit non-zero) so it recovers')
  await exitAfterWorkerShutdown('admission process-liveness loss', RESTART_EXIT_CODE)
}

// Start
if (import.meta.main) {
  // Signal wiring lives INSIDE the main guard: registering process-level
  // SIGTERM/SIGINT handlers at module load meant any test file that imported
  // worker.ts armed a handler that runs shutdownWorker() + process.exit(0) —
  // and a test emitting SIGTERM to exercise its own handler (e.g. the activity
  // repair CLI's abort test) killed the whole bun test process mid-suite with
  // exit code 0, silently skipping every remaining file while CI reported
  // success.
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  // Pool-teardown debris (watchdog swap) must degrade to a warn, not kill the
  // worker and abort every running execution. See db/connection.ts.
  installPgTeardownRejectionGuard()
  // Cross-process events (see lib/infra/local-events.ts). The listener is a
  // SEPARATE server from the stream server below so it can bind loopback by
  // default, or an explicitly configured private split-namespace interface.
  // Delivery stays best-effort: an event that arrives before startup() has
  // registered its handler is dropped, exactly as a NOTIFY before LISTEN was.
  configureLocalEvents('worker')
  const eventServer = startWorkerEventServer()
  log.info(`Internal event listener on http://${eventServer.hostname}:${eventServer.port}`)

  startup()
    .then(() => readiness.markReady())
    .catch((error) => {
      log.error('Startup failed:', error)
      process.exit(1)
    })

  if (beyondLoopback(workerHost)) {
    log.warn(
      `worker stream server bound to ${workerHost} — beyond loopback. ` +
        'Ensure WORKER_PORT is reachable ONLY where it should be (private network / container network).'
    )
  }
  Bun.serve({
    hostname: workerHost,
    port: WORKER_PORT,
    fetch: workerApp.fetch,
    idleTimeout: 30,
  })
}

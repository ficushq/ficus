import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createFleetAlertSubsystem,
  drainLegacyPausedExecutionsForStartup,
  reconcileMachineArtifactsAtBoot,
  reconcileMachineBootstrapAtBoot,
  workerApp,
} from './worker'
import type { Machine } from './services/machines/queries'
import { isSysboxAvailable } from './services/sandbox/docker/manager'
import { runsPeriodicSandboxMaintenance } from './services/sandbox/factory'

describe('worker health diagnostics', () => {
  it('exposes exactly the fixed redacted local-event forwarding buckets', async () => {
    const response = await workerApp.request('/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      localEventForward: { channels: Array<Record<string, unknown>> }
    }
    expect(body.localEventForward.channels).toHaveLength(8)
    expect(body.localEventForward.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'app_events',
          attempts: expect.any(Number),
          failures: expect.any(Object),
        }),
      ])
    )
    const keys = body.localEventForward.channels.flatMap((entry) => Object.keys(entry))
    expect(keys).not.toEqual(expect.arrayContaining(['payload', 'token', 'peerUrl', 'error', 'message', 'stack']))
  })
})

describe('worker question attention maintenance wiring', () => {
  it('runs attention repair unconditionally after migrations', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    expect(source).not.toContain('question-audience-rollout')
    expect(source).not.toContain('questionAudienceRepairEnabled')
    expect(source).not.toContain('questionAudienceWritersEnabled')
    expect(source).not.toContain('retryUnstampedQuestionAttentionAlertsOnce')
    expect(source).toContain('reconcileAgentQuestionAttentionOnce()')
    expect(source.indexOf('await waitForDbAndMigrate()')).toBeLessThan(
      source.indexOf('await runQuestionAttentionMaintenance()')
    )
  })
})

describe('worker schedule reconciliation ordering', () => {
  it('awaits schedule convergence and outbox drain before pickup and scheduler startup', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    const reconcile = source.indexOf('await reconcileSchedulesOnStartup()')
    const drain = source.indexOf('await scheduleHealthNotifier.drain({ now: new Date() })')
    const legacyTerminationRepair = source.indexOf('await runLegacyTerminatedAgentSweep({ maxCandidates: 5 })')
    const pickup = source.indexOf('  await pickupQueuedExecutions()')
    const subsystems = source.lastIndexOf('await startSubsystems(subsystems, log)')
    expect(reconcile).toBeGreaterThan(0)
    expect(drain).toBeGreaterThan(reconcile)
    expect(legacyTerminationRepair).toBeGreaterThan(drain)
    expect(pickup).toBeGreaterThan(legacyTerminationRepair)
    expect(subsystems).toBeGreaterThan(pickup)
  })
})

describe('worker lifecycle convergence ownership', () => {
  it('starts and stops the archive/lifecycle runners through one managed subsystem', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    const subsystemStart = source.indexOf("'agent-private-archive-lifecycle'")
    const start = source.indexOf('startAgentPrivateArchiveJanitor()', subsystemStart)
    const stop = source.indexOf('await stopAgentPrivateArchiveJanitor()', subsystemStart)
    expect(subsystemStart).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(subsystemStart)
    expect(stop).toBeGreaterThan(start)
    expect(source.match(/startAgentPrivateArchiveJanitor\(\)/g)).toHaveLength(1)
  })
})

describe('worker slot reconciliation ordering', () => {
  it('awaits slot recovery before pickup and registers the periodic runtime', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    const reconcile = source.indexOf('await reconcileSlotsOnce()')
    const pickup = source.indexOf('  await pickupQueuedExecutions()')
    expect(reconcile).toBeGreaterThan(0)
    expect(pickup).toBeGreaterThan(reconcile)
    expect(source).toContain("'slot-reconciliation'")
    expect(source).toContain('startSlotReconciliation')
    expect(source).toContain('stopSlotReconciliation')
  })

  it('runs slot terminal retention through its own managed subsystem', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    const subsystemStart = source.indexOf("'slot-terminal-retention'")
    const start = source.indexOf('startSlotTerminalRetention()', subsystemStart)
    const stop = source.indexOf('await stopSlotTerminalRetention()', subsystemStart)
    expect(subsystemStart).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(subsystemStart)
    expect(stop).toBeGreaterThan(start)
    expect(source.match(/startSlotTerminalRetention\(\)/g)).toHaveLength(1)
  })
})

describe('worker continuation watchdog startup ordering', () => {
  it('source-pins execution-start wait resolution before the first queued-execution pickup', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    const register = source.indexOf('registerWorkStreamContinuationEventHandlers()')
    const pickup = source.indexOf('  await pickupQueuedExecutions()')
    expect(register).toBeGreaterThan(0)
    expect(pickup).toBeGreaterThan(register)
  })
})

describe('worker startup recovery', () => {
  it('source pin: keeps the Agent runtime binding used by compacting-agent recovery', () => {
    const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    expect(workerSrc).toContain("import { Agent } from './entities/Agent'")
    expect(workerSrc).toContain("Agent.list({ status: 'compacting' })")
  })

  it('legacy pause-state drain is a safe no-op after execution_status enum narrowing', async () => {
    await expect(drainLegacyPausedExecutionsForStartup()).resolves.toBe(0)
  })
})

// Boot-wiring contract: executions run in the WORKER, so resolvePlacement's exe
// provider lookup happens here — the worker MUST register the machine providers
// or vm-runtime auto-provisioning silently degrades to the BYO least-loaded path
// and every squad/agent turn fails with "no ready shared machine registered"
// (only the api's machines router registered them before). A unit test can't
// exercise the whole worker boot, so pin the wiring by source contract.
describe('worker machine-provider registration', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')

  it('registers the built-in machine providers at boot', () => {
    expect(workerSrc).toContain('registerBuiltinMachineProviders')
  })

  it('registers them AFTER the secret store is initialized (so getExeSshKey can read the account key)', () => {
    const initIdx = workerSrc.indexOf('secretStore.initialize()')
    const registerIdx = workerSrc.indexOf('registerBuiltinMachineProviders(')
    expect(initIdx).toBeGreaterThan(-1)
    expect(registerIdx).toBeGreaterThan(initIdx)
  })
})

// Boot-time fleet artifact reconcile: ensureBox's healthy fast-path returns
// BEFORE ensureMachineArtifacts, so after a deploy an existing machine whose
// boxes are all healthy would get a rebuilt artifact (e.g. the tau CLI) only on
// the next FULL ensure (new box / re-provision / migrate). The worker therefore
// pushes changed artifacts to every ready machine at boot — best-effort per
// machine (an unreachable machine must never take down the worker or starve the
// rest of the fleet), vm runtime only, fire-and-forget from startup.
describe('worker boot-time machine artifact reconcile', () => {
  const machine = (id: string, status: string) => ({ id, status }) as Machine

  it('ensures artifacts on every ready machine, skipping non-ready ones', async () => {
    const ensured: string[] = []
    await reconcileMachineArtifactsAtBoot({
      isVmRuntime: () => true,
      listMachines: async () => [machine('m1', 'ready'), machine('m2', 'bootstrapping'), machine('m3', 'ready')],
      ensureMachineArtifacts: async (m) => {
        ensured.push(m.id)
      },
    })
    expect(ensured).toEqual(['m1', 'm3'])
  })

  it('swallows a single machine failure and continues with the rest (never throws)', async () => {
    const ensured: string[] = []
    await expect(
      reconcileMachineArtifactsAtBoot({
        isVmRuntime: () => true,
        listMachines: async () => [machine('m1', 'ready'), machine('m2', 'ready'), machine('m3', 'ready')],
        ensureMachineArtifacts: async (m) => {
          if (m.id === 'm2') throw new Error('ssh: connect to host: Connection refused')
          ensured.push(m.id)
        },
      })
    ).resolves.toBeUndefined()
    expect(ensured).toEqual(['m1', 'm3'])
  })

  it('is a no-op on non-vm runtimes (docker/k8s never even list machines)', async () => {
    let listed = false
    await reconcileMachineArtifactsAtBoot({
      isVmRuntime: () => false,
      listMachines: async () => {
        listed = true
        return []
      },
      ensureMachineArtifacts: async () => {},
    })
    expect(listed).toBe(false)
  })

  it('startup invokes the reconcile fire-and-forget (source contract — boot must not be gated on SSH to every machine)', () => {
    const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    expect(workerSrc).toContain('void reconcileMachineArtifactsAtBoot()')
  })
})

// Boot-time bootstrap-drift reconcile: install_browser (and everything else in
// bootstrap.sh) runs only at provision, so a bootstrap.sh change never reached an
// existing host — this sweep re-bootstraps ready hosts whose stored
// bootstrapVersion drifted from the running core's, fleet-wide, at boot.
describe('worker boot-time bootstrap-drift reconcile', () => {
  const machine = (id: string, status: string, bootstrapVersion: string | null) =>
    ({ id, name: id, status, bootstrapVersion }) as Machine
  // In-memory claim: every listed machine is still claimable unless named.
  const claims = (held: string[] = []) => ({
    claimMachineForBootstrap: async (id: string) =>
      held.includes(id) ? null : ({ id, name: id, status: 'bootstrapping' } as Machine),
    failMachineBootstrapClaim: async () => {},
  })

  it('claims each machine before re-bootstrapping and skips one whose claim is held elsewhere', async () => {
    const claimed: Array<{ id: string; from: readonly string[] }> = []
    const rebootstrapped: Array<{ id: string; status: string }> = []
    await reconcileMachineBootstrapAtBoot({
      isVmRuntime: () => true,
      currentBootstrapVersion: () => 'v2',
      listMachines: async () => [machine('a', 'ready', 'v1'), machine('b', 'ready', 'v1')],
      claimMachineForBootstrap: async (id, from) => {
        claimed.push({ id, from })
        // b was claimed by an operator's POST /bootstrap after the listing.
        return id === 'b' ? null : ({ id, name: id, status: 'bootstrapping' } as Machine)
      },
      failMachineBootstrapClaim: async () => {},
      bootstrapMachine: async (m) => {
        rebootstrapped.push({ id: m.id, status: m.status })
      },
    })
    expect(claimed).toEqual([
      { id: 'a', from: ['ready'] },
      { id: 'b', from: ['ready'] },
    ])
    // Runs with the claimed row, and never on the machine someone else holds.
    expect(rebootstrapped).toEqual([{ id: 'a', status: 'bootstrapping' }])
  })

  it('settles its claim when the re-bootstrap throws before recording an outcome', async () => {
    const failed: Array<{ id: string; lastError: string }> = []
    await reconcileMachineBootstrapAtBoot({
      isVmRuntime: () => true,
      currentBootstrapVersion: () => 'v2',
      listMachines: async () => [machine('a', 'ready', 'v1')],
      claimMachineForBootstrap: async (id) => ({ id, name: id, status: 'bootstrapping' }) as Machine,
      failMachineBootstrapClaim: async (id, lastError) => {
        failed.push({ id, lastError })
      },
      bootstrapMachine: async () => {
        throw new Error('secret store unavailable')
      },
    })
    expect(failed).toEqual([{ id: 'a', lastError: 'secret store unavailable' }])
  })

  it('re-bootstraps only ready machines whose bootstrapVersion drifted from the current one', async () => {
    const rebootstrapped: string[] = []
    await reconcileMachineBootstrapAtBoot({
      ...claims(),
      isVmRuntime: () => true,
      currentBootstrapVersion: () => 'v2',
      listMachines: async () => [
        machine('current', 'ready', 'v2'), // up to date → skip
        machine('drifted', 'ready', 'v1'), // drift → re-bootstrap
        machine('never', 'ready', null), // never stamped → re-bootstrap
        machine('notready', 'bootstrapping', 'v1'), // drift but not ready → skip
      ],
      bootstrapMachine: async (m) => {
        rebootstrapped.push(m.id)
      },
    })
    expect(rebootstrapped).toEqual(['drifted', 'never'])
  })

  it('swallows a single re-bootstrap failure and continues (never throws)', async () => {
    const rebootstrapped: string[] = []
    await expect(
      reconcileMachineBootstrapAtBoot({
        ...claims(),
        isVmRuntime: () => true,
        currentBootstrapVersion: () => 'v2',
        listMachines: async () => [
          machine('a', 'ready', 'v1'),
          machine('b', 'ready', 'v1'),
          machine('c', 'ready', 'v1'),
        ],
        bootstrapMachine: async (m) => {
          if (m.id === 'b') throw new Error('ssh: connect to host: Connection refused')
          rebootstrapped.push(m.id)
        },
      })
    ).resolves.toBeUndefined()
    expect(rebootstrapped).toEqual(['a', 'c'])
  })

  it('does nothing when every ready machine is already current', async () => {
    let bootstrapped = false
    await reconcileMachineBootstrapAtBoot({
      ...claims(),
      isVmRuntime: () => true,
      currentBootstrapVersion: () => 'v2',
      listMachines: async () => [machine('a', 'ready', 'v2'), machine('b', 'ready', 'v2')],
      bootstrapMachine: async () => {
        bootstrapped = true
      },
    })
    expect(bootstrapped).toBe(false)
  })

  it('is a no-op on non-vm runtimes (never lists machines)', async () => {
    let listed = false
    await reconcileMachineBootstrapAtBoot({
      isVmRuntime: () => false,
      listMachines: async () => {
        listed = true
        return []
      },
    })
    expect(listed).toBe(false)
  })

  it('startup invokes the bootstrap reconcile fire-and-forget', () => {
    const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    expect(workerSrc).toContain('void reconcileMachineBootstrapAtBoot()')
  })
})

// Boot-recovery contract — INVERTED: the worker must NOT clear box migration
// fences. Migrations (migrateBox / rebalanceFleet) EXECUTE IN THE API PROCESS
// (routes/machines.ts, mounted in index.ts, calls them directly — the CLI goes
// through those HTTP routes), so a fence observed at WORKER boot may be LIVE in
// an in-flight API-side migrate: a worker restart that cleared it would let the
// next pickupQueuedExecutions start the deferred turn on the OLD box, which the
// migrate then repoints + userdels under the running turn — turn killed and
// ~/.private writes lost. The API clears orphaned fences at ITS boot instead
// (see index.test.ts); the worker's pickup only ever DEFERS on a fence, so a
// stale one here merely delays a turn until the API boot lifts it.
describe('worker stale migration-fence recovery', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')

  it('does NOT clear migration fences at worker boot (a fence may be live in the API process)', () => {
    expect(workerSrc).not.toContain('clearAllMigratingFences')
    expect(workerSrc).not.toContain('recoverMigrationFencesOnce')
  })
})

// Shutdown contract: executions run in the WORKER, so this process holds the
// majority of the vm runtime's SSH `-L` tunnel forwards. Only the sandbox
// manager's cleanup() releases them (forwards only — never `-O exit` on the
// shared ControlMaster) — without it every worker SIGTERM permanently strands
// its listeners inside the long-lived shared master. A unit test can't drive a
// real SIGTERM through the whole worker, so pin the wiring by source contract
// (same pattern as the provider-registration guard above).
describe('worker graceful shutdown', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
  // The shutdown work lives in shutdownWorker(); gracefulShutdown() (SIGTERM/
  // SIGINT) and the API-restart listener are thin wrappers that call it and
  // then exit (0 for a stop, non-zero for a restart — see #1051/#1066).
  const fnStart = workerSrc.indexOf('async function shutdownWorker')
  const fnEnd = workerSrc.indexOf('async function gracefulShutdown', fnStart)
  const body = workerSrc.slice(fnStart, fnEnd)

  it("shutdownWorker releases this process's sandbox resources (tunnel forwards) before the wrapper exits", () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    expect(body).toContain('getSandboxManager().cleanup()')
  })

  it('gates the cleanup to the vm runtime — docker/k8s keep no-cleanup-on-worker-shutdown behavior', () => {
    // DockerSandboxManager.cleanup() STOPS every tracked container: an ungated
    // call would make every worker deploy interrupt running agents on the
    // docker tier, whose containers have always survived worker restarts.
    const gateIdx = body.indexOf('if (isVmRuntime())')
    const cleanupIdx = body.indexOf('getSandboxManager().cleanup()')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(cleanupIdx).toBeGreaterThan(gateIdx)
  })

  it('delegates live and sessionless requeues to one atomic shutdown recovery boundary', () => {
    expect(body).not.toContain('[System] Agent interrupted and will resume automatically.')
    expect(body).not.toContain("transitionTo({ kind: 'requeued' })")
    expect(body).toContain('requeueOwnedExecutionsForShutdown(executionIds)')
  })

  it('orders the cleanup after stopSubsystems and before closeLocalEvents', () => {
    // After stopSubsystems: subsystems (idle reaper &c) may still be touching
    // forwards until stopped. Before closeLocalEvents: cleanup is the last
    // sandbox-layer act; tearing down the cross-process event transport is the
    // process's final teardown.
    const stopIdx = body.indexOf('stopSubsystems')
    const cleanupIdx = body.indexOf('getSandboxManager().cleanup()')
    const eventsIdx = body.indexOf('closeLocalEvents')
    expect(stopIdx).toBeGreaterThan(-1)
    expect(cleanupIdx).toBeGreaterThan(stopIdx)
    expect(eventsIdx).toBeGreaterThan(cleanupIdx)
  })
})

// The worker's cross-process event listener must be its OWN server: the stream
// server above binds every interface, while startWorkerEventServer defaults to
// loopback and supports only an explicitly configured authenticated private
// split-namespace bind (see local-events.test.ts). The import.meta.main block can't
// be driven from a unit test, so pin the wiring by source contract.
describe('worker cross-process event transport', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')

  it('starts the dedicated private event listener at boot', () => {
    expect(workerSrc).toContain('startWorkerEventServer()')
  })

  it('does not serve internal events off the stream server, which binds every interface', () => {
    expect(workerSrc).not.toContain("app.post('/internal/events'")
    expect(workerSrc).not.toContain('INTERNAL_EVENTS_PATH')
  })

  it("configures the transport as the 'worker' side so events forward to the api", () => {
    expect(workerSrc).toContain("configureLocalEvents('worker')")
  })
})

describe('worker sandbox provision recovery lifecycle', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
  const recoverySrc = readFileSync(join(import.meta.dir, 'services/sandbox/k8s/provision-recovery.ts'), 'utf8')

  it('starts durable provision recovery after the live-session recovery watch', () => {
    const watch = workerSrc.indexOf("'sandbox-recovery-watch'")
    const durable = workerSrc.indexOf("'sandbox-provision-recovery'")
    expect(watch).toBeGreaterThan(-1)
    expect(durable).toBeGreaterThan(watch)
  })

  it('uses immediate idempotent startup, transition hints, and listener cleanup', () => {
    expect(recoverySrc).toContain('if (recoveryRunner) return')
    expect(recoverySrc).toContain('runImmediately: true')
    expect(recoverySrc).toContain("eventEmitter.on('sandbox.provision-transition'")
    expect(recoverySrc).toContain('unsubscribeTransition?.()')
    expect(recoverySrc).toContain('await recoveryRunner.stop()')
  })
})

// Periodic sandbox maintenance is worker-owned, mirroring the vm lifecycle
// runner (started only here). Importing worker.ts must claim it before any
// lazily-constructed sandbox manager exists, or the k8s reconcile + idle loops
// stay dark in the process that is supposed to run them.
describe('worker sandbox periodic maintenance ownership', () => {
  it('claims periodic sandbox maintenance at module load', () => {
    expect(runsPeriodicSandboxMaintenance()).toBe(true)
  })
})

describe('worker fleet-alert runtime wiring', () => {
  it('starts and stops the same fleet alert runtime through the worker subsystem lifecycle', async () => {
    const calls: string[] = []
    const item = createFleetAlertSubsystem(async () => ({
      start: () => calls.push('start'),
      stop: async () => {
        calls.push('stop')
      },
    }))

    expect(item.name).toBe('fleet-alert-runtime')
    await item.start()
    await item.stop()
    expect(calls).toEqual(['start', 'stop'])
  })
})

// The admission process-liveness lock loss must RESTART the worker (exit
// non-zero), not stray through the default SIGTERM handler that exits 0 and
// leaves it down under Restart=on-failure — the crash-loop observed on chowmein.
describe('worker admission-liveness loss restarts (non-zero exit), never stays down', () => {
  const workerSrc = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')

  it('passes a custom onUnexpectedLoss to startAdmissionProcessLiveness (not the SIGTERM default)', () => {
    expect(workerSrc).toMatch(/startAdmissionProcessLiveness\(\(\) => \{/)
    expect(workerSrc).toContain('restartWorkerForLivenessLoss()')
  })

  it('routes signals, API restarts, and liveness loss through one shared shutdown promise and exit-code gate', () => {
    expect(workerSrc).toContain('shutdownPromise ??= shutdownWorker(reason)')
    expect(workerSrc).toContain("beginWorkerShutdown('API restart request', RESTART_EXIT_CODE)")
    expect(workerSrc).toContain('await exitAfterWorkerShutdown(signal, 0)')
    expect(workerSrc).toContain("await exitAfterWorkerShutdown('admission process-liveness loss', RESTART_EXIT_CODE)")
  })
})

// FICUS_SANDBOX_RUNTIME is mandatory and explicit: a misconfigured worker must
// die at boot with the same one-line error the api prints, instead of picking
// up turns it cannot run. Proven by BOOTING THE REAL WORKER in a child process
// with a junk DATABASE_URL and unused ports — the guard fires before startup()
// reaches any of them, so nothing outside the child is touched.
describe('worker requires an explicit FICUS_SANDBOX_RUNTIME at boot', () => {
  const RUNTIME_LIST = 'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host'

  async function bootWorker(runtime: string | null): Promise<{ exitCode: number; stderr: string }> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Unreachable (port 1) but named tau_test, because the child inherits
      // FICUS_TEST_MODE=1 from this suite and db/index.ts refuses to load in test
      // mode against any other database name.
      DATABASE_URL: 'postgres://x:x@127.0.0.1:1/tau_test',
      WORKER_PORT: '39911',
      FICUS_WORKER_EVENT_PORT: '39912',
    }
    if (runtime === null) delete env.FICUS_SANDBOX_RUNTIME
    else env.FICUS_SANDBOX_RUNTIME = runtime
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'worker.ts')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000)
    try {
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      return { exitCode, stderr }
    } finally {
      clearTimeout(timer)
    }
  }

  it('exits 1 with the five-value message on an unknown runtime', async () => {
    const { exitCode, stderr } = await bootWorker('bogus')
    expect(stderr).toContain(RUNTIME_LIST)
    expect(stderr).toContain('(got "bogus")')
    expect(exitCode).toBe(1)
  }, 20_000)

  it('exits 1 saying the runtime is unset when the variable is absent', async () => {
    const { exitCode, stderr } = await bootWorker(null)
    expect(stderr).toContain(RUNTIME_LIST)
    expect(stderr).toContain('(is unset)')
    expect(exitCode).toBe(1)
  }, 20_000)

  // A NAMED runtime still has to be usable. docker-sysbox on a host without
  // sysbox must not silently downgrade to socket mode (that would hand agents
  // the host's docker socket after the operator asked for isolation), so the
  // worker — the process that actually runs turns — has to find out at boot,
  // not on the first tool call.
  it('exits 1 when docker-sysbox is requested on a host without sysbox', async () => {
    if (isSysboxAvailable()) return // this host really has sysbox: nothing to prove
    const { exitCode, stderr } = await bootWorker('docker-sysbox')
    expect(stderr).toContain('the sysbox runtime is not installed on this host')
    expect(exitCode).toBe(1)
  }, 20_000)
})

describe('worktree cleanup reconciliation ownership', () => {
  it('runs a separate startup and periodic outbox reconciler', () => {
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8')
    expect(source.includes("name: 'worktree-cleanup'")).toBe(true)
    expect(source.includes('task: reconcileWorktreeCleanup')).toBe(true)
  })
})

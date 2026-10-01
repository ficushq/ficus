import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, like, sql } from 'drizzle-orm'
import net from 'node:net'
import http from 'node:http'
import type { LocalDeployment } from '@ficus/shared'
import { db, squads, localDeployments, withDedicatedDbTransaction } from '../../db'
import { Squad } from '../../entities/Squad'
import {
  archiveLocalDeploymentRecord,
  createLocalDeployment,
  getLocalDeployment,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import {
  probeLocalDeploymentHttp,
  configureLocalDeploymentHealthDependencies,
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
  stopLocalDeploymentReadinessChecks,
  restartManagedLocalDeploymentsForSandbox,
} from './local-deployment-health'
import { drainLocalDeploymentHealthObservations } from './local-deployment-observation'
import { LocalDeploymentLaunchFailedError } from './local-deployment-process-supervisor'
import {
  clearBoxMigrating,
  deleteMachine,
  fenceBoxForMigration,
  insertMachine,
  upsertMachineBox,
} from '../machines/queries'

class FakeSupervisor {
  sessions = new Map<string, boolean>()
  starts: Array<{ localDeploymentId: string; sandboxId: string; command: string; cwd?: string | null; port: number }> =
    []

  async hasSession(_sandboxId: string, processId: string): Promise<boolean> {
    return this.sessions.get(processId) ?? false
  }

  failStartsFor = new Set<string>()

  stops: string[] = []

  async stopLocalDeployment(_sandboxId: string, processId: string): Promise<void> {
    this.stops.push(processId)
  }

  async startManagedLocalDeployment(args: {
    localDeploymentId: string
    sandboxId: string
    command: string
    cwd?: string | null
    port: number
  }): Promise<{ processId: string }> {
    this.starts.push(args)
    if (this.failStartsFor.has(args.localDeploymentId)) throw new LocalDeploymentLaunchFailedError()
    return { processId: `tau-local-deployment-${args.localDeploymentId.slice(0, 8)}` }
  }
}

describe('localDeployment health', () => {
  let testPrefix: string
  let supervisor: FakeSupervisor
  let connectResult: boolean
  const connectCalls: Array<{ host: string; port: number }> = []

  beforeEach(() => {
    testPrefix = `local-deployment-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    supervisor = new FakeSupervisor()
    connectResult = false
    connectCalls.length = 0
    configureLocalDeploymentHealthDependencies({
      probeLocalDeploymentHttp: async (host, port) => {
        connectCalls.push({ host, port })
        return connectResult
      },
      ensureSquadSandbox: async () => '/workspace',
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 45173 }),
      supervisor: supervisor as any,
    })
  })

  afterEach(async () => {
    await stopLocalDeploymentReadinessChecks()
    configureLocalDeploymentHealthDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function createTestSquad(name: string): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-${name}`, purpose: 'LocalDeployment health test squad' })
      .returning()
    return new Squad(row)
  }

  it('marks a healthy attached localDeployment running when HTTP readiness succeeds', async () => {
    connectResult = true
    const squad = await createTestSquad('attached')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })

    const refreshed = await refreshLocalDeploymentHealth(localDeployment.id)

    expect(refreshed.status).toBe('running')
    expect(refreshed.keepSandboxAlive).toBe(true)
    expect(connectCalls).toEqual([{ host: 'localhost', port: 45173 }])
  })

  it('does not resurrect a stopped row from an older health snapshot', async () => {
    connectResult = true
    const squad = await createTestSquad('prefetched')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })

    // A poller snapshot can race an explicit stop. A late probe must not undo it.
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'stopped' })

    const refreshed = await refreshLocalDeploymentHealth(localDeployment)

    expect(connectCalls).toEqual([{ host: 'localhost', port: 45173 }])
    expect(refreshed.status).toBe('stopped')
  })

  it('marks a managed localDeployment crashed when tmux session is gone and health fails', async () => {
    connectResult = false
    const squad = await createTestSquad('crashed')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, {
      status: 'running',
      processId: 'tau-local-deployment-deadbeef',
    })
    supervisor.sessions.set('tau-local-deployment-deadbeef', false)

    const refreshed = await refreshLocalDeploymentHealth(localDeployment.id)

    expect(refreshed.status).toBe('crashed')
    expect(refreshed.keepSandboxAlive).toBe(false)
  })

  it('does not treat an accepting forward with no upstream as app readiness', async () => {
    // Models SSH -L: the local accept happens before opening the remote channel.
    const sockets = new Set<net.Socket>()
    const forward = net.createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.end()
    })
    await new Promise<void>((resolve) => forward.listen(0, '127.0.0.1', resolve))
    try {
      const port = (forward.address() as net.AddressInfo).port
      expect(await probeLocalDeploymentHttp('127.0.0.1', port)).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => forward.close(() => resolve()))
    }
  })

  it('requires an HTTP response, accepts auth/route responses, and rejects server failures', async () => {
    let status = 200
    const app = http.createServer((_req, res) => {
      res.writeHead(status)
      res.end('fixture')
    })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    try {
      const port = (app.address() as net.AddressInfo).port
      for (const code of [200, 401, 404]) {
        status = code
        expect(await probeLocalDeploymentHttp('127.0.0.1', port)).toBe(true)
      }
      status = 503
      expect(await probeLocalDeploymentHttp('127.0.0.1', port)).toBe(false)
    } finally {
      app.closeAllConnections()
      await new Promise<void>((resolve) => app.close(() => resolve()))
    }
  })

  it('detects process loss even when a tunnel or unrelated app accepts the port', async () => {
    connectResult = true
    const squad = await createTestSquad('false-ready')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'gone' })
    const refreshed = await refreshLocalDeploymentHealth(deployment.id)
    expect(refreshed.status).toBe('crashed')
    expect(connectCalls).toHaveLength(0)
  })

  it('corrects stale running on box transport loss without claiming the app crashed', async () => {
    const squad = await createTestSquad('box-lost')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'old-session' })
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => {
        throw new Error('secret transport diagnostic')
      },
    })
    await expect(refreshLocalDeploymentHealth(deployment.id)).rejects.toThrow('Sandbox unavailable')
    expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
    expect(supervisor.starts).toHaveLength(0)
  })

  it('does not restart a stopped app after a stale poller decision', async () => {
    const squad = await createTestSquad('stopped')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'stopped', keepSandboxAlive: false })
    expect((await restartManagedLocalDeployment(deployment.id)).status).toBe('stopped')
    expect(supervisor.starts).toHaveLength(0)
  })

  it('rechecks stop intent after awaiting sandbox recovery', async () => {
    const squad = await createTestSquad('stop-during-ensure')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    configureLocalDeploymentHealthDependencies({
      supervisor: supervisor as any,
      ensureSquadSandbox: async () => {
        await updateLocalDeploymentRecord(deployment.id, { status: 'stopped', keepSandboxAlive: false })
        return '/workspace'
      },
    })
    expect((await restartManagedLocalDeployment(deployment.id)).status).toBe('stopped')
    expect(supervisor.starts).toHaveLength(0)
  })

  it('cleans up a newly launched session if a stop wins during launch', async () => {
    const squad = await createTestSquad('stop-during-start')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    const start = supervisor.startManagedLocalDeployment.bind(supervisor)
    supervisor.startManagedLocalDeployment = async (args) => {
      const result = await start(args)
      await updateLocalDeploymentRecord(deployment.id, { status: 'stopped', keepSandboxAlive: false })
      return result
    }
    expect((await restartManagedLocalDeployment(deployment.id)).status).toBe('stopped')
    expect(supervisor.stops).toHaveLength(1)
  })

  it('only resurrects a stopped app for an explicit operator restart', async () => {
    const squad = await createTestSquad('explicit-restart')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'stopped' })
    expect((await restartManagedLocalDeployment(deployment.id, { allowStopped: true })).status).toBe('restarting')
    expect(supervisor.starts).toHaveLength(1)
  })

  it('never resurrects archived apps, even for an explicit restart', async () => {
    const squad = await createTestSquad('archived')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await archiveLocalDeploymentRecord(deployment.id)
    expect((await restartManagedLocalDeployment(deployment.id, { allowStopped: true })).status).toBe('stopped')
    expect(supervisor.starts).toHaveLength(0)
  })

  it('records a failed launch rather than leaving a stale running row', async () => {
    const squad = await createTestSquad('failed-launch')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running' })
    supervisor.failStartsFor.add(deployment.id)
    await expect(restartManagedLocalDeployment(deployment.id)).rejects.toThrow('Managed app launch failed')
    expect((await getLocalDeployment(deployment.id))?.status).toBe('crashed')
  })

  it('does not write an older probe over a newer restart generation', async () => {
    const squad = await createTestSquad('stale-probe')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => '/workspace',
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 45173 }),
      probeLocalDeploymentHttp: async () => {
        await updateLocalDeploymentRecord(deployment.id, { status: 'restarting', processId: 'new-session' })
        return true
      },
    })
    expect((await refreshLocalDeploymentHealth(deployment)).status).toBe('restarting')
  })

  it('does not classify an executor transport error as a missing session', async () => {
    const squad = await createTestSquad('session-transport-error')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'old-session' })
    supervisor.hasSession = async () => {
      throw new Error('transport credentials must not escape')
    }
    await expect(refreshLocalDeploymentHealth(deployment.id)).rejects.toThrow('Sandbox unavailable')
    expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
  })

  it('does not launch while another Core process owns the deployment restart lock', async () => {
    const squad = await createTestSquad('cross-process-lock')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await withDedicatedDbTransaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`local-deployment-restart:${deployment.id}`}, 0))`
      )
      await restartManagedLocalDeployment(deployment.id)
      expect(supervisor.starts).toHaveLength(0)
    })
    await restartManagedLocalDeployment(deployment.id)
    expect(supervisor.starts).toHaveLength(1)
  })

  it('preserves unknown launch transport outcomes as unverified, not crashed', async () => {
    const squad = await createTestSquad('launch-transport')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture' })
    supervisor.startManagedLocalDeployment = async () => {
      throw Object.assign(new Error('outcome unknown'), { code: 'BASH_OUTCOME_UNKNOWN' })
    }
    await expect(restartManagedLocalDeployment(deployment.id)).rejects.toThrow()
    expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
  })

  it('bounds a hung session observation and rejects expired late results', async () => {
    const squad = await createTestSquad('observation-deadline')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'fixture-session' })
    const entered = Promise.withResolvers<void>()
    const session = Promise.withResolvers<boolean>()
    let signal: AbortSignal | undefined
    const timeouts: Array<{ callback: () => void; ms: number }> = []
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => '/workspace',
      supervisor: {
        ...supervisor,
        hasSession: async (_sandboxId: string, _processId: string, observedSignal?: AbortSignal) => {
          signal = observedSignal
          entered.resolve()
          return session.promise
        },
      } as any,
      probeLocalDeploymentHttp: async () => true,
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 5173 }),
      scheduleObservationTimeout: (callback: () => void, ms: number) => {
        timeouts.push({ callback, ms })
        return () => {}
      },
    } as any)
    const observation = refreshLocalDeploymentHealth(deployment.id).catch((error) => error)
    try {
      await entered.promise
      expect(timeouts).toHaveLength(1)
      expect(timeouts[0].ms).toBe(5000)
      timeouts[0].callback()
      expect(signal?.aborted).toBe(true)
      expect(await observation).toBeInstanceOf(Error)
      expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
      // A second tick cannot open another pending read while cancellation settles.
      await expect(refreshLocalDeploymentHealth(deployment.id)).rejects.toThrow()
      session.resolve(true)
      await drainLocalDeploymentHealthObservations()
      expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
      expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('running')
    } finally {
      session.resolve(true)
      await observation
    }
  })

  it('cancels owned startup readiness timers before fixture disposal', async () => {
    const squad = await createTestSquad('owned-readiness')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture' })
    const sleeper = Promise.withResolvers<void>()
    let timerSignal: AbortSignal | undefined
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => '/workspace',
      supervisor: supervisor as any,
      waitForReadinessInterval: (signal: AbortSignal, ms: number) => {
        expect(ms).toBe(500)
        timerSignal = signal
        signal.addEventListener('abort', () => sleeper.reject(new DOMException('cancelled', 'AbortError')), {
          once: true,
        })
        return sleeper.promise
      },
    } as any)
    await restartManagedLocalDeployment(deployment.id)
    const stop = stopLocalDeploymentReadinessChecks()
    try {
      expect(timerSignal?.aborted).toBe(true)
      await stop
    } finally {
      sleeper.resolve()
      await stop
    }
  })

  it('gives an initial live session a finite readiness grace, not repeated launch churn', async () => {
    const squad = await createTestSquad('initial-readiness-grace')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture' })
    await updateLocalDeploymentRecord(deployment.id, { processId: 'booting' })
    supervisor.sessions.set('booting', true)
    expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('starting')
    // Expire this fixture's initial grace without sleeping or replacing clocks.
    await db
      .update(localDeployments)
      .set({ createdAt: new Date(Date.now() - 11_000) })
      .where(eq(localDeployments.id, deployment.id))
    expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('unhealthy')
  })

  it('does not keep a pre-launch crash observation after an unknown launch outcome', async () => {
    const squad = await createTestSquad('unknown-launch-stale-crash')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'old-session' })
    supervisor.startManagedLocalDeployment = async () => {
      // Another Core observed the missing old session before the new launch's
      // transport outcome became unknown. That does not prove the NEW launch died.
      await updateLocalDeploymentRecord(deployment.id, { status: 'crashed' })
      throw Object.assign(new Error('unknown outcome'), { code: 'BASH_OUTCOME_UNKNOWN' })
    }
    await expect(restartManagedLocalDeployment(deployment.id)).rejects.toThrow('unverified')
    expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
  })

  it('restarts managed localDeployments with restartPolicy always', async () => {
    const squad = await createTestSquad('restart')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    const restarted = await restartManagedLocalDeployment(localDeployment.id)

    expect(restarted.status).toBe('restarting')
    expect(restarted.processId).toBe(`tau-local-deployment-${localDeployment.id.slice(0, 8)}`)
    expect(restarted.restartCount).toBe(1)
    expect(supervisor.starts).toHaveLength(1)
    expect(supervisor.starts[0]).toMatchObject({
      localDeploymentId: localDeployment.id,
      sandboxId: squad.sandboxId,
      command: 'bun run dev',
    })
  })

  it('joins a restart already in flight instead of starting the deployment twice', async () => {
    const squad = await createTestSquad('single-flight')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    const [first, second] = await Promise.all([
      restartManagedLocalDeployment(localDeployment.id),
      restartManagedLocalDeployment(localDeployment.id),
    ])

    expect(supervisor.starts).toHaveLength(1)
    expect(second).toBe(first)
    expect(first.restartCount).toBe(1)

    await restartManagedLocalDeployment(localDeployment.id)
    expect(supervisor.starts).toHaveLength(2)
  })

  it('leaves a deployment whose tmux session is still alive when its box reappears', async () => {
    const squad = await createTestSquad('alive-on-reensure')
    const alive = await createLocalDeployment(squad, { name: 'alive', port: 5173, command: 'bun run dev' })
    const gone = await createLocalDeployment(squad, { name: 'gone', port: 5174, command: 'bun run dev' })
    await updateLocalDeploymentRecord(alive.id, { status: 'running', processId: 'tau-local-deployment-alive' })
    await updateLocalDeploymentRecord(gone.id, { status: 'running', processId: 'tau-local-deployment-gone' })
    supervisor.sessions.set('tau-local-deployment-alive', true)

    await restartManagedLocalDeploymentsForSandbox(squad.sandboxId)

    expect(supervisor.starts.map((start) => start.localDeploymentId)).toEqual([gone.id])
    const untouched = (await getLocalDeployment(alive.id)) as LocalDeployment
    expect(untouched.status).toBe('running')
    expect(untouched.restartCount).toBe(0)
  })

  it('restarts the remaining deployments when one fails, then reports the failure', async () => {
    const squad = await createTestSquad('one-fails')
    const failing = await createLocalDeployment(squad, { name: 'failing', port: 5173, command: 'bun run dev' })
    const healthy = await createLocalDeployment(squad, { name: 'healthy', port: 5174, command: 'bun run dev' })
    // These are recovery candidates, not fresh initial launches in grace.
    await updateLocalDeploymentRecord(failing.id, { status: 'crashed' })
    await updateLocalDeploymentRecord(healthy.id, { status: 'crashed' })
    supervisor.failStartsFor.add(failing.id)

    await expect(restartManagedLocalDeploymentsForSandbox(squad.sandboxId)).rejects.toThrow('Managed app launch failed')

    expect(supervisor.starts.map((start) => start.localDeploymentId).sort()).toEqual([failing.id, healthy.id].sort())
    const restarted = (await getLocalDeployment(healthy.id)) as LocalDeployment
    expect(restarted.status).toBe('restarting')
  })

  it('does not restart attached localDeployments', async () => {
    const squad = await createTestSquad('no-attached-restart')
    const attached = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await restartManagedLocalDeploymentsForSandbox(squad.sandboxId)

    const unchanged = (await getLocalDeployment(attached.id)) as LocalDeployment
    expect(unchanged.status).toBe('starting')
    expect(supervisor.starts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// restart migration-fence guard (real `machine_boxes.migrating`, no fakes)
//
// A box migration's quiesce marks a managed-always deployment `crashed` (not
// `stopped`) SO IT STAYS RESTARTABLE — but `crashed` is exactly the status the
// health poller and ensureSquadSandbox restart on. Without a guard, either one
// resurrects the process on the OLD box while its ~/workspace is being tar'd,
// racing live writes against the archive. The guard reuses the SAME
// `machine_boxes.migrating` fence box-migrate.ts sets — no second flag.
// ---------------------------------------------------------------------------

describe('restartManagedLocalDeployment — migration fence guard (DB)', () => {
  const prefix = `ld-health-mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const createdMachineIds: string[] = []
  let supervisor: FakeSupervisor

  beforeEach(() => {
    supervisor = new FakeSupervisor()
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => '/workspace',
      supervisor: supervisor as any,
    })
  })

  afterEach(async () => {
    await stopLocalDeploymentReadinessChecks()
    configureLocalDeploymentHealthDependencies()
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    for (const id of createdMachineIds.splice(0)) {
      await deleteMachine(id)
    }
  })

  async function createFencedSquad(name: string): Promise<{ squad: Squad; sandboxId: string }> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${prefix}-${name}`, purpose: 'migration-fence guard test squad' })
      .returning()
    const squad = new Squad(row)
    const machine = await insertMachine({
      name: `${prefix}-${name}-machine`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
    })
    createdMachineIds.push(machine.id)
    await upsertMachineBox({
      sandboxId: squad.sandboxId,
      machineId: machine.id,
      unixUser: 'box_deadbeef0000',
      port: 50100,
    })
    return { squad, sandboxId: squad.sandboxId }
  }

  /** Claim the REAL migration fence on the box row (mirrors fenceBoxForMigration
   *  as box-migrate.ts's own fence step calls it — no active execution). */
  async function fence(sandboxId: string): Promise<void> {
    const won = await fenceBoxForMigration(sandboxId, async () => false)
    expect(won).toBe(true)
  }

  it('default: does NOT restart a crashed managed deployment while the box is migrating', async () => {
    const { squad, sandboxId } = await createFencedSquad('default-skip')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })
    await fence(sandboxId)

    const result = await restartManagedLocalDeployment(localDeployment.id)

    // No process was started, and the DB row is untouched (still `crashed`) —
    // the poller's self-heal is a no-op while the fence is up.
    expect(supervisor.starts).toHaveLength(0)
    expect(result.status).toBe('crashed')
  })

  it('restarts again once the fence drops (the benign self-heal, once the migration finishes or aborts)', async () => {
    const { squad, sandboxId } = await createFencedSquad('unfenced')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })
    await fence(sandboxId)
    await clearBoxMigrating(sandboxId)

    const result = await restartManagedLocalDeployment(localDeployment.id)

    expect(supervisor.starts).toHaveLength(1)
    expect(result.status).toBe('restarting')
  })

  it('skipIfMigrating: false forces the restart through the fence — box-migrate.ts’s own post-move call', async () => {
    const { squad, sandboxId } = await createFencedSquad('force-through')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })
    await fence(sandboxId)

    const result = await restartManagedLocalDeployment(localDeployment.id, { skipIfMigrating: false })

    expect(supervisor.starts).toHaveLength(1)
    expect(result.status).toBe('restarting')
  })

  it('restartManagedLocalDeploymentsForSandbox forwards the guard by default (ensure-triggered restart path)', async () => {
    const { squad, sandboxId } = await createFencedSquad('plural-default')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })
    await fence(sandboxId)

    await restartManagedLocalDeploymentsForSandbox(sandboxId)

    expect(supervisor.starts).toHaveLength(0)
    const unchanged = (await getLocalDeployment(localDeployment.id)) as LocalDeployment
    expect(unchanged.status).toBe('crashed')
  })

  it('restartManagedLocalDeploymentsForSandbox forwards skipIfMigrating: false (box-migrate.ts post-move restart)', async () => {
    const { squad, sandboxId } = await createFencedSquad('plural-forced')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })
    await fence(sandboxId)

    await restartManagedLocalDeploymentsForSandbox(sandboxId, { skipIfMigrating: false })

    expect(supervisor.starts).toHaveLength(1)
    const restarted = (await getLocalDeployment(localDeployment.id)) as LocalDeployment
    expect(restarted.status).toBe('restarting')
  })
})

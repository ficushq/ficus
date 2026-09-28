import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import type { LocalDeployment } from '@ficus/shared'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { createLocalDeployment, getLocalDeployment, updateLocalDeploymentRecord } from './local-deployment-service'
import {
  configureLocalDeploymentHealthDependencies,
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
  restartManagedLocalDeploymentsForSandbox,
} from './local-deployment-health'
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

  async startManagedLocalDeployment(args: {
    localDeploymentId: string
    sandboxId: string
    command: string
    cwd?: string | null
    port: number
  }): Promise<{ processId: string }> {
    this.starts.push(args)
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
      canConnect: async (host, port) => {
        connectCalls.push({ host, port })
        return connectResult
      },
      ensureSquadSandbox: async () => '/workspace',
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 45173 }),
      supervisor: supervisor as any,
    })
  })

  afterEach(async () => {
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

  it('marks a healthy attached localDeployment running when TCP connect succeeds', async () => {
    connectResult = true
    const squad = await createTestSquad('attached')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })

    const refreshed = await refreshLocalDeploymentHealth(localDeployment.id)

    expect(refreshed.status).toBe('running')
    expect(refreshed.keepSandboxAlive).toBe(true)
    expect(connectCalls).toEqual([{ host: 'localhost', port: 45173 }])
  })

  it('uses an already-loaded localDeployment row instead of re-reading it', async () => {
    connectResult = true
    const squad = await createTestSquad('prefetched')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })

    // Diverge the DB row from the in-hand row. A re-read would see 'stopped'
    // and return early without probing; using the passed row must probe.
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'stopped' })

    const refreshed = await refreshLocalDeploymentHealth(localDeployment)

    expect(connectCalls).toEqual([{ host: 'localhost', port: 45173 }])
    expect(refreshed.status).toBe('running')
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
      sshUser: 'tau',
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

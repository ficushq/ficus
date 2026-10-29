import { withVmSetupLease } from '../sandbox/vm/setup-state'
import { createPostgresConnection, getDirectConnectionString } from '../../db/connection'
import { vmSetupLockKey } from '../sandbox/vm/setup-lock'
import { bindMachineBox } from './queries'
import { coalesceVmProvision } from '../sandbox/vm/provision-flight'
import { reserveExecutionHostCapacity, reservePhysicalHostCapacity, readSandboxHostCapacity } from './host-admission'
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  agents,
  executions,
  machines,
  machineBoxes,
  machineCapacityClaims,
  squads,
  workStreams,
  vmBoxProvisionAttempts,
} from '../../db'
import { claimHostCapacity, readHostCapacity, pendingStreamBox } from './host-capacity-store'
import { admitOrQueueAtCreation, assertManualAdmissionAllowed } from '../work-streams/admission'

const prefix = `host-capacity-${crypto.randomUUID()}`
let machineId: string
let squadId: string
const agentIds: string[] = []
const provisionIds: number[] = []

beforeEach(async () => {
  const [machine] = await db
    .insert(machines)
    .values({
      name: `${prefix}-${crypto.randomUUID()}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'test',
      sshKeyId: 'unused',
      sshPublicKey: 'unused',
      status: 'ready',
      capabilities: { cpus: 8 },
    })
    .returning()
  machineId = machine.id
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'host capacity tests' }).returning()
  squadId = squad.id
})
afterEach(async () => {
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (provisionIds.length)
    await db.delete(vmBoxProvisionAttempts).where(inArray(vmBoxProvisionAttempts.id, provisionIds.splice(0)))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(machines).where(eq(machines.id, machineId))
})
async function stream(ownerSquadId = squadId) {
  const [row] = await db
    .insert(workStreams)
    .values({ squadId: ownerSquadId, title: prefix, status: 'active' })
    .returning()
  return row
}
async function execution(ownerSquadId = squadId) {
  const [agent] = await db
    .insert(agents)
    .values({ agentTypeId: 'host-capacity-test', squadId: ownerSquadId })
    .returning()
  agentIds.push(agent.id)
  const [row] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
  return row
}
const resources = (...sandboxIds: string[]) => sandboxIds.map((sandboxId) => ({ machineId, sandboxId }))

/** Model other Core processes' leases without taking all of this process's
 * two dedicated permits and deadlocking the operation being tested. */
async function withOtherProcessLeases<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
  const connection = createPostgresConnection(getDirectConnectionString(), { max: 1 })
  const session = await connection.reserve()
  try {
    for (const id of ids) await session`select pg_advisory_lock(hashtextextended(${vmSetupLockKey(id)}, 0))`
    return await operation()
  } finally {
    for (const id of ids) await session`select pg_advisory_unlock(hashtextextended(${vmSetupLockKey(id)}, 0))`
    session.release()
    await connection.end()
  }
}

async function withStartupSlots<T>(count: number, operation: () => Promise<T>): Promise<T> {
  const attempts = await db
    .insert(vmBoxProvisionAttempts)
    .values(Array.from({ length: count }, () => ({ sandboxId: `startup-${crypto.randomUUID()}` })))
    .returning()
  provisionIds.push(...attempts.map((attempt) => attempt.id))
  return withOtherProcessLeases(
    attempts.map((attempt) => attempt.sandboxId),
    async () => {
      for (const attempt of attempts)
        expect(
          await db.transaction((tx) =>
            claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(attempt.sandboxId))
          )
        ).toMatchObject({ allowed: true })
      return operation()
    }
  )
}

describe('durable host capacity claims', () => {
  test('a crashed running generation loses its host claim when its authoritative session lease disappears', async () => {
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'execution', executionId: run.id }, resources('agent_other', 'squad_other'))
    )
    const sandboxId = 'agent_crashed'
    await db
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser: 'box_crashed', port: 20001, status: 'ready' })
    const [attempt] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
    provisionIds.push(attempt.id)
    await withVmSetupLease(sandboxId, async () => {
      expect(
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(sandboxId))
        )
      ).toMatchObject({ allowed: true })
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    })
    // No graceful interruption/terminal update: the row still says running,
    // exactly as after a dead Core session has relinquished its advisory lock.
    expect(
      (await db.select().from(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.id, attempt.id)))[0].status
    ).toBe('running')
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 2 })
    const [next] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId: 'agent_successor' }).returning()
    provisionIds.push(next.id)
    await withVmSetupLease(next.sandboxId, async () => {
      expect(
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: next.id }, resources(next.sandboxId))
        )
      ).toMatchObject({ allowed: true })
    })
  })

  test('a never-started queued execution can join a busy host without an exclusive CPU reservation', async () => {
    const blocker = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: blocker.id },
        resources('agent_busy_1', 'agent_busy_2', 'agent_busy_3')
      )
    )
    const queued = await execution(),
      sandboxId = `agent_${queued.agentId}`
    await db.update(executions).set({ status: 'queued', runStartedAt: null }).where(eq(executions.id, queued.id))
    await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'box_queued', port: 20001, status: 'ready' })
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    expect(
      await db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'execution', executionId: queued.id }, resources(sandboxId))
      )
    ).toMatchObject({ allowed: true })
  })

  for (const blocked of ['terminated', 'pending-dormancy', 'dormant-no-wake', 'paused'] as const) {
    test(`requeued owners release demand when no longer pickable: ${blocked}`, async () => {
      const run = await execution(),
        sandboxId = `agent_${run.agentId}`
      await db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'execution', executionId: run.id }, resources(sandboxId))
      )
      await db
        .update(executions)
        .set({ status: 'queued', runStartedAt: new Date(), wakeEligible: false })
        .where(eq(executions.id, run.id))
      await db
        .insert(machineBoxes)
        .values({ sandboxId, machineId, unixUser: 'box_ineligible', port: 20001, status: 'ready' })
      if (blocked === 'paused') {
        const ws = await stream()
        await db
          .update(workStreams)
          .set({ agentIds: [run.agentId], pause: { pausedAt: new Date().toISOString() } as any })
          .where(eq(workStreams.id, ws.id))
      } else
        await db
          .update(agents)
          .set(
            blocked === 'pending-dormancy'
              ? { pendingDormancyAt: new Date() }
              : { status: blocked === 'terminated' ? 'terminated' : 'dormant' }
          )
          .where(eq(agents.id, run.agentId))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
    })
  }

  test('a pre-upgrade unverified stop remains tracked without an execution owner', async () => {
    await db.insert(machineBoxes).values({
      sandboxId: 'agent_unverified_stop',
      machineId,
      unixUser: 'box_unverified',
      port: 20001,
      status: 'stop_unverified',
    })
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
  })

  test('unadmitted generations cannot mutually occupy a serialized startup lane', async () => {
    await db
      .update(machines)
      .set({ capabilities: { cpus: 2 } })
      .where(eq(machines.id, machineId))
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_pending_a', 'agent_pending_b', 'squad_active')
      )
    )
    await db.insert(machineBoxes).values([
      { sandboxId: 'agent_pending_a', machineId, unixUser: 'box_pending_a', port: 20001, status: 'ready' },
      { sandboxId: 'agent_pending_b', machineId, unixUser: 'box_pending_b', port: 20002, status: 'ready' },
    ])
    const attempts = await db
      .insert(vmBoxProvisionAttempts)
      .values([{ sandboxId: 'agent_pending_a' }, { sandboxId: 'agent_pending_b' }])
      .returning()
    provisionIds.push(...attempts.map((attempt) => attempt.id))
    await withVmSetupLease(attempts[0].sandboxId, () =>
      withVmSetupLease(attempts[1].sandboxId, async () => {
        const outcomes = await Promise.all(
          attempts.map((attempt) =>
            db.transaction((tx) =>
              claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(attempt.sandboxId))
            )
          )
        )
        expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(1)
        expect(outcomes.find((outcome) => !outcome.allowed)?.reason).toBe('starting')
      })
    )
  })

  test('a refused capacity generation is not proof that earlier unowned remote work stopped', async () => {
    const sandboxId = 'agent_legacy_unknown'
    await db
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser: 'box_unknown', port: 20001, status: 'ensuring' })
    const rows = await db
      .insert(vmBoxProvisionAttempts)
      .values([
        { sandboxId, status: 'failed', failureClass: 'abandoned' },
        { sandboxId, status: 'failed', failureClass: 'capacity:machine_capacity' },
      ])
      .returning()
    provisionIds.push(...rows.map((row) => row.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
  })

  test('changing stream membership updates shared demand without denying the new participant', async () => {
    const a = await stream(),
      b = await stream(),
      original = await execution()
    await db
      .update(workStreams)
      .set({ agentIds: [original.agentId] })
      .where(inArray(workStreams.id, [a.id, b.id]))
    for (const ws of [a, b])
      await db.transaction((tx) =>
        claimHostCapacity(
          tx,
          { kind: 'stream', workStreamId: ws.id },
          resources(`squad_${squadId}`, pendingStreamBox(ws.id))
        )
      )
    const blocker = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'execution', executionId: blocker.id }, resources(`agent_${blocker.agentId}`))
    )
    const replacement = await execution()
    await db
      .update(workStreams)
      .set({ agentIds: [replacement.agentId] })
      .where(eq(workStreams.id, a.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    expect(
      await db.transaction((tx) =>
        claimHostCapacity(
          tx,
          { kind: 'execution', executionId: replacement.id, workStreamId: a.id },
          resources(`agent_${replacement.agentId}`, `squad_${squadId}`)
        )
      )
    ).toMatchObject({ allowed: true })
  })

  test('devbox prewarm cannot bypass host admission or clean up a box it never started', async () => {
    const boxManager = await import('./box-manager')
    const seed = await import('./devbox-seed')
    const nix = await import('./nix-cache')
    const { prewarmMachineDevbox } = await import('./devbox-prewarm')
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_full_a', 'agent_full_b', 'agent_full_c')
      )
    )
    const ensure = spyOn(boxManager, 'ensureBox').mockResolvedValue({
      endpoint: 'http://127.0.0.1:1',
      box: { authToken: null },
      timings: {},
    } as any)
    const install = spyOn(seed, 'seedBoxDevbox').mockResolvedValue({} as any)
    const publish = spyOn(nix, 'publishPrewarmedNixCache').mockResolvedValue(undefined)
    const remove = spyOn(boxManager, 'removeBox').mockResolvedValue(undefined)
    const sandboxId = `devbox-prewarm-agent-${machineId}`
    try {
      await withStartupSlots(2, () => prewarmMachineDevbox(machineId, { roles: ['agent'] }))
      expect(ensure).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      const [attempt] = await db
        .select()
        .from(vmBoxProvisionAttempts)
        .where(eq(vmBoxProvisionAttempts.sandboxId, sandboxId))
      expect(attempt).toMatchObject({ status: 'failed', failureClass: 'capacity:machine_capacity', failureCount: 0 })
    } finally {
      ensure.mockRestore()
      install.mockRestore()
      publish.mockRestore()
      remove.mockRestore()
      await db.delete(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, sandboxId))
    }
  })

  for (const full of [false, true]) {
    test(`bind reconciles reserved and actual host atomically (target full: ${full})`, async () => {
      const [target] = await db
        .insert(machines)
        .values({
          name: `target-${crypto.randomUUID()}`,
          provider: 'ssh',
          sshHost: '127.0.0.1',
          sshUser: 'test',
          sshKeyId: 'unused',
          sshPublicKey: 'unused',
          status: 'ready',
          capabilities: { cpus: 8 },
        })
        .returning()
      try {
        const run = await execution(),
          sandboxId = `agent_${run.agentId}`
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'execution', executionId: run.id }, resources(sandboxId))
        )
        if (full) {
          const blocker = await execution()
          await db.transaction((tx) =>
            claimHostCapacity(
              tx,
              { kind: 'execution', executionId: blocker.id },
              ['agent_busy_a', 'agent_busy_b', 'agent_busy_c'].map((sandboxId) => ({ machineId: target.id, sandboxId }))
            )
          )
        }
        await bindMachineBox({ sandboxId, machineId: target.id, unixUser: 'box_target' })
        expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
        expect(await db.transaction((tx) => readHostCapacity(tx, target.id))).toMatchObject({
          activeBoxes: full ? 4 : 1,
        })
      } finally {
        await db.delete(machines).where(eq(machines.id, target.id))
      }
    })
  }

  test('pickup skips a non-ready recorded host instead of silently refusing every tick', async () => {
    const runtime = process.env.FICUS_SANDBOX_RUNTIME
    const [target] = await db
      .insert(machines)
      .values({
        name: `ready-${crypto.randomUUID()}`,
        provider: 'ssh',
        sshHost: '127.0.0.1',
        sshUser: 'test',
        sshKeyId: 'unused',
        sshPublicKey: 'unused',
        status: 'ready',
        capabilities: { cpus: 8 },
      })
      .returning()
    try {
      const run = await execution(),
        sandboxId = `agent_${run.agentId}`
      await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'box_old', port: 20001, status: 'ready' })
      await db.update(machines).set({ status: 'unreachable' }).where(eq(machines.id, machineId))
      process.env.FICUS_SANDBOX_RUNTIME = 'vm'
      expect(
        (
          await db.transaction((tx) =>
            reserveExecutionHostCapacity(tx, { executionId: run.id, agentId: run.agentId, sandboxIds: [sandboxId] })
          )
        ).allowed
      ).toBe(true)
      const claims = await db.select().from(machineCapacityClaims).where(eq(machineCapacityClaims.executionId, run.id))
      expect(claims.map((c) => c.machineId)).toEqual([target.id])
    } finally {
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
      await db.delete(machines).where(eq(machines.id, target.id))
    }
  })

  test('capacity read failure degrades to unknown rather than breaking the status header', async () => {
    const failed = spyOn(db, 'transaction').mockRejectedValueOnce(new Error('synthetic capacity DB outage'))
    try {
      expect(await readSandboxHostCapacity(`squad_${squadId}`, squadId)).toEqual({ allowed: false, reason: 'unknown' })
    } finally {
      failed.mockRestore()
    }
  })

  test('one agent shared by two active streams consumes one private reservation before and after its turn', async () => {
    const runtime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      const a = await stream(),
        b = await stream(),
        run = await execution()
      await db
        .update(workStreams)
        .set({ agentIds: [run.agentId] })
        .where(inArray(workStreams.id, [a.id, b.id]))
      for (const ws of [a, b])
        await db.transaction((tx) =>
          claimHostCapacity(
            tx,
            { kind: 'stream', workStreamId: ws.id },
            resources(`squad_${squadId}`, pendingStreamBox(ws.id))
          )
        )
      expect(
        (
          await db.transaction((tx) =>
            reserveExecutionHostCapacity(tx, {
              executionId: run.id,
              agentId: run.agentId,
              sandboxIds: [`agent_${run.agentId}`, `squad_${squadId}`],
            })
          )
        ).allowed
      ).toBe(true)
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 2 })
      await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, run.id))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 2 })
    } finally {
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
    }
  })

  test('normal box teardown releases an interrupted claim even when its owner never succeeds again', async () => {
    const sandboxId = 'agent_archived'
    await db
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser: 'box_archived', port: 20001, status: 'ready' })
    const [old] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
    provisionIds.push(old.id)
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: old.id }, resources(sandboxId))
    )
    await db
      .update(vmBoxProvisionAttempts)
      .set({ status: 'failed', failureClass: 'interrupted' })
      .where(eq(vmBoxProvisionAttempts.id, old.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
    // removeBox deletes this row only after authoritative remote teardown.
    await db.delete(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
  })

  test('uncertain remote demand remains charged but cannot own a permanent startup lane', async () => {
    const sandboxId = 'agent_orphan'
    await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'box_orphan', port: 20001, status: 'ready' })
    const [old] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
    provisionIds.push(old.id)
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: old.id }, resources(sandboxId))
    )
    await db
      .update(vmBoxProvisionAttempts)
      .set({ status: 'failed', failureClass: 'abandoned' })
      .where(eq(vmBoxProvisionAttempts.id, old.id))
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'execution', executionId: run.id }, resources('agent_recover', 'squad_other'))
    )
    const [next] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId: 'agent_recover' }).returning()
    provisionIds.push(next.id)
    expect(
      (
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: next.id }, resources('agent_recover'))
        )
      ).allowed
    ).toBe(true)
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
  })

  test('recovery requeue preserves an admitted execution footprint until terminal settlement', async () => {
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_resume_a', 'agent_resume_b', 'agent_resume_c')
      )
    )
    await db.update(executions).set({ status: 'queued' }).where(eq(executions.id, run.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, run.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
  })

  test('physical setups can progress together within the startup limit', async () => {
    const [a, b] = await db
      .insert(vmBoxProvisionAttempts)
      .values([{ sandboxId: 'agent_parallel_a' }, { sandboxId: 'agent_parallel_b' }])
      .returning()
    provisionIds.push(a.id, b.id)
    for (const attempt of [a, b]) {
      expect(
        (
          await db.transaction((tx) =>
            claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(attempt.sandboxId))
          )
        ).allowed
      ).toBe(true)
    }
  })

  test('header readout shows planned host demand before box creation and keeps missing CPU facts unknown', async () => {
    const ws = await stream()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'stream', workStreamId: ws.id },
        resources(`squad_${squadId}`, pendingStreamBox(ws.id))
      )
    )
    expect(await readSandboxHostCapacity(`squad_${squadId}`, squadId)).toMatchObject({
      cpus: 8,
      startupLimit: 2,
      activeBoxes: 2,
    })
    expect(await db.select().from(machineBoxes).where(eq(machineBoxes.machineId, machineId))).toHaveLength(0)
    await db.update(machines).set({ capabilities: {} }).where(eq(machines.id, machineId))
    expect(await readSandboxHostCapacity(`squad_${squadId}`, squadId)).toMatchObject({
      allowed: true,
      reason: 'unknown',
      startupLimit: 1,
    })
  })

  test('physical adapter waits for a startup slot before any physical work executes', async () => {
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_full_a', 'agent_full_b', 'agent_full_c')
      )
    )
    const sandboxId = `physical-adapter-${crypto.randomUUID()}`
    let physicalCalls = 0
    try {
      await withStartupSlots(
        2,
        async () =>
          await expect(
            coalesceVmProvision(
              sandboxId,
              async () => {
                await reservePhysicalHostCapacity(machineId, sandboxId)
                physicalCalls++
              },
              async () => {},
              { withLease: (fn) => fn() }
            )
          ).rejects.toThrow('host capacity')
      )
      expect(physicalCalls).toBe(0)
      const [attempt] = await db
        .select()
        .from(vmBoxProvisionAttempts)
        .where(eq(vmBoxProvisionAttempts.sandboxId, sandboxId))
      expect(attempt.failureCount).toBe(0)
      expect(attempt.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
    } finally {
      await db.delete(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, sandboxId))
    }
  })

  test('small-host startup is serialized with no permit held after verified completion', async () => {
    await db
      .update(machines)
      .set({ capabilities: { cpus: 2 } })
      .where(eq(machines.id, machineId))
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_start_a', 'agent_start_b', 'agent_start_c')
      )
    )

    const [a, b] = await db
      .insert(vmBoxProvisionAttempts)
      .values([{ sandboxId: 'agent_start_a' }, { sandboxId: 'agent_start_b' }])
      .returning()
    provisionIds.push(a.id, b.id)
    const claim = (row: typeof a) =>
      db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: row.id }, resources(row.sandboxId))
      )
    await withVmSetupLease(a.sandboxId, () =>
      withVmSetupLease(b.sandboxId, async () => {
        expect((await claim(a)).allowed).toBe(true)
        expect(await claim(b)).toMatchObject({ allowed: false, reason: 'starting' })
        await db.update(vmBoxProvisionAttempts).set({ status: 'succeeded' }).where(eq(vmBoxProvisionAttempts.id, a.id))
        expect((await claim(b)).allowed).toBe(true)
      })
    )
  })

  test('a newly-created generation is admitted without treating running box ceilings as reserved CPUs', async () => {
    const run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id },
        resources('agent_full_a', 'agent_full_b', 'agent_full_c')
      )
    )
    const sandboxId = 'agent_not_started'
    await db
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser: 'box_not_started', port: 20001, status: 'ready' })
    const [attempt] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
    provisionIds.push(attempt.id)
    expect(
      (
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(sandboxId))
        )
      ).allowed
    ).toBe(true)
  })

  for (const failureClass of ['abandoned', 'interrupted']) {
    test(`${failureClass} physical demand stays charged until same-box success, without blocking its successor`, async () => {
      const sandboxId = `agent_uncertain_${failureClass}`
      await db
        .insert(machineBoxes)
        .values({ sandboxId, machineId, unixUser: 'box_uncertain', port: 20001, status: 'ready' })
      const [old] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
      provisionIds.push(old.id)
      await db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: old.id }, resources(sandboxId))
      )
      await db
        .update(vmBoxProvisionAttempts)
        .set({ status: 'failed', failureClass, completedAt: new Date(0), retryAt: new Date(0) })
        .where(eq(vmBoxProvisionAttempts.id, old.id))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
      const [next] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
      provisionIds.push(next.id)
      expect(
        (
          await db.transaction((tx) =>
            claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: next.id }, resources(sandboxId))
          )
        ).allowed
      ).toBe(true)
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
      await db.update(vmBoxProvisionAttempts).set({ status: 'succeeded' }).where(eq(vmBoxProvisionAttempts.id, next.id))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
    })
  }

  test('execution admission plans actual boxes, substitutes its stream slot, and allows more forks', async () => {
    const runtime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      const ws = await stream()
      await db.transaction((tx) =>
        claimHostCapacity(
          tx,
          { kind: 'stream', workStreamId: ws.id },
          resources(`squad_${squadId}`, pendingStreamBox(ws.id))
        )
      )
      const a = await execution(),
        b = await execution(),
        c = await execution()
      await db
        .update(workStreams)
        .set({ agentIds: [a.agentId, b.agentId, c.agentId] })
        .where(eq(workStreams.id, ws.id))
      const reserve = (run: typeof a) =>
        db.transaction((tx) =>
          reserveExecutionHostCapacity(tx, {
            executionId: run.id,
            agentId: run.agentId,
            sandboxIds: [`agent_${run.agentId}`, `squad_${squadId}`],
          })
        )
      expect((await reserve(a)).allowed).toBe(true)
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 2 })
      expect((await reserve(b)).allowed).toBe(true)
      expect((await reserve(c)).allowed).toBe(true)
    } finally {
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
    }
  })

  test('real work-stream creation and manual admission allow shared CPU use when there is no squad cap', async () => {
    const runtime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      await db.update(squads).set({ machineId }).where(eq(squads.id, squadId))
      const a = await stream(),
        b = await stream(),
        c = await stream()
      const admit = (id: string) => db.transaction((tx) => admitOrQueueAtCreation(tx, { squadId, streamId: id }))
      expect(await admit(a.id)).toBe('admitted')
      expect(await admit(b.id)).toBe('admitted')
      expect(await admit(c.id)).toBe('admitted')
      await db.transaction((tx) => assertManualAdmissionAllowed(tx, { squadId, streamId: c.id, title: c.title }))
    } finally {
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
    }
  })

  test('four squads on one host all admit streams and private-plus-shared executions', async () => {
    const runtime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const created = await db
      .insert(squads)
      .values(
        Array.from({ length: 4 }, (_, i) => ({
          name: `${prefix}-shared-${i}`,
          purpose: 'shared host regression',
          machineId,
        }))
      )
      .returning()
    try {
      for (const squad of created) {
        const ws = await stream(squad.id)
        expect(await db.transaction((tx) => admitOrQueueAtCreation(tx, { squadId: squad.id, streamId: ws.id }))).toBe(
          'admitted'
        )
        const run = await execution(squad.id)
        await db
          .update(workStreams)
          .set({ agentIds: [run.agentId] })
          .where(eq(workStreams.id, ws.id))
        expect(
          await db.transaction((tx) =>
            reserveExecutionHostCapacity(tx, {
              executionId: run.id,
              agentId: run.agentId,
              sandboxIds: [`agent_${run.agentId}`, `squad_${squad.id}`],
            })
          )
        ).toMatchObject({ allowed: true })
      }
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({
        activeBoxes: 8,
        startingBoxes: 0,
      })
    } finally {
      await db.delete(agents).where(
        inArray(
          agents.squadId,
          created.map((squad) => squad.id)
        )
      )
      await db.delete(workStreams).where(
        inArray(
          workStreams.squadId,
          created.map((squad) => squad.id)
        )
      )
      await db.delete(squads).where(
        inArray(
          squads.id,
          created.map((squad) => squad.id)
        )
      )
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
    }
  })

  test('already-running pre-upgrade boxes count before any new-style claims exist', async () => {
    for (let i = 0; i < 3; i++) {
      const run = await execution()
      await db.insert(machineBoxes).values({
        sandboxId: `agent_${run.agentId}`,
        machineId,
        unixUser: `box_test_${i}`,
        port: 20001 + i,
        status: 'ready',
      })
    }
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    await db
      .update(executions)
      .set({ status: 'queued', startedAt: new Date(0), runStartedAt: new Date(0) })
      .where(inArray(executions.agentId, agentIds))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 3 })
    const ws = await stream()
    expect(
      (
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'stream', workStreamId: ws.id }, resources(pendingStreamBox(ws.id)))
        )
      ).allowed
    ).toBe(true)
  })

  test('deleting a stream does not release its still-running execution claim', async () => {
    const ws = await stream(),
      run = await execution()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'execution', executionId: run.id, workStreamId: ws.id },
        resources(`agent_${run.agentId}`)
      )
    )
    await db.delete(workStreams).where(eq(workStreams.id, ws.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 1 })
  })

  test('reserves stream demand before agents exist and deduplicates the shared squad', async () => {
    const a = await stream(),
      b = await stream(),
      c = await stream()
    const claim = (id: string) =>
      db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'stream', workStreamId: id }, resources(`squad_${squadId}`, pendingStreamBox(id)))
      )
    expect((await claim(a.id)).allowed).toBe(true)
    expect((await claim(b.id)).allowed).toBe(true)
    expect((await claim(c.id)).allowed).toBe(true)
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 4 })
  })

  test('execution substitutes its actual box for the pending stream agent; a fork adds demand', async () => {
    const ws = await stream()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'stream', workStreamId: ws.id },
        resources(`squad_${squadId}`, pendingStreamBox(ws.id))
      )
    )
    const a = await execution(),
      b = await execution(),
      c = await execution()
    const claim = (id: string, agentId: string) =>
      db.transaction((tx) =>
        claimHostCapacity(
          tx,
          { kind: 'execution', executionId: id, workStreamId: ws.id },
          resources(`squad_${squadId}`, `agent_${agentId}`)
        )
      )
    expect((await claim(a.id, a.agentId)).allowed).toBe(true)
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 2 })
    expect((await claim(b.id, b.agentId)).allowed).toBe(true)
    expect((await claim(c.id, c.agentId)).allowed).toBe(true)
    await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, a.id))
    expect((await claim(c.id, c.agentId)).allowed).toBe(true)
  })

  test('settled streams and physical generations do not retain capacity', async () => {
    const ws = await stream()
    await db.transaction((tx) =>
      claimHostCapacity(
        tx,
        { kind: 'stream', workStreamId: ws.id },
        resources(`squad_${squadId}`, pendingStreamBox(ws.id))
      )
    )
    const [attempt] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId: 'agent_physical' }).returning()
    provisionIds.push(attempt.id)
    expect(
      (
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources('agent_physical'))
        )
      ).allowed
    ).toBe(true)
    // A failed script can leave a binding in ensuring; that stale label alone
    // must not retain the lane after its authoritative generation settled.
    await db
      .insert(machineBoxes)
      .values({ sandboxId: 'agent_physical', machineId, unixUser: 'box_failed', port: 20001, status: 'ensuring' })
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, ws.id))
    await db.update(vmBoxProvisionAttempts).set({ status: 'failed' }).where(eq(vmBoxProvisionAttempts.id, attempt.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeBoxes: 0 })
  })

  test('concurrent transactions cannot overbook the final startup slot, even on an otherwise idle host', async () => {
    const attempts = await db
      .insert(vmBoxProvisionAttempts)
      .values([{ sandboxId: 'parallel_start_b' }, { sandboxId: 'parallel_start_c' }])
      .returning()
    provisionIds.push(...attempts.map((attempt) => attempt.id))
    const claim = (attempt: (typeof attempts)[number]) =>
      db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: attempt.id }, resources(attempt.sandboxId))
      )
    await withStartupSlots(1, () =>
      withVmSetupLease(attempts[0]!.sandboxId, () =>
        withVmSetupLease(attempts[1]!.sandboxId, async () => {
          const outcomes = await Promise.all(attempts.map(claim))
          expect(outcomes.filter((result) => result.allowed)).toHaveLength(1)
          const loser = attempts[outcomes.findIndex((result) => !result.allowed)]!
          expect(await claim(loser)).toMatchObject({ allowed: false, reason: 'starting' })
          expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({
            startingBoxes: 2,
            startupLimit: 2,
          })
          // Logical execution pickup is independent of expensive physical startup.
          const executionOwner = await execution()
          expect(
            await db.transaction((tx) =>
              claimHostCapacity(
                tx,
                { kind: 'execution', executionId: executionOwner.id },
                resources('another_squad', 'another_agent')
              )
            )
          ).toMatchObject({ allowed: true })
        })
      )
    )
    // Lease loss frees the lane even if the generation rows still say running.
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ startingBoxes: 0 })
    await withVmSetupLease(attempts[0]!.sandboxId, async () => expect((await claim(attempts[0]!)).allowed).toBe(true))
  })
})

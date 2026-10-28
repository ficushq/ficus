import { coalesceVmProvision } from '../sandbox/vm/provision-flight'
import { reserveExecutionHostCapacity, reservePhysicalHostCapacity, readSandboxHostCapacity } from './host-admission'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, executions, machines, machineBoxes, squads, workStreams, vmBoxProvisionAttempts } from '../../db'
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
async function stream() {
  const [row] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  return row
}
async function execution() {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'host-capacity-test', squadId }).returning()
  agentIds.push(agent.id)
  const [row] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
  return row
}
const resources = (...sandboxIds: string[]) => sandboxIds.map((sandboxId) => ({ machineId, sandboxId }))

describe('durable host capacity claims', () => {
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
      budgetCpus: 12,
      activeQuotaCpus: 8,
    })
    expect(await db.select().from(machineBoxes).where(eq(machineBoxes.machineId, machineId))).toHaveLength(0)
    await db.update(machines).set({ capabilities: {} }).where(eq(machines.id, machineId))
    expect(await readSandboxHostCapacity(`squad_${squadId}`, squadId)).toEqual({ allowed: false, reason: 'unknown' })
  })

  test('physical adapter refuses saturated host before any physical work executes', async () => {
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
      expect(physicalCalls).toBe(0)
    } finally {
      await db.delete(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, sandboxId))
    }
  })

  test('physical startup is staggered per host, with no permit held after verified completion', async () => {
    const [a, b] = await db
      .insert(vmBoxProvisionAttempts)
      .values([{ sandboxId: 'agent_start_a' }, { sandboxId: 'agent_start_b' }])
      .returning()
    provisionIds.push(a.id, b.id)
    const claim = (row: typeof a) =>
      db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: row.id }, resources(row.sandboxId))
      )
    expect((await claim(a)).allowed).toBe(true)
    expect(await claim(b)).toMatchObject({ allowed: false, reason: 'starting' })
    await db.update(vmBoxProvisionAttempts).set({ status: 'succeeded' }).where(eq(vmBoxProvisionAttempts.id, a.id))
    expect((await claim(b)).allowed).toBe(true)
  })

  test('a newly-created generation cannot count itself as pre-existing physical demand', async () => {
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
    ).toBe(false)
  })

  for (const failureClass of ['abandoned', 'interrupted']) {
    test(`${failureClass} physical demand stays charged until same-box success, without blocking its successor`, async () => {
      const sandboxId = `agent_uncertain_${failureClass}`
      const [old] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
      provisionIds.push(old.id)
      await db.transaction((tx) =>
        claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: old.id }, resources(sandboxId))
      )
      await db
        .update(vmBoxProvisionAttempts)
        .set({ status: 'failed', failureClass, completedAt: new Date(0), retryAt: new Date(0) })
        .where(eq(vmBoxProvisionAttempts.id, old.id))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 4 })
      const [next] = await db.insert(vmBoxProvisionAttempts).values({ sandboxId }).returning()
      provisionIds.push(next.id)
      expect(
        (
          await db.transaction((tx) =>
            claimHostCapacity(tx, { kind: 'provision', provisionAttemptId: next.id }, resources(sandboxId))
          )
        ).allowed
      ).toBe(true)
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 4 })
      await db.update(vmBoxProvisionAttempts).set({ status: 'succeeded' }).where(eq(vmBoxProvisionAttempts.id, next.id))
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 0 })
    })
  }

  test('execution admission plans actual boxes, substitutes its stream slot, and queues excess forks', async () => {
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
      expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 8 })
      expect((await reserve(b)).allowed).toBe(true)
      expect((await reserve(c)).allowed).toBe(false)
    } finally {
      if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = runtime
    }
  })

  test('real work-stream creation and manual admission respect host capacity even with no squad cap', async () => {
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
      expect(await admit(c.id)).toBe('queued')
      await expect(
        db.transaction((tx) => assertManualAdmissionAllowed(tx, { squadId, streamId: c.id, title: c.title }))
      ).rejects.toThrow('host capacity')
    } finally {
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
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 12 })
    const ws = await stream()
    expect(
      (
        await db.transaction((tx) =>
          claimHostCapacity(tx, { kind: 'stream', workStreamId: ws.id }, resources(pendingStreamBox(ws.id)))
        )
      ).allowed
    ).toBe(false)
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
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 4 })
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
    expect((await claim(c.id)).allowed).toBe(false)
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 12 })
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
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 8 })
    expect((await claim(b.id, b.agentId)).allowed).toBe(true)
    expect((await claim(c.id, c.agentId)).allowed).toBe(false)
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
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, ws.id))
    await db.update(vmBoxProvisionAttempts).set({ status: 'failed' }).where(eq(vmBoxProvisionAttempts.id, attempt.id))
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 0 })
  })

  test('concurrent transactions never both consume the last box slot', async () => {
    const a = await stream(),
      b = await stream(),
      c = await stream()
    await db.transaction((tx) =>
      claimHostCapacity(tx, { kind: 'stream', workStreamId: a.id }, resources('squad_shared', pendingStreamBox(a.id)))
    )
    const outcomes = await Promise.all(
      [b, c].map((ws) =>
        db.transaction((tx) =>
          claimHostCapacity(
            tx,
            { kind: 'stream', workStreamId: ws.id },
            resources('squad_shared', pendingStreamBox(ws.id))
          )
        )
      )
    )
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(1)
    expect(await db.transaction((tx) => readHostCapacity(tx, machineId))).toMatchObject({ activeQuotaCpus: 12 })
  })
})

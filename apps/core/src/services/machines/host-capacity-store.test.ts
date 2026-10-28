import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, executions, machines, machineBoxes, squads, workStreams, vmBoxProvisionAttempts } from '../../db'
import { claimHostCapacity, readHostCapacity, pendingStreamBox } from './host-capacity-store'

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

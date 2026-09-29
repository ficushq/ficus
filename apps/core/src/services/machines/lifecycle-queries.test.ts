import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bindMachineBox, deleteMachine, insertMachine, listMachines } from './queries'
import { listAllMachineBoxes, stampBoxesListening } from './lifecycle-queries'

const prefix = `lqtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function machineValues(name: string) {
  return {
    name: `${prefix}-${name}`,
    provider: 'ssh',
    sshHost: '10.0.0.1',
    sshUser: 'ficus',
    sshKeyId: 'secret-key-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    // bindMachineBox rejects non-ready machines (reaper serialization).
    status: 'ready',
  }
}

async function cleanup() {
  for (const m of await listMachines()) {
    if (m.name.startsWith(prefix)) await deleteMachine(m.id)
  }
}

beforeEach(cleanup)
afterEach(cleanup)

describe('listAllMachineBoxes', () => {
  it('returns boxes across all machines in a single query', async () => {
    const machineA = await insertMachine(machineValues('a'))
    const machineB = await insertMachine(machineValues('b'))

    const boxA1 = await bindMachineBox({ sandboxId: `${prefix}-a1`, machineId: machineA.id, unixUser: 'boxa1' })
    const boxA2 = await bindMachineBox({ sandboxId: `${prefix}-a2`, machineId: machineA.id, unixUser: 'boxa2' })
    const boxB1 = await bindMachineBox({ sandboxId: `${prefix}-b1`, machineId: machineB.id, unixUser: 'boxb1' })

    const all = await listAllMachineBoxes()
    const mine = all.filter((b) => b.sandboxId.startsWith(prefix))

    expect(mine.map((b) => b.sandboxId).sort()).toEqual([boxA1.sandboxId, boxA2.sandboxId, boxB1.sandboxId].sort())
    // Boxes from BOTH machines are present (not machine-scoped like listMachineBoxes).
    expect(new Set(mine.map((b) => b.machineId))).toEqual(new Set([machineA.id, machineB.id]))
    // Full box rows are returned.
    const roundTripped = mine.find((b) => b.sandboxId === boxA1.sandboxId)
    expect(roundTripped?.port).toBe(boxA1.port)
    expect(roundTripped?.unixUser).toBe('boxa1')
    expect(roundTripped?.status).toBe('ensuring')
  })

  it('returns an empty list when no boxes exist for our machines', async () => {
    await insertMachine(machineValues('empty'))
    const all = await listAllMachineBoxes()
    expect(all.filter((b) => b.sandboxId.startsWith(prefix))).toEqual([])
  })
})

describe('stampBoxesListening', () => {
  it('stamps every named box in ONE statement and leaves the rest untouched', async () => {
    const machine = await insertMachine(machineValues('stamp'))
    const one = await bindMachineBox({ sandboxId: `${prefix}-s1`, machineId: machine.id, unixUser: 'boxs1' })
    const two = await bindMachineBox({ sandboxId: `${prefix}-s2`, machineId: machine.id, unixUser: 'boxs2' })
    const untouched = await bindMachineBox({ sandboxId: `${prefix}-s3`, machineId: machine.id, unixUser: 'boxs3' })

    const at = new Date('2026-09-01T12:00:00.000Z')
    await stampBoxesListening([one.sandboxId, two.sandboxId], at)

    const byId = new Map((await listAllMachineBoxes()).map((b) => [b.sandboxId, b]))
    expect(byId.get(one.sandboxId)?.lastListeningAt?.toISOString()).toBe(at.toISOString())
    expect(byId.get(two.sandboxId)?.lastListeningAt?.toISOString()).toBe(at.toISOString())
    expect(byId.get(untouched.sandboxId)?.lastListeningAt).toBeNull()
  })

  it('no-ops on empty input rather than issuing an unbounded UPDATE', async () => {
    const machine = await insertMachine(machineValues('empty-stamp'))
    const box = await bindMachineBox({ sandboxId: `${prefix}-s4`, machineId: machine.id, unixUser: 'boxs4' })
    await stampBoxesListening([], new Date())
    const row = (await listAllMachineBoxes()).find((b) => b.sandboxId === box.sandboxId)
    expect(row?.lastListeningAt).toBeNull()
  })
})

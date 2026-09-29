import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { quiesceMachineBoxes, releaseMachineBoxes, type QuiesceRefusal } from './machine-quiesce'
import {
  bindMachineBox,
  deleteMachine,
  fenceBoxForMigration,
  insertMachine,
  isBoxMigrating,
  listMachineBoxes,
} from './queries'

// Every test here drives the REAL fenceBoxForMigration against REAL
// machine_boxes rows, with only the ACTIVITY PROBE faked. That split is
// deliberate: the thing worth protecting is that a machine-wide quiesce claims
// the same `machine_boxes.migrating` fence a box migration claims, under the
// same row lock, with the same exclusivity — none of which a fake fence would
// exercise. Faking only "is this box busy" keeps the tests fast and
// deterministic without faking away the mechanism under test.

const fixtureOwner = crypto.randomUUID()
const ownedMachineIds = new Set<string>()

function fixtureName(name: string) {
  return `quiesce-${fixtureOwner}-${name}`
}

function readyMachineValues(name: string) {
  return {
    name: fixtureName(name),
    provider: 'ssh',
    sshHost: '10.0.0.1',
    sshUser: 'ficus',
    sshKeyId: 'secret-key-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
  }
}

async function cleanup() {
  for (const machineId of [...ownedMachineIds]) {
    await deleteMachine(machineId)
    ownedMachineIds.delete(machineId)
  }
}

beforeEach(cleanup)
afterEach(cleanup)

/** A ready machine carrying `count` bound boxes; returns the machine id and the sandbox ids in bind order. */
async function machineWithBoxes(name: string, count: number) {
  const machine = await insertMachine(readyMachineValues(name))
  ownedMachineIds.add(machine.id)
  const sandboxIds: string[] = []
  for (let i = 0; i < count; i++) {
    const sandboxId = `squad_${fixtureOwner}_${name}_box${i}`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: `u${i}` })
    sandboxIds.push(sandboxId)
  }
  return { machineId: machine.id, sandboxIds }
}

/** An activity probe that reports the named sandbox ids as busy (with a count) and everything else idle. */
function busyProbe(busy: Record<string, number>) {
  return async (sandboxId: string) => {
    const count = busy[sandboxId] ?? 0
    return { active: count > 0, activeExecutionCount: count }
  }
}

function expectExactRefusals(actual: QuiesceRefusal[], expected: QuiesceRefusal[]) {
  expect(actual).toHaveLength(expected.length)
  expect(new Set(actual.map((record) => record.sandboxId)).size).toBe(actual.length)
  expect(
    Object.fromEntries(actual.map(({ sandboxId, activeExecutionCount }) => [sandboxId, { activeExecutionCount }]))
  ).toEqual(
    Object.fromEntries(expected.map(({ sandboxId, activeExecutionCount }) => [sandboxId, { activeExecutionCount }]))
  )
}

const idle = busyProbe({})

describe('quiesceMachineBoxes', () => {
  it('claims the REAL migration fence on every box of the machine', async () => {
    const { machineId, sandboxIds } = await machineWithBoxes('all-idle', 3)

    const result = await quiesceMachineBoxes(machineId, {}, { activity: idle })

    expect(result.refused).toEqual([])
    expect(result.quiesced.slice().sort()).toEqual(sandboxIds.slice().sort())
    // Not merely "the function said so" — the column the execution-pickup path
    // actually consults is set on every one of them.
    for (const sandboxId of sandboxIds) {
      expect(await isBoxMigrating(sandboxId)).toBe(true)
    }
  })

  it('refuses when ANY box is mid-turn, and leaves NOTHING fenced', async () => {
    const { machineId, sandboxIds } = await machineWithBoxes('one-busy', 3)
    // The LAST box is busy, so the first two are fenced before the refusal is
    // discovered — which is exactly the state the all-or-nothing rollback exists
    // to clean up. A fixture where the FIRST box refused would never reach it.
    const result = await quiesceMachineBoxes(machineId, {}, { activity: busyProbe({ [sandboxIds[2]]: 2 }) })

    expect(result.quiesced).toEqual([])
    expect(result.refused).toEqual([{ sandboxId: sandboxIds[2], activeExecutionCount: 2 }])
    // THE assertion: a partial quiesce would leave these two fenced, deferring
    // their turns indefinitely while the caller correctly declines to power the
    // machine off.
    for (const sandboxId of sandboxIds) {
      expect(await isBoxMigrating(sandboxId)).toBe(false)
    }
  })

  it('reports the active execution count for each refusing box', async () => {
    const target = await machineWithBoxes('counts-target', 4)
    const neighbor = await machineWithBoxes('counts-neighbor', 2)
    const expected = [
      { sandboxId: target.sandboxIds[0], activeExecutionCount: 1 },
      { sandboxId: target.sandboxIds[1], activeExecutionCount: 7 },
      { sandboxId: target.sandboxIds[2], activeExecutionCount: 7 },
      { sandboxId: target.sandboxIds[3], activeExecutionCount: 3 },
    ] satisfies QuiesceRefusal[]
    const counts = Object.fromEntries([
      ...expected.map((record) => [record.sandboxId, record.activeExecutionCount] as const),
      [neighbor.sandboxIds[0], 11],
      [neighbor.sandboxIds[1], 13],
    ])

    expect(new Set((await listMachineBoxes(target.machineId)).map((box) => box.sandboxId))).toEqual(
      new Set(target.sandboxIds)
    )
    expect(new Set((await listMachineBoxes(neighbor.machineId)).map((box) => box.sandboxId))).toEqual(
      new Set(neighbor.sandboxIds)
    )
    expect(await fenceBoxForMigration(neighbor.sandboxIds[0], async () => false)).toBe(true)

    const probed: string[] = []
    const activity = busyProbe(counts)
    const result = await quiesceMachineBoxes(
      target.machineId,
      {},
      {
        activity: async (sandboxId) => {
          probed.push(sandboxId)
          return activity(sandboxId)
        },
      }
    )

    expectExactRefusals(result.refused, expected)
    expect(new Set(probed)).toEqual(new Set(target.sandboxIds))
    expect(probed).toHaveLength(target.sandboxIds.length)
    for (const sandboxId of target.sandboxIds) expect(await isBoxMigrating(sandboxId)).toBe(false)
    expect(await isBoxMigrating(neighbor.sandboxIds[0])).toBe(true)
    expect(await isBoxMigrating(neighbor.sandboxIds[1])).toBe(false)
  })

  it('a machine with no boxes quiesces successfully rather than refusing', async () => {
    const machine = await insertMachine(readyMachineValues('empty'))
    ownedMachineIds.add(machine.id)

    const result = await quiesceMachineBoxes(machine.id, {}, { activity: idle })

    // Success is `refused.length === 0`, NOT `quiesced.length > 0` — an empty
    // machine has nothing to fence and nothing to refuse.
    expect(result).toEqual({ quiesced: [], refused: [] })
  })

  it('loses to a fence another migration already holds — and does not steal or clear it', async () => {
    const { machineId, sandboxIds } = await machineWithBoxes('contended', 2)
    // Simulate a concurrent migrateBox owning box 0's fence.
    expect(await fenceBoxForMigration(sandboxIds[0], async () => false)).toBe(true)

    const result = await quiesceMachineBoxes(machineId, {}, { activity: idle })

    expect(result.quiesced).toEqual([])
    expect(result.refused).toEqual([{ sandboxId: sandboxIds[0], activeExecutionCount: null }])
    // The other migration's fence is STILL held — the rollback released only
    // what this call took, never someone else's claim.
    expect(await isBoxMigrating(sandboxIds[0])).toBe(true)
    expect(await isBoxMigrating(sandboxIds[1])).toBe(false)
  })

  describe('force', () => {
    it('bypasses the active-turn refusal and fences the busy box anyway', async () => {
      const { machineId, sandboxIds } = await machineWithBoxes('forced', 2)

      const result = await quiesceMachineBoxes(
        machineId,
        { force: { actor: 'user:op-1', reason: 'evacuating a dying host' } },
        { activity: busyProbe({ [sandboxIds[0]]: 3 }) }
      )

      expect(result.refused).toEqual([])
      expect(result.quiesced.slice().sort()).toEqual(sandboxIds.slice().sort())
      for (const sandboxId of sandboxIds) {
        expect(await isBoxMigrating(sandboxId)).toBe(true)
      }
    })

    it('does NOT bypass a fence another migration holds — force covers active turns only', async () => {
      const { machineId, sandboxIds } = await machineWithBoxes('forced-contended', 2)
      expect(await fenceBoxForMigration(sandboxIds[0], async () => false)).toBe(true)

      const result = await quiesceMachineBoxes(
        machineId,
        { force: { actor: 'user:op-1', reason: 'still not allowed to steal a fence' } },
        { activity: idle }
      )

      // Re-winning another caller's fence would let two teardowns run against
      // one box; `force` deliberately buys nothing here.
      expect(result.refused).toEqual([{ sandboxId: sandboxIds[0], activeExecutionCount: null }])
      expect(await isBoxMigrating(sandboxIds[1])).toBe(false)
    })
  })
})

describe('releaseMachineBoxes', () => {
  it('lifts exactly the fences it is handed, and leaves every other box alone', async () => {
    const { machineId, sandboxIds } = await machineWithBoxes('release', 3)
    await quiesceMachineBoxes(machineId, {}, { activity: idle })
    for (const sandboxId of sandboxIds) expect(await isBoxMigrating(sandboxId)).toBe(true)

    const released = await releaseMachineBoxes([sandboxIds[0], sandboxIds[1]])

    expect(released).toBe(2)
    expect(await isBoxMigrating(sandboxIds[0])).toBe(false)
    expect(await isBoxMigrating(sandboxIds[1])).toBe(false)
    // Not in the list, so not cleared — this is why release takes an explicit
    // list instead of re-deriving "every box on the machine", which could clear
    // a fence a concurrent migrate-box owns.
    expect(await isBoxMigrating(sandboxIds[2])).toBe(true)
  })

  it('is idempotent and never throws for an unknown or already-clear box', async () => {
    const { sandboxIds } = await machineWithBoxes('idempotent', 1)

    await expect(releaseMachineBoxes([sandboxIds[0]])).resolves.toBe(1)
    await expect(releaseMachineBoxes([sandboxIds[0]])).resolves.toBe(1)
    await expect(releaseMachineBoxes(['no-such-box-at-all'])).resolves.toBe(1)
  })

  it('an empty list is a no-op', async () => {
    await expect(releaseMachineBoxes([])).resolves.toBe(0)
  })

  it('keeps going — and reports the successes — when one clear throws', async () => {
    // Called from a `finally`, so one box failing to unfence must not abandon
    // the rest or replace the caller's real error with a cleanup error.
    const released = await releaseMachineBoxes(['a', 'b', 'c'], {
      clearFence: async (sandboxId: string) => {
        if (sandboxId === 'b') throw new Error('connection reset')
      },
    })
    expect(released).toBe(2)
  })
})

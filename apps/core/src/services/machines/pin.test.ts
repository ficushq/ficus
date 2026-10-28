import { describe, expect, it } from 'bun:test'
import { MachinePinError, assertMachinePinReady } from './pin'
import type { Machine } from './queries'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'pin-test',
    status: 'ready',
    ...overrides,
  } as Machine
}

describe('assertMachinePinReady', () => {
  it('accepts null (unpin) without touching the DB', async () => {
    let consulted = false
    await assertMachinePinReady(null, {
      getMachine: async () => {
        consulted = true
        return null
      },
    })
    expect(consulted).toBe(false)
  })

  it('accepts a machine that exists and is ready', async () => {
    const machine = makeMachine({ status: 'ready' })
    await assertMachinePinReady(machine.id, { getMachine: async () => machine })
  })

  it('rejects a non-existent machine with MachinePinError', async () => {
    await expect(assertMachinePinReady('nope', { getMachine: async () => null })).rejects.toThrow(MachinePinError)
  })

  it('rejects a machine that is not ready', async () => {
    const machine = makeMachine({ status: 'bootstrapping' })
    await expect(assertMachinePinReady(machine.id, { getMachine: async () => machine })).rejects.toThrow(/not ready/)
  })
})

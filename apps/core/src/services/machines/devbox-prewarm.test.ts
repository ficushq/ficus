import { afterEach, describe, expect, it } from 'bun:test'
import type { Machine } from './queries'
import type { SeedBoxRole } from './devbox-seed'
import { DEFAULT_PREWARM_ROLES, prewarmMachineDevbox, prewarmMachineDevboxBackground } from './devbox-prewarm'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm-1111',
    name: 'warm-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.9',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: 'secret-key',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    egressPolicy: false,
    bootstrapVersion: null,
    lastError: null,
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

const originalTestMode = process.env.FICUS_TEST_MODE

afterEach(() => {
  if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
  else process.env.FICUS_TEST_MODE = originalTestMode
})

describe('prewarmMachineDevbox', () => {
  it('realizes the devbox once per default role (squad first) on a ready machine', async () => {
    const machine = makeMachine()
    const realized: Array<{ machineId: string; role: SeedBoxRole }> = []

    await prewarmMachineDevbox(machine.id, {
      getMachine: async (id) => (id === machine.id ? machine : null),
      realizeDevbox: async (m, role) => {
        realized.push({ machineId: m.id, role })
      },
    })

    // squad is the common case and must come first; the default set also warms agent.
    expect(realized).toEqual(DEFAULT_PREWARM_ROLES.map((role) => ({ machineId: machine.id, role })))
    expect(realized[0].role).toBe('squad')
  })

  it('honors an explicit role list (e.g. squad only)', async () => {
    const machine = makeMachine()
    const roles: SeedBoxRole[] = []

    await prewarmMachineDevbox(machine.id, {
      getMachine: async () => machine,
      realizeDevbox: async (_m, role) => {
        roles.push(role)
      },
      roles: ['squad'],
    })

    expect(roles).toEqual(['squad'])
  })

  it('is a no-op when the machine is missing', async () => {
    let called = false
    await prewarmMachineDevbox('gone', {
      getMachine: async () => null,
      realizeDevbox: async () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  it('is a no-op when the machine is not ready', async () => {
    let called = false
    await prewarmMachineDevbox('m-1111', {
      getMachine: async () => makeMachine({ status: 'registered' }),
      realizeDevbox: async () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  it('swallows a per-role realize failure and still attempts the remaining roles', async () => {
    const machine = makeMachine()
    const attempted: SeedBoxRole[] = []

    // Must NOT throw even though the first role's realize rejects.
    await prewarmMachineDevbox(machine.id, {
      getMachine: async () => machine,
      roles: ['squad', 'agent'],
      realizeDevbox: async (_m, role) => {
        attempted.push(role)
        if (role === 'squad') throw new Error('boom realizing squad')
      },
    })

    // Both roles were attempted; the squad failure did not abort the loop.
    expect(attempted).toEqual(['squad', 'agent'])
  })
})

describe('prewarmMachineDevboxBackground', () => {
  it('is a no-op under FICUS_TEST_MODE=1 (never touches the machine or realize)', () => {
    process.env.FICUS_TEST_MODE = '1'
    let getMachineCalled = false
    let realizeCalled = false

    prewarmMachineDevboxBackground('m-1111', {
      getMachine: async () => {
        getMachineCalled = true
        return makeMachine()
      },
      realizeDevbox: async () => {
        realizeCalled = true
      },
    })

    expect(getMachineCalled).toBe(false)
    expect(realizeCalled).toBe(false)
  })

  it('fires in the background (returns void immediately) and swallows a rejection', async () => {
    delete process.env.FICUS_TEST_MODE
    const machine = makeMachine()
    let resolveRealize: () => void = () => {}
    const realizeStarted = new Promise<void>((r) => (resolveRealize = r))

    // Returns synchronously (void), not a promise — the work runs detached.
    const ret = prewarmMachineDevboxBackground(machine.id, {
      getMachine: async () => machine,
      roles: ['squad'],
      realizeDevbox: async () => {
        resolveRealize()
        throw new Error('background realize failed')
      },
    })
    expect(ret).toBeUndefined()

    // The detached work eventually runs; the rejection must not surface as an
    // unhandled rejection / thrown error out of the background call.
    await realizeStarted
    await new Promise((r) => setTimeout(r, 0))
  })
})

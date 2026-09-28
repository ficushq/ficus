import { afterEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_MACHINE_UNIT_CAPACITY,
  DEFAULT_UNIT_WEIGHTS,
  DedicatedPlacementUnavailableError,
  MachineProvisioningCapError,
  MachineUnavailableError,
  defaultGetExeProvider,
  defaultProvisionMachine,
  provisionCapped,
  resolveMachineUnitCapacity,
  resolvePlacement,
  unitWeightForRole,
  type DefaultProvisionDeps,
  type PlacementDeps,
  type ProvisionMachineOpts,
} from './placement'
import type { Machine, MachineBox } from './queries'
import type { MachineProvider } from './provider'
import { EXE_PROVIDER_SSH_KEY } from './provider-credentials'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'm-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.5',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: 'secret-key',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: { forwarding: 'yes' },
    scope: 'shared',
    purpose: 'shared',
    squadId: null,
    autoProvisioned: false,
    emptySince: null,
    egressPolicy: false,
    bootstrapVersion: null,
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as Machine
}

function makeBox(overrides: Partial<MachineBox> = {}): MachineBox {
  return {
    sandboxId: 'sb-1',
    machineId: '11111111-1111-1111-1111-111111111111',
    unixUser: 'box_x',
    port: 50100,
    status: 'ready',
    updatedAt: new Date(),
    ...overrides,
  } as MachineBox
}

const fakeExeProvider = { key: 'exe' } as MachineProvider

/**
 * An in-memory machines store so provision → query round-trips exactly as the real
 * DB would: a freshly provisioned shared machine becomes visible to the NEXT
 * placement's load query, which is what proves "provision once, pack after".
 * `boxes` maps machineId → hosted box sandboxIds (the packer's load input).
 */
function makeStore(seed: Machine[] = [], boxes: Record<string, string[]> = {}) {
  const machines = [...seed]
  const provisioned: ProvisionMachineOpts[] = []
  const deps: PlacementDeps = {
    getMachine: async (id) => machines.find((m) => m.id === id) ?? null,
    getMachineBox: async () => null,
    queryReadySharedMachines: async () =>
      machines.filter((m) => m.status === 'ready' && m.scope === 'shared').map((machine) => ({ machine, boxCount: 0 })),
    queryReadyMachineLoads: async () =>
      machines
        .filter((m) => m.status === 'ready' && m.scope === 'shared' && m.purpose === 'shared')
        .map((machine) => ({ machine, boxSandboxIds: boxes[machine.id] ?? [] })),
    countMachines: async () => machines.length,
    getExeProvider: () => fakeExeProvider,
    provisionMachine: async (opts) => {
      provisioned.push(opts)
      const machine = makeMachine({
        id: `prov-${machines.length}`,
        name: opts.name,
        provider: 'exe',
        purpose: opts.purpose,
        squadId: null,
        scope: opts.scope ?? 'shared',
        status: 'ready',
        // Mirror defaultProvisionMachine: an auto-provisioned exe VM's ssh identity
        // is the shared account key, and it carries no per-machine public key.
        sshKeyId: EXE_PROVIDER_SSH_KEY,
        sshPublicKey: '',
      })
      machines.push(machine)
      return machine
    },
  }
  return { deps, machines, provisioned, boxes }
}

afterEach(() => {
  delete process.env.FICUS_MAX_MACHINES
  delete process.env.FICUS_MACHINE_UNIT_CAPACITY
  delete process.env.FICUS_UNIT_WEIGHT_SQUAD
  delete process.env.FICUS_UNIT_WEIGHT_AGENT
  delete process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER
})

// ---------------------------------------------------------------------------
// unit weights + capacity config
// ---------------------------------------------------------------------------

describe('unit weights + machine capacity', () => {
  it('defaults: squad=10, agent=1, system-manager=1, capacity=10 (squad == capacity → VM-exclusive)', () => {
    expect(unitWeightForRole('squad')).toBe(10)
    expect(unitWeightForRole('agent')).toBe(1)
    expect(unitWeightForRole('system-manager')).toBe(1)
    expect(resolveMachineUnitCapacity()).toBe(10)
    expect(DEFAULT_UNIT_WEIGHTS).toEqual({ squad: 10, agent: 1, 'system-manager': 1 })
    expect(DEFAULT_MACHINE_UNIT_CAPACITY).toBe(10)
    // The out-of-box policy: a squad fills a whole VM, agents/sys-managers pack 10/VM.
    expect(DEFAULT_UNIT_WEIGHTS.squad).toBe(DEFAULT_MACHINE_UNIT_CAPACITY)
  })

  it('honors positive-integer env overrides', () => {
    process.env.FICUS_UNIT_WEIGHT_SQUAD = '5'
    process.env.FICUS_UNIT_WEIGHT_AGENT = '2'
    process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER = '4'
    process.env.FICUS_MACHINE_UNIT_CAPACITY = '24'
    expect(unitWeightForRole('squad')).toBe(5)
    expect(unitWeightForRole('agent')).toBe(2)
    expect(unitWeightForRole('system-manager')).toBe(4)
    expect(resolveMachineUnitCapacity()).toBe(24)
  })

  it('falls back to defaults on invalid or non-positive overrides', () => {
    process.env.FICUS_UNIT_WEIGHT_SQUAD = '0'
    process.env.FICUS_UNIT_WEIGHT_AGENT = '-2'
    process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER = 'lots'
    process.env.FICUS_MACHINE_UNIT_CAPACITY = '1.5'
    expect(unitWeightForRole('squad')).toBe(10)
    expect(unitWeightForRole('agent')).toBe(1)
    expect(unitWeightForRole('system-manager')).toBe(1)
    expect(resolveMachineUnitCapacity()).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// explicit pin
// ---------------------------------------------------------------------------

describe('resolvePlacement — explicit pin', () => {
  it('returns an explicit machine when it exists and is ready', async () => {
    const machine = makeMachine({ status: 'ready' })
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'agent', explicitMachineId: machine.id },
      { getMachine: async () => machine, getExeProvider: () => null }
    )
    expect(resolved.id).toBe(machine.id)
  })

  it('throws MachineUnavailableError for an explicit machine that is missing', async () => {
    await expect(
      resolvePlacement(
        { sandboxId: 'sb-1', role: 'agent', explicitMachineId: 'nope' },
        { getMachine: async () => null, getExeProvider: () => null }
      )
    ).rejects.toThrow(MachineUnavailableError)
  })

  it('throws MachineUnavailableError for an explicit machine that is not ready', async () => {
    const machine = makeMachine({ status: 'bootstrapping' })
    await expect(
      resolvePlacement(
        { sandboxId: 'sb-1', role: 'agent', explicitMachineId: machine.id },
        { getMachine: async () => machine, getExeProvider: () => null }
      )
    ).rejects.toThrow(/not ready/)
  })

  it('honors the explicit pin even when the exe provider is available (never provisions)', async () => {
    const machine = makeMachine({ status: 'ready' })
    const { deps, provisioned } = makeStore([machine])
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'squad', squadId: 'sq-1', explicitMachineId: machine.id },
      deps
    )
    expect(resolved.id).toBe(machine.id)
    expect(provisioned).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sticky existing box (slice-2 rule)
// ---------------------------------------------------------------------------

describe('resolvePlacement — sticky existing box', () => {
  it('returns the recorded ready machine for an existing box, never re-placing', async () => {
    const machineA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'ready' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const box = makeBox({ machineId: machineA.id, status: 'ready' })
    let placementConsulted = false
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'agent' },
      {
        getMachineBox: async () => box,
        getMachine: async (id) => (id === machineA.id ? machineA : machineB),
        getExeProvider: () => null,
        queryReadySharedMachines: async () => {
          placementConsulted = true
          return [{ machine: machineB, boxCount: 0 }]
        },
      }
    )
    expect(resolved.id).toBe(machineA.id)
    expect(placementConsulted).toBe(false)
  })

  it('does NOT stick when the recorded machine is not ready (falls through to placement)', async () => {
    const notReady = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'unreachable' })
    const ready = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready', scope: 'shared' })
    const box = makeBox({ machineId: notReady.id, status: 'ready' })
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'agent' },
      {
        getMachineBox: async () => box,
        getMachine: async (id) => (id === notReady.id ? notReady : ready),
        getExeProvider: () => null,
        queryReadySharedMachines: async () => [{ machine: ready, boxCount: 0 }],
      }
    )
    expect(resolved.id).toBe(ready.id)
  })
})

// ---------------------------------------------------------------------------
// packed shared pool (best-fit unit packer)
// ---------------------------------------------------------------------------

describe('resolvePlacement — packed shared pool', () => {
  it('best-fit packs onto the fullest ready shared machine that still fits', async () => {
    // Default capacity 10. Frees: mA = 10-8 = 2, mB = 10-5 = 5, mC = 10-2 = 8.
    // Incoming agent weighs 1 → all fit; best fit (smallest free) = mA.
    const mA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-a' })
    const mB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'm-b' })
    const mC = makeMachine({ id: 'cccccccc-0000-0000-0000-000000000000', name: 'm-c' })
    const { deps, provisioned } = makeStore([mA, mB, mC], {
      [mA.id]: ['agent_a', 'agent_b', 'agent_c', 'agent_d', 'agent_e', 'agent_f', 'agent_g', 'agent_h'], // 8
      [mB.id]: ['agent_i', 'agent_j', 'agent_k', 'agent_l', 'agent_m'], // 5
      [mC.id]: ['agent_n', 'agent_o'], // 2
    })
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, deps)
    expect(resolved.id).toBe(mA.id)
    expect(provisioned).toEqual([])
  })

  it('sums mixed box roles by weight (agent_ + system_manager_ prefixes)', async () => {
    // mLoaded hosts an agent + a system-manager: 1+1 = 2 used → free 8. mEmpty is
    // free 10. An incoming agent (1) fits both; best fit is the fuller mLoaded.
    const mLoaded = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-loaded' })
    const mEmpty = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'm-empty' })
    const { deps } = makeStore([mLoaded, mEmpty], {
      [mLoaded.id]: ['agent_y', 'system_manager_z'],
    })
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, deps)
    expect(resolved.id).toBe(mLoaded.id)
  })

  it('packs onto a machine whose free capacity EXACTLY equals the incoming weight (fit is free >= incoming)', async () => {
    // Capacity 10, nine agent boxes → free 1 == incoming agent weight 1. The box
    // must pack THERE with no provision: an exclusive `free > incoming` boundary
    // would wrongly spin up a fresh VM for a box that fits exactly.
    const m = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-exact' })
    const { deps, provisioned } = makeStore([m], {
      [m.id]: ['agent_a', 'agent_b', 'agent_c', 'agent_d', 'agent_e', 'agent_f', 'agent_g', 'agent_h', 'agent_i'], // 9
    })
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, deps)
    expect(resolved.id).toBe(m.id)
    expect(provisioned).toEqual([])
  })

  it('packs a squad onto an EMPTY machine (free == capacity == squad weight, the exact-fit edge)', async () => {
    // Squad weight (10) == capacity (10): an empty ready VM has free 10 == incoming,
    // so the squad lands there and provisions nothing. This is the same >= boundary
    // as above at the squad-exclusive scale.
    const empty = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-empty' })
    const { deps, provisioned } = makeStore([empty])
    const resolved = await resolvePlacement({ sandboxId: 'squad_new', role: 'squad', squadId: 'sq-new' }, deps)
    expect(resolved.id).toBe(empty.id)
    expect(provisioned).toEqual([])
  })

  it('never packs anything onto a squad-occupied machine (squad weight == capacity → free 0)', async () => {
    // A VM hosting one squad box has free 0 — not even a weight-1 agent fits, so
    // squads are effectively VM-exclusive under the default weights.
    const squadVm = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-squad' })
    const other = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'm-other' })
    const { deps, provisioned } = makeStore([squadVm, other], {
      [squadVm.id]: ['squad_x'], // 10 used → free 0
    })
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, deps)
    expect(resolved.id).toBe(other.id)
    expect(provisioned).toEqual([])
  })

  it('skips an over-subscribed machine (used > capacity → negative free) and picks one with room', async () => {
    // `over` carries a squad + an agent (10+1 = 11) against capacity 10 — e.g.
    // after a FICUS_MACHINE_UNIT_CAPACITY drop — so its free is NEGATIVE (-1). It
    // must be ineligible: without the free >= incoming filter, best-fit's
    // smallest-free sort would rank it FIRST for the incoming agent. The roomy
    // machine wins and nothing is provisioned.
    const over = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'm-over' })
    const roomy = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'm-roomy' })
    const { deps, provisioned } = makeStore([over, roomy], {
      [over.id]: ['squad_a', 'agent_b'], // 10+1 = 11 used → free -1
      [roomy.id]: ['agent_c'], // 1 used → free 9
    })
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, deps)
    expect(resolved.id).toBe(roomy.id)
    expect(provisioned).toEqual([])
  })

  it('breaks free-capacity ties deterministically by (createdAt, id)', async () => {
    const older = makeMachine({
      id: 'bbbbbbbb-0000-0000-0000-000000000000',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    })
    const newer = makeMachine({
      id: 'aaaaaaaa-0000-0000-0000-000000000000',
      createdAt: new Date('2021-01-01T00:00:00Z'),
    })
    const byCreated = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, makeStore([newer, older]).deps)
    expect(byCreated.id).toBe(older.id)

    const twinA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const twinB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000' })
    const byId = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent' }, makeStore([twinB, twinA]).deps)
    expect(byId.id).toBe(twinA.id)
  })

  it('provisions a fresh shared VM with a unique exe-<8hex> name when nothing fits', async () => {
    // One machine at used 1 → free 9 < incoming squad weight 10, so nothing fits.
    const full = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const { deps, provisioned, boxes } = makeStore([full], {
      [full.id]: ['agent_a'], // 1 used → free 9 < incoming squad weight 10
    })
    const resolved = await resolvePlacement({ sandboxId: 'squad_new', role: 'squad', squadId: 'sq-new' }, deps)
    expect(resolved.purpose).toBe('shared')
    expect(resolved.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)
    expect(provisioned).toHaveLength(1)
    expect(provisioned[0]).toMatchObject({ purpose: 'shared', scope: 'shared' })
    expect(provisioned[0]).not.toHaveProperty('squadId')
    expect(provisioned[0].name).toMatch(/^exe-[0-9a-f]{8}$/)

    // The fresh VM joins the packed pool: while it has room (still empty in the
    // store), the next squad reuses it (exact fit: free 10 == weight 10).
    const packed = await resolvePlacement({ sandboxId: 'squad_next', role: 'squad', squadId: 'sq-next' }, deps)
    expect(packed.id).toBe(resolved.id)
    expect(provisioned).toHaveLength(1)

    // Once it too fills up, the next overflow provisions under a DIFFERENT unique
    // name (random, not keyed to any identity).
    boxes[resolved.id] = ['squad_next'] // 10 used → free 0
    const again = await resolvePlacement({ sandboxId: 'squad_new2', role: 'squad', squadId: 'sq-new2' }, deps)
    expect(again.id).not.toBe(resolved.id)
    expect(provisioned).toHaveLength(2)
    expect(provisioned[1].name).toMatch(/^exe-[0-9a-f]{8}$/)
    expect(provisioned[1].name).not.toBe(provisioned[0].name)
  })

  it('packs agent + system-manager boxes onto ONE shared VM; a squad gets a VM of its own', async () => {
    const { deps, provisioned, machines, boxes } = makeStore()

    const agent = await resolvePlacement({ sandboxId: 'agent_a1', role: 'agent', squadId: 's1' }, deps)
    expect(agent.purpose).toBe('shared')
    boxes[agent.id] = ['agent_a1']

    const sysmgr = await resolvePlacement({ sandboxId: 'system_manager_u1', role: 'system-manager' }, deps)
    expect(sysmgr.id).toBe(agent.id)
    boxes[agent.id].push('system_manager_u1')

    expect(provisioned).toHaveLength(1)
    expect(machines).toHaveLength(1)

    // A squad (weight 10) no longer fits next to them (free 8) → its own fresh VM.
    const squad = await resolvePlacement({ sandboxId: 'squad_s1', role: 'squad', squadId: 's1' }, deps)
    expect(squad.id).not.toBe(agent.id)
    expect(squad.purpose).toBe('shared')
    expect(provisioned).toHaveLength(2)
    expect(machines).toHaveLength(2)
  })

  it('does NOT route an agent-with-squadId to its squad-keyed legacy VM', async () => {
    // A legacy squad-purpose VM for sq-1 exists and is ready, plus one packed
    // shared VM with room. The agent scoped to sq-1 must land on the shared VM:
    // purpose='squad' machines are invisible to the packer (they drain naturally).
    const legacySquadVm = makeMachine({
      id: 'aaaaaaaa-0000-0000-0000-000000000000',
      purpose: 'squad',
      squadId: 'sq-1',
    })
    const sharedVm = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000' })
    const { deps, provisioned } = makeStore([legacySquadVm, sharedVm])
    const resolved = await resolvePlacement({ sandboxId: 'agent_a1', role: 'agent', squadId: 'sq-1' }, deps)
    expect(resolved.id).toBe(sharedVm.id)
    expect(provisioned).toEqual([])
  })

  it('ignores legacy commons VMs too (purpose != shared)', async () => {
    const legacyCommons = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', purpose: 'commons' })
    const { deps, provisioned } = makeStore([legacyCommons])
    const resolved = await resolvePlacement({ sandboxId: 'agent_solo', role: 'agent' }, deps)
    expect(resolved.id).not.toBe(legacyCommons.id)
    expect(resolved.purpose).toBe('shared')
    expect(provisioned).toHaveLength(1)
  })

  it('gives an over-capacity box (weight > capacity) its own fresh shared VM', async () => {
    process.env.FICUS_MACHINE_UNIT_CAPACITY = '2'
    // An EMPTY shared machine exists (free 2) but a squad box weighs 10 → it can
    // never fit anywhere; provision a fresh VM for it rather than looping.
    const empty = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const { deps, provisioned } = makeStore([empty])
    const resolved = await resolvePlacement({ sandboxId: 'squad_big', role: 'squad', squadId: 'sq-big' }, deps)
    expect(resolved.id).not.toBe(empty.id)
    expect(resolved.purpose).toBe('shared')
    expect(provisioned).toHaveLength(1)
  })

  it('sticky short-circuits before packing (load query never consulted)', async () => {
    const recorded = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const box = makeBox({ machineId: recorded.id })
    let loadsConsulted = false
    const resolved = await resolvePlacement(
      { sandboxId: 'agent_sticky', role: 'agent' },
      {
        getMachineBox: async () => box,
        getMachine: async () => recorded,
        getExeProvider: () => fakeExeProvider,
        queryReadyMachineLoads: async () => {
          loadsConsulted = true
          return []
        },
      }
    )
    expect(resolved.id).toBe(recorded.id)
    expect(loadsConsulted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// dedicated
// ---------------------------------------------------------------------------

describe('resolvePlacement — dedicated', () => {
  it('provisions its own dedicated machine when exe is available', async () => {
    const { deps, provisioned } = makeStore()
    const resolved = await resolvePlacement(
      { sandboxId: 'agent_ded', role: 'agent', squadId: 'sq-1', dedicated: true },
      deps
    )
    expect(resolved.purpose).toBe('dedicated')
    expect(resolved.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)
    expect(provisioned[0]).toMatchObject({ purpose: 'dedicated', scope: 'dedicated' })
  })

  it('throws DedicatedPlacementUnavailableError when no cloud provider is available', async () => {
    await expect(
      resolvePlacement({ sandboxId: 'agent_ded', role: 'agent', dedicated: true }, { getExeProvider: () => null })
    ).rejects.toThrow(DedicatedPlacementUnavailableError)
  })

  it('the dedicated error carries the documented message', async () => {
    await expect(
      resolvePlacement({ sandboxId: 'agent_ded', role: 'agent', dedicated: true }, { getExeProvider: () => null })
    ).rejects.toThrow('dedicated placement requires a cloud provider')
  })
})

// ---------------------------------------------------------------------------
// BYO-only (no exe provider) — byte-identical to legacy least-loaded
// ---------------------------------------------------------------------------

describe('resolvePlacement — BYO-only (no exe provider)', () => {
  it('throws the documented error when no shared machine is ready', async () => {
    await expect(
      resolvePlacement(
        { sandboxId: 'sb-1', role: 'agent' },
        { getExeProvider: () => null, getMachineBox: async () => null, queryReadySharedMachines: async () => [] }
      )
    ).rejects.toThrow('no ready shared machine registered')
  })

  it('returns the sole ready shared machine', async () => {
    const machine = makeMachine()
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'agent' },
      {
        getExeProvider: () => null,
        getMachineBox: async () => null,
        queryReadySharedMachines: async () => [{ machine, boxCount: 3 }],
      }
    )
    expect(resolved.id).toBe(machine.id)
  })

  it('picks the least-loaded machine when several are ready', async () => {
    const busy = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const idle = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000' })
    const resolved = await resolvePlacement(
      { sandboxId: 'sb-1', role: 'agent' },
      {
        getExeProvider: () => null,
        getMachineBox: async () => null,
        queryReadySharedMachines: async () => [
          { machine: busy, boxCount: 5 },
          { machine: idle, boxCount: 1 },
        ],
      }
    )
    expect(resolved.id).toBe(idle.id)
  })

  it('never provisions even for a squad box when exe is unavailable', async () => {
    const machine = makeMachine()
    let provisioned = false
    const resolved = await resolvePlacement(
      { sandboxId: 'squad_x', role: 'squad', squadId: 'sq-1' },
      {
        getExeProvider: () => null,
        getMachineBox: async () => null,
        queryReadySharedMachines: async () => [{ machine, boxCount: 0 }],
        provisionMachine: async () => {
          provisioned = true
          return machine
        },
      }
    )
    expect(resolved.id).toBe(machine.id)
    expect(provisioned).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// provisioning cap
// ---------------------------------------------------------------------------

describe('resolvePlacement — provisioning cap', () => {
  it('refuses to provision past FICUS_MAX_MACHINES with a structured error', async () => {
    process.env.FICUS_MAX_MACHINES = '2'
    // Two legacy squad-keyed VMs fill the fleet; the packer cannot see them
    // (purpose != 'shared'), so the new box needs a provision the cap refuses.
    const seed = [
      makeMachine({ id: 'm-0', purpose: 'squad', squadId: 'other-a' }),
      makeMachine({ id: 'm-1', purpose: 'squad', squadId: 'other-b' }),
    ]
    const { deps, provisioned } = makeStore(seed)
    await expect(resolvePlacement({ sandboxId: 'agent_new', role: 'agent', squadId: 'sq-new' }, deps)).rejects.toThrow(
      MachineProvisioningCapError
    )
    expect(provisioned).toEqual([])
  })

  it('provisions right up to the cap', async () => {
    process.env.FICUS_MAX_MACHINES = '2'
    const seed = [makeMachine({ id: 'm-0', purpose: 'squad', squadId: 'other-a' })]
    const { deps, provisioned } = makeStore(seed)
    const resolved = await resolvePlacement({ sandboxId: 'agent_new', role: 'agent', squadId: 'sq-new' }, deps)
    expect(resolved.purpose).toBe('shared')
    expect(provisioned).toHaveLength(1)
  })

  it('reusing an existing shared machine with room is not blocked by the cap', async () => {
    process.env.FICUS_MAX_MACHINES = '1'
    const seed = [makeMachine({ id: 'm-0' })]
    const { deps, provisioned } = makeStore(seed)
    const resolved = await resolvePlacement({ sandboxId: 'agent_solo', role: 'agent' }, deps)
    expect(resolved.id).toBe('m-0')
    expect(provisioned).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// provisionCapped — concurrent same-name provision dedupe (spec §4)
// ---------------------------------------------------------------------------

/** A Postgres-js unique-violation, as `machines.name`'s UNIQUE index throws it
 *  through the real driver (SQLSTATE 23505, constraint machines_name_unique). */
function uniqueNameViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "machines_name_unique"'), {
    code: '23505',
    constraint_name: 'machines_name_unique',
  })
}

describe('provisionCapped — concurrent same-name dedupe', () => {
  it('dedupes concurrent same-name provisions to ONE provider call; both callers get the same row', async () => {
    let provisionCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const row = makeMachine({ id: 'winner', name: 'exe-ded-agent_race1' })
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      provisionMachine: async () => {
        provisionCalls += 1
        await gate
        return row
      },
    }
    const opts = { name: 'exe-ded-agent_race1', purpose: 'dedicated' as const, scope: 'dedicated' as const }
    const p1 = provisionCapped(deps, opts)
    const p2 = provisionCapped(deps, opts)
    release()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(provisionCalls).toBe(1)
    expect(r1).toBe(row)
    expect(r2).toBe(row)
  })

  it('does NOT dedupe different names — the random packed pool over-provisions by design', async () => {
    let provisionCalls = 0
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      provisionMachine: async (o) => {
        provisionCalls += 1
        await Promise.resolve()
        return makeMachine({ name: o.name })
      },
    }
    await Promise.all([
      provisionCapped(deps, { name: 'exe-aaaaaaaa', purpose: 'shared', scope: 'shared' }),
      provisionCapped(deps, { name: 'exe-bbbbbbbb', purpose: 'shared', scope: 'shared' }),
    ])
    expect(provisionCalls).toBe(2)
  })

  it('adopts the winner row on a unique-name violation instead of throwing', async () => {
    let provisionCalls = 0
    const winner = makeMachine({ id: 'adopted', name: 'exe-ded-agent_race3', status: 'ready' })
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      getMachineByName: async (name) => (name === 'exe-ded-agent_race3' ? winner : null),
      provisionMachine: async () => {
        provisionCalls += 1
        throw uniqueNameViolation()
      },
    }
    const result = await provisionCapped(deps, {
      name: 'exe-ded-agent_race3',
      purpose: 'dedicated',
      scope: 'dedicated',
    })
    expect(provisionCalls).toBe(1)
    expect(result).toBe(winner)
  })

  it('retries ONCE from scratch when the race winner vanished (its row was deleted by cleanup)', async () => {
    let provisionCalls = 0
    const finalRow = makeMachine({ id: 'retry-win', name: 'exe-ded-agent_race4' })
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      getMachineByName: async () => null, // winner's provision failed; its row is gone
      provisionMachine: async () => {
        provisionCalls += 1
        if (provisionCalls === 1) throw uniqueNameViolation()
        return finalRow
      },
    }
    const result = await provisionCapped(deps, {
      name: 'exe-ded-agent_race4',
      purpose: 'dedicated',
      scope: 'dedicated',
    })
    expect(provisionCalls).toBe(2)
    expect(result).toBe(finalRow)
  })

  it('rethrows after a single failed retry (winner keeps vanishing)', async () => {
    let provisionCalls = 0
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      getMachineByName: async () => null,
      provisionMachine: async () => {
        provisionCalls += 1
        throw uniqueNameViolation()
      },
    }
    await expect(
      provisionCapped(deps, { name: 'exe-ded-agent_race5', purpose: 'dedicated', scope: 'dedicated' })
    ).rejects.toThrow('machines_name_unique')
    expect(provisionCalls).toBe(2)
  })

  it('propagates a non-unique provision error unchanged — no adopt, no retry', async () => {
    let provisionCalls = 0
    let getByNameCalls = 0
    const deps: PlacementDeps = {
      countMachines: async () => 0,
      maxMachines: 50,
      getMachineByName: async () => {
        getByNameCalls += 1
        return null
      },
      provisionMachine: async () => {
        provisionCalls += 1
        throw new Error('provider boom')
      },
    }
    await expect(
      provisionCapped(deps, { name: 'exe-ded-agent_race6', purpose: 'dedicated', scope: 'dedicated' })
    ).rejects.toThrow('provider boom')
    expect(provisionCalls).toBe(1)
    expect(getByNameCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// defaultProvisionMachine — failed-provision cleanup (no leaked/paid VM)
// ---------------------------------------------------------------------------

describe('defaultProvisionMachine — exe account-key model', () => {
  function provisionProvider(overrides: Partial<MachineProvider> = {}): MachineProvider {
    return {
      key: 'exe',
      provision: async () => ({ sshHost: 'vm.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-ref' }),
      terminate: async () => {},
      status: async () => 'running',
      ...overrides,
    }
  }

  it('inserts the row with the shared account key as its ssh identity (no per-machine keypair)', async () => {
    let insertValues: Parameters<DefaultProvisionDeps['insertMachine']>[0] | undefined
    let insertedRow: Machine | undefined
    const provider = provisionProvider({
      provision: async () => ({ sshHost: 'vm.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-ok' }),
    })

    const result = await defaultProvisionMachine(
      { name: 'exe-0a1b2c3d', purpose: 'shared', scope: 'shared' },
      {
        getProvider: () => provider,
        insertMachine: async (v) => {
          insertValues = v
          insertedRow = makeMachine({ id: v.id, name: v.name, provider: 'exe', status: 'registered' })
          return insertedRow
        },
        bootstrapMachine: async () => ({}),
        getMachine: async () => makeMachine({ id: insertedRow!.id, status: 'ready', provider: 'exe' }),
        deleteMachine: async () => {},
      }
    )

    expect(result.status).toBe('ready')
    // The row references the SHARED account-key secret; exe mints no per-machine key,
    // so the public-key column is empty and sshUser comes from the provider result.
    expect(insertValues?.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)
    expect(insertValues?.sshPublicKey).toBe('')
    expect(insertValues?.sshUser).toBe('exedev')
    expect(insertValues?.provider).toBe('exe')
    expect(insertValues?.providerRef).toBe('vm-ok')
    // Marked tau-created: this is the empty-machine reaper's eligibility signal —
    // user-registered exe VMs (POST /api/machines) never set it.
    expect(insertValues?.autoProvisioned).toBe(true)
  })

  it('terminates the billed VM and deletes the row when bootstrap fails, then rethrows — dropping no secret', async () => {
    let terminatedRef: string | null | undefined
    const deleted: string[] = []
    let insertedRow: Machine | undefined
    const provider = provisionProvider({
      provision: async () => ({ sshHost: 'vm.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-boot' }),
      terminate: async (m) => {
        terminatedRef = m.providerRef
      },
    })

    await expect(
      defaultProvisionMachine(
        { name: 'exe-0a1b2c3d', purpose: 'shared', scope: 'shared' },
        {
          getProvider: () => provider,
          insertMachine: async (v) => {
            insertedRow = makeMachine({ id: v.id, name: v.name, provider: 'exe', providerRef: v.providerRef ?? null })
            return insertedRow
          },
          bootstrapMachine: async () => {
            throw new Error('bootstrap ssh failed')
          },
          getMachine: async () => insertedRow ?? null,
          deleteMachine: async (id) => {
            deleted.push(id)
          },
        }
      )
    ).rejects.toThrow('bootstrap ssh failed')

    expect(terminatedRef).toBe('vm-boot')
    expect(deleted).toEqual([insertedRow!.id])
    // Exe machines share EXE_PROVIDER_SSH_KEY (every VM references it); the cleanup
    // must never delete it, and there is no per-machine secret to drop.
  })

  it('terminates the billed VM when the row insert fails after provision (no row to delete, no secret to drop)', async () => {
    let terminatedRef: string | null | undefined
    const deleted: string[] = []
    const provider = provisionProvider({
      provision: async () => ({ sshHost: 'vm.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-ins' }),
      terminate: async (m) => {
        terminatedRef = m.providerRef
      },
    })

    await expect(
      defaultProvisionMachine(
        { name: 'exe-4e5f6071', purpose: 'shared', scope: 'shared' },
        {
          getProvider: () => provider,
          insertMachine: async () => {
            throw new Error('db insert failed')
          },
          bootstrapMachine: async () => ({}),
          getMachine: async () => null,
          deleteMachine: async (id) => {
            deleted.push(id)
          },
        }
      )
    ).rejects.toThrow('db insert failed')

    expect(terminatedRef).toBe('vm-ins')
    expect(deleted).toEqual([])
  })

  it('returns the ready machine on the happy path without terminating', async () => {
    let terminateCalls = 0
    let insertedRow: Machine | undefined
    const provider = provisionProvider({
      terminate: async () => {
        terminateCalls += 1
      },
    })

    const result = await defaultProvisionMachine(
      { name: 'exe-ded-agent_x', purpose: 'dedicated', scope: 'dedicated' },
      {
        getProvider: () => provider,
        insertMachine: async (v) => {
          insertedRow = makeMachine({ id: v.id, name: v.name, provider: 'exe', status: 'registered' })
          return insertedRow
        },
        bootstrapMachine: async () => ({}),
        getMachine: async () => makeMachine({ id: insertedRow!.id, status: 'ready', provider: 'exe' }),
        deleteMachine: async () => {},
      }
    )

    expect(result.status).toBe('ready')
    expect(terminateCalls).toBe(0)
  })
})

describe('defaultGetExeProvider — self-heal', () => {
  it('re-registers the built-in providers at point-of-use before resolving exe', async () => {
    // The registry is the one machine-config surface snapshotted into module
    // state, so placement re-registers on every lookup — this is what lets an
    // exe key configured AFTER boot get picked up without a restart. Assert the
    // (injected) registration runs; a null return is fine (no exe registered in
    // this unit context — the point is that registration was attempted).
    let registered = 0
    await defaultGetExeProvider(async () => {
      registered++
    })
    expect(registered).toBe(1)
  })

  it('still resolves (best-effort) when re-registration throws', async () => {
    const provider = await defaultGetExeProvider(async () => {
      throw new Error('secret store not ready')
    })
    // Swallows the registration error and falls back to the current registry
    // (null here — no exe registered), never throwing out of placement.
    expect(provider).toBeNull()
  })
})

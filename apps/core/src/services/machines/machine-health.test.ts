import { describe, expect, it, spyOn } from 'bun:test'
import type { AgentStatus } from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { boxUnixUser } from './box-paths'
import {
  isOwnerTerminated,
  listMachineBoxUsers,
  parseDfOutput,
  probeMachineHealth,
  reconcileOrphanedBoxes,
  sampleMachineDiskUsage,
  sweepMachineHealth,
  sweepMachineRemnants,
} from './machine-health'
import { DISK_SAMPLE_PATH } from './machine-metrics-sample'
import type { MachineProvider } from './provider'
import { unverifiedStopRemnantId, type Machine, type MachineBox } from './queries'
import type { SshResult, SshRunner } from './ssh'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'box-test',
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
    sandboxId: 'agent_a1',
    machineId: '11111111-1111-1111-1111-111111111111',
    unixUser: 'box_deadbeef',
    port: 50100,
    status: 'ready',
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as MachineBox
}

/** A provider whose `status()` returns a fixed verdict. */
function fakeProvider(status: 'running' | 'parked' | 'gone'): MachineProvider {
  return {
    key: 'ssh',
    provision: async () => {
      throw new Error('unused')
    },
    terminate: async () => {},
    status: async () => status,
  }
}

interface UpdateCall {
  id: string
  updates: { lastSeenAt?: Date | null; status?: string; lastError?: string | null }
}

/** Records `updateMachine` calls and returns the merged row. */
function recordingUpdate(store: Machine) {
  const calls: UpdateCall[] = []
  const fn = async (id: string, updates: Partial<typeof store>) => {
    calls.push({ id, updates: updates as UpdateCall['updates'] })
    Object.assign(store, updates)
    return store
  }
  return { calls, fn }
}

const NOW = new Date('2026-07-13T12:00:00Z')
const now = () => NOW

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run `fn` with FICUS_MACHINE_PROBE_CONCURRENCY set to `value` (or unset), restored after. */
async function withProbeConcurrency(value: string | undefined, fn: () => Promise<void>) {
  const key = 'FICUS_MACHINE_PROBE_CONCURRENCY'
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

/**
 * Sweep deps whose probe blocks ~10ms in `checkHealth` (so overlap is
 * observable) while tracking the concurrent-in-flight high-water mark and the
 * set of machine ids that reached `updateMachine`. `sweepRemnants` is a no-op so
 * an unreachable→ready recovery never reaches real SSH.
 */
function concurrencyTrackingDeps(machines: Machine[]) {
  let active = 0
  let peak = 0
  const probed: string[] = []
  return {
    get peak() {
      return peak
    },
    probed,
    deps: {
      listMachines: async () => machines,
      tunnels: {
        checkHealth: async () => {
          active++
          peak = Math.max(peak, active)
          await delay(10)
          active--
          return true
        },
      },
      updateMachine: (async (id: string, updates: any) => {
        probed.push(id)
        return { ...machines[0], ...updates }
      }) as any,
      sweepRemnants: async () => {},
      now,
    } satisfies Parameters<typeof sweepMachineHealth>[0],
  }
}

// ---------------------------------------------------------------------------
// probeMachineHealth
// ---------------------------------------------------------------------------

describe('probeMachineHealth', () => {
  it('flips a ready machine to unreachable WITHOUT stamping lastSeenAt when the provider says gone', async () => {
    const machine = makeMachine({ status: 'ready' })
    const upd = recordingUpdate(machine)

    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('gone'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('unreachable')
    expect(upd.calls).toHaveLength(1)
    // `lastSeenAt` is a liveness watermark: only bumped on genuine contact, so an
    // unreachable flip must NOT touch it (mirrors the POST /:id/check route).
    // `lastError` IS stamped on this branch (mirrors the POST /:id/check route).
    expect(upd.calls[0].updates.status).toBe('unreachable')
    expect(upd.calls[0].updates.lastSeenAt).toBeUndefined()
    expect(upd.calls[0].updates.lastError).toBeString()
  })

  it('clears a stale lastError when a probe recovers a machine to ready (mirrors POST /:id/check)', async () => {
    // Reproduces the reviewer's finding: a machine unreachable with a bootstrap-
    // era lastError, repaired without a re-bootstrap. The next automatic sweep
    // tick must clear the stale error along with the status flip — otherwise a
    // LATER unrelated blip would keep blaming the old bootstrap failure.
    const machine = makeMachine({ status: 'unreachable', lastError: 'bootstrap.sh failed on x: disk full' })
    const upd = recordingUpdate(machine)

    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('running'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('ready')
    expect(upd.calls[0].updates.status).toBe('ready')
    expect(upd.calls[0].updates.lastError).toBeNull()
  })

  it('stamps a probe-sourced lastError (not the stale bootstrap message) when a ready machine goes unreachable', async () => {
    const machine = makeMachine({ status: 'ready', lastError: null })
    const upd = recordingUpdate(machine)

    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('gone'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('unreachable')
    expect(upd.calls[0].updates.lastError).toBeString()
    expect(upd.calls[0].updates.lastError).not.toContain('bootstrap')
  })

  it('writes a byte-identical lastError across repeat identical failing probes (no spurious event)', async () => {
    const machine = makeMachine({ status: 'unreachable', lastError: null })
    const upd = recordingUpdate(machine)

    await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('gone'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })
    const first = upd.calls[0].updates.lastError

    // Second probe on the still-unreachable machine, same failure signal.
    const machine2 = makeMachine({ status: 'unreachable', lastError: first ?? null })
    const upd2 = recordingUpdate(machine2)
    await probeMachineHealth(machine2, {
      getProvider: () => fakeProvider('gone'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd2.fn as any,
      now,
    })
    const second = upd2.calls[0].updates.lastError

    expect(second).toBe(first)
  })

  it('reports ready when the provider says running', async () => {
    const machine = makeMachine({ status: 'ready' })
    const upd = recordingUpdate(machine)

    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('running'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('ready')
    expect(upd.calls[0].updates.status).toBe('ready')
    expect(upd.calls[0].updates.lastSeenAt).toBe(NOW)
  })

  it('recovers an unreachable machine back to ready when the provider says running', async () => {
    const machine = makeMachine({ status: 'unreachable' })
    const upd = recordingUpdate(machine)

    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('running'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('ready')
    expect(upd.calls[0].updates.status).toBe('ready')
  })

  it('trusts a live ControlMaster tunnel as proof of reachability without asking the provider', async () => {
    const machine = makeMachine({ status: 'unreachable' })
    const upd = recordingUpdate(machine)
    let providerAsked = false

    const health = await probeMachineHealth(machine, {
      getProvider: () => ({
        ...fakeProvider('gone'),
        status: async () => {
          providerAsked = true
          return 'gone'
        },
      }),
      tunnels: { checkHealth: async () => true },
      updateMachine: upd.fn as any,
      now,
    })

    expect(health).toBe('ready')
    expect(providerAsked).toBe(false)
  })

  it('emits machine.status on a genuine flip (ready → unreachable)', async () => {
    const machine = makeMachine({ status: 'ready' })
    const upd = recordingUpdate(machine)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await probeMachineHealth(machine, {
        getProvider: () => fakeProvider('gone'),
        tunnels: { checkHealth: async () => false },
        updateMachine: upd.fn as any,
        now,
      })
      const calls = spy.mock.calls.filter((c) => c[0] === 'machine.status')
      expect(calls).toHaveLength(1)
      expect(calls[0][1]).toEqual({ machineId: machine.id, status: 'unreachable' })
    } finally {
      spy.mockRestore()
    }
  })

  it('does NOT emit machine.status when the health probe leaves the status unchanged (ready → ready)', async () => {
    const machine = makeMachine({ status: 'ready' })
    const upd = recordingUpdate(machine)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await probeMachineHealth(machine, {
        getProvider: () => fakeProvider('running'),
        tunnels: { checkHealth: async () => false },
        updateMachine: upd.fn as any,
        now,
      })
      // lastSeenAt is bumped, but status stayed 'ready' → no status event (the
      // periodic sweep would otherwise spam every tick).
      expect(spy.mock.calls.filter((c) => c[0] === 'machine.status')).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('does NOT flip an intentionally parked machine', async () => {
    const machine = makeMachine({ status: 'parked' })
    const upd = recordingUpdate(machine)

    await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('parked'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
    })

    expect(upd.calls).toHaveLength(0)
    expect(machine.status).toBe('parked')
  })

  it('sweeps machine-side remnants ONLY on the unreachable→ready recovery transition', async () => {
    // unreachable → ready (recovery) sweeps; ready → ready (steady state) and
    // ready → unreachable (failure) do NOT.
    const cases: Array<{ from: Machine['status']; provider: 'running' | 'gone'; expectSweep: boolean }> = [
      { from: 'unreachable', provider: 'running', expectSweep: true },
      { from: 'ready', provider: 'running', expectSweep: false }, // steady-state ready
      { from: 'ready', provider: 'gone', expectSweep: false }, // ready → unreachable
      { from: 'unreachable', provider: 'gone', expectSweep: false }, // still down
    ]
    for (const { from, provider, expectSweep } of cases) {
      const machine = makeMachine({ status: from })
      const upd = recordingUpdate(machine)
      const swept: string[] = []
      await probeMachineHealth(machine, {
        getProvider: () => fakeProvider(provider),
        tunnels: { checkHealth: async () => false },
        updateMachine: upd.fn as any,
        now,
        sweepRemnants: async (m) => {
          swept.push(m.id)
          return { removed: [], failed: [] }
        },
      })
      // Let the fire-and-forget sweep settle.
      await Promise.resolve()
      expect(swept.length === 1).toBe(expectSweep)
    }
  })

  it('a sweep failure never propagates out of the probe', async () => {
    const machine = makeMachine({ status: 'unreachable' })
    const upd = recordingUpdate(machine)
    // Must resolve to 'ready' despite the sweep rejecting.
    const health = await probeMachineHealth(machine, {
      getProvider: () => fakeProvider('running'),
      tunnels: { checkHealth: async () => false },
      updateMachine: upd.fn as any,
      now,
      sweepRemnants: async () => {
        throw new Error('sweep blew up')
      },
    })
    expect(health).toBe('ready')
    // Give the caught rejection a tick to be handled, not surface as unhandled.
    await Promise.resolve()
  })
})

// ---------------------------------------------------------------------------
// sweepMachineHealth
// ---------------------------------------------------------------------------

describe('sweepMachineHealth', () => {
  it('probes ready/unreachable machines and skips parked + terminated ones', async () => {
    const ready = makeMachine({ id: 'm-ready', status: 'ready' })
    const unreachable = makeMachine({ id: 'm-unreach', status: 'unreachable' })
    const parked = makeMachine({ id: 'm-parked', status: 'parked' })
    const terminated = makeMachine({ id: 'm-term', status: 'terminated' })
    const updated: string[] = []

    await sweepMachineHealth({
      listMachines: async () => [ready, unreachable, parked, terminated],
      getProvider: () => fakeProvider('running'),
      tunnels: { checkHealth: async () => false },
      updateMachine: (async (id: string, updates: any) => {
        updated.push(id)
        return { ...ready, ...updates }
      }) as any,
      now,
    })

    expect(updated.sort()).toEqual(['m-ready', 'm-unreach'].sort())
  })

  it('continues past a machine whose probe throws', async () => {
    const good = makeMachine({ id: 'm-good', status: 'ready' })
    const bad = makeMachine({ id: 'm-bad', status: 'ready' })
    const updated: string[] = []

    await sweepMachineHealth({
      listMachines: async () => [bad, good],
      getProvider: () => ({
        ...fakeProvider('running'),
        status: async (m) => {
          if (m.id === 'm-bad') throw new Error('ssh blew up')
          return 'running'
        },
      }),
      tunnels: { checkHealth: async () => false },
      updateMachine: (async (id: string, updates: any) => {
        updated.push(id)
        return { ...good, ...updates }
      }) as any,
      now,
    })

    expect(updated).toEqual(['m-good'])
  })

  it('(a) caps concurrent probes at FICUS_MACHINE_PROBE_CONCURRENCY across the fleet', async () => {
    const machines = [1, 2, 3, 4].map((n) => makeMachine({ id: `m-${n}`, status: 'ready' }))
    await withProbeConcurrency('2', async () => {
      const t = concurrencyTrackingDeps(machines)
      await sweepMachineHealth(t.deps)
      expect(t.peak).toBe(2) // never more than 2 probes in flight at once
      expect(t.probed.length).toBe(4) // …yet all four are probed
    })
  })

  it('(b) probes every machine even when one probe rejects (fan-out error isolation)', async () => {
    const machines = ['a', 'b', 'c', 'd'].map((s) => makeMachine({ id: `m-${s}`, status: 'ready' }))
    const probed: string[] = []
    await withProbeConcurrency('2', async () => {
      await sweepMachineHealth({
        listMachines: async () => machines,
        tunnels: { checkHealth: async () => true },
        updateMachine: (async (id: string, updates: any) => {
          if (id === 'm-b') throw new Error('write blew up')
          probed.push(id)
          return { ...machines[0], ...updates }
        }) as any,
        now,
      })
    })
    // m-b's probe threw; the other three were probed regardless of completion order.
    expect(probed.sort()).toEqual(['m-a', 'm-c', 'm-d'])
  })

  it('(c) honors an explicit env cap and falls back to the default (5) on an invalid value', async () => {
    const machines = [1, 2, 3, 4].map((n) => makeMachine({ id: `m-${n}`, status: 'ready' }))

    await withProbeConcurrency('2', async () => {
      const t = concurrencyTrackingDeps(machines)
      await sweepMachineHealth(t.deps)
      expect(t.peak).toBe(2)
    })

    // Invalid value → default of 5, so all four probes run concurrently.
    await withProbeConcurrency('not-a-number', async () => {
      const t = concurrencyTrackingDeps(machines)
      await sweepMachineHealth(t.deps)
      expect(t.peak).toBe(4)
    })
  })

  it('(d) produces the same result set as a serial run for identical fixtures', async () => {
    const build = () => [
      makeMachine({ id: 'm-1', status: 'ready' }),
      makeMachine({ id: 'm-2', status: 'unreachable' }),
      makeMachine({ id: 'm-3', status: 'parked' }),
      makeMachine({ id: 'm-4', status: 'ready' }),
    ]
    const run = async (concurrency: string) => {
      const t = concurrencyTrackingDeps(build())
      await withProbeConcurrency(concurrency, async () => {
        await sweepMachineHealth(t.deps)
      })
      return t.probed.sort()
    }
    const serial = await run('1')
    const concurrent = await run('10')
    expect(concurrent).toEqual(serial)
    expect(serial).toEqual(['m-1', 'm-2', 'm-4']) // parked machine is skipped
  })
})

// ---------------------------------------------------------------------------
// isOwnerTerminated
// ---------------------------------------------------------------------------

describe('isOwnerTerminated', () => {
  it('agent owner: final termination → reclaimable; dormant remains protected; missing → reclaimable', async () => {
    const deps = {
      loadAgent: async (id: string) =>
        id === 'live'
          ? { status: 'idle' as const }
          : id === 'dormant'
            ? { status: 'dormant' as const }
            : id === 'dead'
              ? { status: 'terminated' as const }
              : null,
    }
    expect(await isOwnerTerminated('agent_live', deps)).toBe(false)
    expect(await isOwnerTerminated('agent_dormant', deps)).toBe(false)
    expect(await isOwnerTerminated('agent_dead', deps)).toBe(true)
    expect(await isOwnerTerminated('agent_missing', deps)).toBe(true)
  })

  it('squad owner: archivedAt set → terminated; missing → terminated; live → not', async () => {
    const deps = {
      loadSquad: async (id: string) =>
        id === 'live' ? { archivedAt: null } : id === 'dead' ? { archivedAt: new Date() } : null,
    }
    expect(await isOwnerTerminated('squad_live', deps)).toBe(false)
    expect(await isOwnerTerminated('squad_dead', deps)).toBe(true)
    expect(await isOwnerTerminated('squad_missing', deps)).toBe(true)
  })

  it('never treats a system-manager (singleton) box as owner-terminated', async () => {
    expect(await isOwnerTerminated('system_manager_default', {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reconcileOrphanedBoxes
// ---------------------------------------------------------------------------

interface RemoveCall {
  sandboxId: string
  archivePrivate?: boolean
  archiveOwnerId?: string
}

function reconcileHarness(opts: {
  boxes: MachineBox[]
  machines: Record<string, Machine | null>
  agents?: Record<string, { status: AgentStatus } | null>
  squads?: Record<string, { archivedAt: Date | null } | null>
}) {
  const upserts: Array<{ sandboxId: string; status?: string }> = []
  const removes: RemoveCall[] = []
  const deps = {
    listAllMachineBoxes: async () => opts.boxes,
    getMachine: async (id: string) => opts.machines[id] ?? null,
    upsertMachineBox: (async (box: any) => {
      upserts.push({ sandboxId: box.sandboxId, status: box.status })
      return box
    }) as any,
    removeBox: async (sandboxId: string, o?: { archivePrivate?: boolean; archiveOwnerId?: string }) => {
      removes.push({
        sandboxId,
        archivePrivate: o?.archivePrivate,
        ...(o?.archiveOwnerId ? { archiveOwnerId: o.archiveOwnerId } : {}),
      })
    },
    loadAgent: async (id: string) => opts.agents?.[id] ?? null,
    loadSquad: async (id: string) => opts.squads?.[id] ?? null,
  }
  return { deps, upserts, removes }
}

describe('reconcileOrphanedBoxes', () => {
  it('reclaims an externalized unverified-stop remnant only when its exact machine is ready', async () => {
    const machine = makeMachine({ id: 'm1', status: 'ready' })
    const box = makeBox({
      sandboxId: unverifiedStopRemnantId('agent_original', '00000000-0000-4000-8000-000000000001'),
      machineId: 'm1',
      status: 'orphaned',
    })
    const h = reconcileHarness({ boxes: [box], machines: { m1: machine } })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([])
    expect(h.removes).toEqual([{ sandboxId: box.sandboxId, archivePrivate: true, archiveOwnerId: 'agent_original' }])
  })

  it('retains an externalized unverified-stop remnant while its exact machine is unreachable', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const box = makeBox({
      sandboxId: unverifiedStopRemnantId('agent_original', '00000000-0000-4000-8000-000000000002'),
      machineId: 'm1',
      status: 'orphaned',
    })
    const h = reconcileHarness({ boxes: [box], machines: { m1: machine } })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([])
    expect(h.removes).toEqual([])
  })

  it('marks orphaned + removes an agent box on an unreachable machine whose owner is terminated', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
      agents: { a1: { status: 'terminated' } },
    })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([{ sandboxId: 'agent_a1', status: 'orphaned' }])
    // agent role → private tree archived on reclamation
    expect(h.removes).toEqual([{ sandboxId: 'agent_a1', archivePrivate: true }])
  })

  // Perf: the caller (the 60s vm lifecycle tick) already lists every machine
  // for the health sweep. Given that list, the reconciler must resolve hosts
  // from it — a `getMachine` per box (boxes ~50, machines single digits) was
  // pure duplicated load.
  it('resolves hosts from a preloaded machines map without a single getMachine call', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const boxes = [
      makeBox({ sandboxId: 'agent_a1', machineId: 'm1' }),
      makeBox({ sandboxId: 'agent_a2', machineId: 'm1' }),
      makeBox({ sandboxId: 'agent_a3', machineId: 'm1' }),
    ]
    let getMachineCalls = 0
    const h = reconcileHarness({ boxes, machines: {}, agents: { a1: null, a2: null, a3: null } })

    await reconcileOrphanedBoxes({
      ...h.deps,
      getMachine: (async (id: string) => {
        getMachineCalls++
        return id === 'm1' ? machine : null
      }) as any,
      machines: new Map([['m1', machine]]),
    })

    expect(getMachineCalls).toBe(0)
    expect(h.upserts.map((u) => u.sandboxId).sort()).toEqual(['agent_a1', 'agent_a2', 'agent_a3'])
  })

  it('treats a box whose machine is missing from the preloaded map as hosted on a dead machine', async () => {
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm-gone' })
    const h = reconcileHarness({ boxes: [box], machines: {}, agents: { a1: { status: 'terminated' } } })

    await reconcileOrphanedBoxes({ ...h.deps, machines: new Map() })

    expect(h.upserts).toEqual([{ sandboxId: 'agent_a1', status: 'orphaned' }])
  })

  it('orphans a box whose machine is absent (row references a deleted machine)', async () => {
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm-gone' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { 'm-gone': null },
      agents: { a1: { status: 'terminated' } },
    })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([{ sandboxId: 'agent_a1', status: 'orphaned' }])
    expect(h.removes).toHaveLength(1)
  })

  it('does NOT archive a squad box on reclamation', async () => {
    const machine = makeMachine({ id: 'm1', status: 'terminated' })
    const box = makeBox({ sandboxId: 'squad_s1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
      squads: { s1: { archivedAt: new Date() } },
    })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.removes).toEqual([{ sandboxId: 'squad_s1', archivePrivate: false }])
  })

  it('LEAVES a box on a dead machine whose owner is still active (box-manager re-places on next ensure)', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
      agents: { a1: { status: 'idle' } }, // owner STILL ACTIVE
    })

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([])
    expect(h.removes).toEqual([])
  })

  it('LEAVES a box whose machine is healthy (ready) even if its owner is terminated', async () => {
    const machine = makeMachine({ id: 'm1', status: 'ready' })
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
      agents: { a1: { status: 'terminated' } },
    })

    await reconcileOrphanedBoxes(h.deps)

    // Not our concern: a live machine's box is torn down by explicit teardown,
    // not by the machine-death reconciler.
    expect(h.upserts).toEqual([])
    expect(h.removes).toEqual([])
  })

  it('a box on a dead machine whose owner query throws is left untouched (data-loss guard)', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
    })
    h.deps.loadAgent = async () => {
      throw new Error('db blew up')
    }

    // Must not throw — reconcile continues past the failed owner lookup.
    await reconcileOrphanedBoxes(h.deps)

    // Conservative default: no mutation at all when the owner query throws.
    expect(h.upserts).toEqual([])
    expect(h.removes).toEqual([])
  })

  it("one box's owner-query throw does not prevent a later orphan from being reclaimed", async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const badBox = makeBox({ sandboxId: 'agent_bad', machineId: 'm1' })
    const goodBox = makeBox({ sandboxId: 'agent_good', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [badBox, goodBox],
      machines: { m1: machine },
      agents: { good: { status: 'terminated' } },
    })
    const realLoadAgent = h.deps.loadAgent
    h.deps.loadAgent = async (id: string) => {
      if (id === 'bad') throw new Error('db blew up')
      return realLoadAgent(id)
    }

    await reconcileOrphanedBoxes(h.deps)

    expect(h.upserts).toEqual([{ sandboxId: 'agent_good', status: 'orphaned' }])
    expect(h.removes).toEqual([{ sandboxId: 'agent_good', archivePrivate: true }])
  })

  it('leaves the orphaned row durably when best-effort removeBox throws', async () => {
    const machine = makeMachine({ id: 'm1', status: 'unreachable' })
    const box = makeBox({ sandboxId: 'agent_a1', machineId: 'm1' })
    const h = reconcileHarness({
      boxes: [box],
      machines: { m1: machine },
      agents: { a1: { status: 'terminated' } },
    })
    h.deps.removeBox = async () => {
      throw new Error('machine unreachable, teardown failed')
    }

    // Must not throw — reconcile continues past a failed teardown.
    await reconcileOrphanedBoxes(h.deps)

    // Row was still marked 'orphaned' (durable marker survives the failed teardown).
    expect(h.upserts).toEqual([{ sandboxId: 'agent_a1', status: 'orphaned' }])
  })
})

// ---------------------------------------------------------------------------
// Machine-side remnant sweep
// ---------------------------------------------------------------------------

/** A runner whose single `run` is backed by `handler(cmd)`. */
function fakeRunner(handler: (cmd: string) => SshResult | Promise<SshResult>): SshRunner {
  return { run: async (_m, cmd) => handler(cmd) }
}

const ok = (stdout: string): SshResult => ({ exitCode: 0, stdout, stderr: '' })

describe('listMachineBoxUsers', () => {
  it('returns only strict box_<12hex> usernames, re-validating client-side', async () => {
    // Simulate a getent/awk output that (maliciously or through a filter gap)
    // leaked non-box and malformed names. The client-side regex must drop them.
    const runner = fakeRunner(() =>
      ok(
        [
          'box_deadbeefcafe', // valid
          'box_0123456789ab', // valid
          'ubuntu', // host account
          'box_ABCDEF123456', // uppercase hex → reject
          'box_short', // too short → reject
          'box_deadbeef', // 8 hex, too short → reject
          'box_deadbeefcafe; rm -rf /', // shell metacharacters → reject
          'root', // system account
          '   box_ffffffffffff   ', // valid but padded → trimmed & kept
          '', // blank line
        ].join('\n')
      )
    )
    const users = await listMachineBoxUsers(runner, makeMachine())
    expect(users).toEqual(['box_deadbeefcafe', 'box_0123456789ab', 'box_ffffffffffff'])
  })

  it('returns [] on a nonzero exit', async () => {
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: 'box_deadbeefcafe', stderr: 'boom' }))
    expect(await listMachineBoxUsers(runner, makeMachine())).toEqual([])
  })

  it('returns [] on empty output', async () => {
    const runner = fakeRunner(() => ok(''))
    expect(await listMachineBoxUsers(runner, makeMachine())).toEqual([])
  })

  it('returns [] (never throws) when the runner itself throws', async () => {
    const runner: SshRunner = {
      run: async () => {
        throw new Error('ssh unreachable')
      },
    }
    expect(await listMachineBoxUsers(runner, makeMachine())).toEqual([])
  })
})

interface RemnantRemoveCall {
  machineId: string
  unixUser: string
}

describe('sweepMachineRemnants', () => {
  const throwingRunner: SshRunner = {
    run: async () => {
      throw new Error('runner must not be used when list/remove are injected')
    },
  }

  it('removes a machine-side user with no live row (archived), leaving live rows alone', async () => {
    const machine = makeMachine({ id: 'm1' })
    const liveUser = boxUnixUser('agent_live')
    const orphanedUser = boxUnixUser('squad_orphaned') // a row still exists → NOT a remnant
    const stoppedUser = boxUnixUser('agent_stopped')
    const remnant = boxUnixUser('agent_gone')

    const removed: RemnantRemoveCall[] = []
    const result = await sweepMachineRemnants(machine, {
      runner: throwingRunner,
      listMachineBoxUsers: async () => [liveUser, orphanedUser, stoppedUser, remnant],
      listRows: async () => [
        makeBox({ sandboxId: 'agent_live', machineId: 'm1', status: 'ready' }),
        makeBox({ sandboxId: 'squad_orphaned', machineId: 'm1', status: 'orphaned' }),
        makeBox({ sandboxId: 'agent_stopped', machineId: 'm1', status: 'stopped' }),
        // A row on ANOTHER machine must not shield a user on THIS machine.
        makeBox({ sandboxId: 'agent_gone', machineId: 'other', status: 'ready' }),
      ],
      remove: async (m, u) => {
        removed.push({ machineId: m.id, unixUser: u })
      },
    })

    expect(removed).toEqual([{ machineId: 'm1', unixUser: remnant }])
    expect(result.removed).toEqual([remnant])
    expect(result.failed).toEqual([])
  })

  it('never passes a non-box username to the remover even if the lister returns garbage', async () => {
    const machine = makeMachine({ id: 'm1' })
    const removed: string[] = []
    await sweepMachineRemnants(machine, {
      runner: throwingRunner,
      listMachineBoxUsers: async () => ['ubuntu', 'box_ABCDEF123456', 'box_short', 'root; rm -rf /'],
      listRows: async () => [],
      remove: async (_m, u) => {
        removed.push(u)
      },
    })
    expect(removed).toEqual([])
  })

  it('TOCTOU: a row that appears between the diff and the per-user re-check is spared', async () => {
    const machine = makeMachine({ id: 'm1' })
    const user = boxUnixUser('agent_racing')
    let call = 0
    const removed: string[] = []
    await sweepMachineRemnants(machine, {
      runner: throwingRunner,
      listMachineBoxUsers: async () => [user],
      listRows: async () => {
        call += 1
        // First call (initial diff) sees no row → user is a candidate remnant.
        // Second call (per-user re-check) sees a freshly-bound row → spare it.
        return call === 1 ? [] : [makeBox({ sandboxId: 'agent_racing', machineId: 'm1', status: 'ready' })]
      },
      remove: async (_m, u) => {
        removed.push(u)
      },
    })
    expect(removed).toEqual([])
  })

  it('is best-effort: one failing removal does not stop the rest', async () => {
    const machine = makeMachine({ id: 'm1' })
    const bad = boxUnixUser('agent_bad')
    const good = boxUnixUser('agent_good')
    const removed: string[] = []
    const result = await sweepMachineRemnants(machine, {
      runner: throwingRunner,
      listMachineBoxUsers: async () => [bad, good],
      listRows: async () => [],
      remove: async (_m, u) => {
        if (u === bad) throw new Error('userdel failed')
        removed.push(u)
      },
    })
    expect(removed).toEqual([good])
    expect(result.removed).toEqual([good])
    expect(result.failed).toEqual([bad])
  })
})

// ---------------------------------------------------------------------------
// Disk-usage sampling (T3 — feeds the platform's storage guard)
// ---------------------------------------------------------------------------

describe('parseDfOutput', () => {
  it('parses a well-formed `df --output=used,size` line (header + one data row)', () => {
    expect(parseDfOutput('     Used     1B-blocks\n 62277025792  85899345920\n')).toEqual({
      usedBytes: 62277025792,
      totalBytes: 85899345920,
    })
  })

  it('tolerates leading/trailing blank lines and whitespace', () => {
    expect(parseDfOutput('\n\n   1000   2000   \n\n')).toEqual({ usedBytes: 1000, totalBytes: 2000 })
  })

  it('returns null on empty output', () => {
    expect(parseDfOutput('')).toBeNull()
  })

  it('returns null when a field is non-numeric', () => {
    expect(parseDfOutput('Used Size\nabc 2000')).toBeNull()
  })

  it('returns null when only one field is present', () => {
    expect(parseDfOutput('Used\n1000')).toBeNull()
  })

  it('returns null for a negative used value', () => {
    expect(parseDfOutput('-1 2000')).toBeNull()
  })

  it('returns null for a zero or negative total', () => {
    expect(parseDfOutput('1000 0')).toBeNull()
    expect(parseDfOutput('1000 -5')).toBeNull()
  })
})

describe('sampleMachineDiskUsage', () => {
  const GIB = 1024 ** 3

  it('floors bytes to whole GiB and returns {usedGb, totalGb}', async () => {
    // 65_000_000_000 / GiB = 60.53... -> 60 (exercises the floor, unlike the
    // exact-multiple values below) ; 85899345920 / GiB = 80 exactly.
    const runner = fakeRunner(() => ok('Used 1B-blocks\n65000000000 85899345920\n'))
    expect(await sampleMachineDiskUsage(makeMachine(), { runner })).toEqual({ usedGb: 60, totalGb: 80 })
    // Sanity check the floor arithmetic directly against GIB.
    expect(Math.floor(65000000000 / GIB)).toBe(60)
    expect(Math.floor(85899345920 / GIB)).toBe(80)
  })

  it('returns null on a nonzero exit code', async () => {
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'df: /home: no such file' }))
    expect(await sampleMachineDiskUsage(makeMachine(), { runner })).toBeNull()
  })

  it('returns null (never throws) when the runner itself throws', async () => {
    const runner: SshRunner = {
      run: async () => {
        throw new Error('ssh unreachable')
      },
    }
    expect(await sampleMachineDiskUsage(makeMachine(), { runner })).toBeNull()
  })

  it('returns null on unparseable df output', async () => {
    const runner = fakeRunner(() => ok('garbage'))
    expect(await sampleMachineDiskUsage(makeMachine(), { runner })).toBeNull()
  })

  it('samples the SAME filesystem as the machine-metrics sub-sampler (shared DISK_SAMPLE_PATH, not a second hardcoded path)', async () => {
    let capturedCommand: string | undefined
    const runner = fakeRunner((cmd) => {
      capturedCommand = cmd
      return ok('1000 2000\n')
    })
    await sampleMachineDiskUsage(makeMachine(), { runner })
    expect(capturedCommand).toContain(DISK_SAMPLE_PATH)
  })
})

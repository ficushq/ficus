import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import {
  runVmSandboxLifecycleTick,
  createVmLifecycleTick,
  createVmKeepAlive,
  startVmSandboxLifecycle,
  stopVmSandboxLifecycle,
  buildProductionTickDeps,
  recoverVmSetupOwner,
  classifyVmSetupAgentOwner,
  productionVmSetupAgentOwnerRecovery,
  retireVmSetupRecoveryWithConvergence,
  type VmLifecycleTickDeps,
} from './lifecycle'
import type { MachineBox } from '../../machines/queries'
import type { VmLifecycleState } from './manager'
import type { SquadForKeepWarm } from '../keep-warm'
import { listPeriodicRunnerNames } from '../../../lib/infra/PeriodicRunner'
import { Agent } from '../../../entities/Agent'

// A silent logger for the tick (info/warn/debug are the only surface used).
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} }

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

// A tracked box that WOULD park: stale activity (0), not always-on, ready.
function trackedStale(overrides: Partial<VmLifecycleState> = {}): VmLifecycleState {
  return {
    lastActivityAt: 0,
    idleTimeoutMs: 1000,
    alwaysOn: false,
    status: 'ready',
    ...overrides,
  }
}

/** Records which steps ran + which boxes were stopped. */
function makeDeps(overrides: Partial<VmLifecycleTickDeps> = {}): {
  deps: VmLifecycleTickDeps
  stopped: string[]
  calls: Record<string, number>
} {
  const stopped: string[] = []
  const calls: Record<string, number> = {
    sweepMachineHealth: 0,
    reconcileOrphanedBoxes: 0,
    reapEmptyMachines: 0,
    reconcileSquadSpecs: 0,
    reconcileSetupIncidents: 0,
    recoverMissingSetups: 0,
    recoverDueSetups: 0,
    warmupSquads: 0,
    warmupWorkStreams: 0,
  }
  const deps: VmLifecycleTickDeps = {
    listAllMachineBoxes: async () => [makeBox()],
    listMachines: async () => [],
    listActiveSquads: async () => [],
    getLifecycleState: () => trackedStale(),
    keepAlive: async () => false,
    stopBox: async (id) => {
      stopped.push(id)
    },
    externalizeUnverifiedStop: async () => true,
    sweepMachineHealth: async () => {
      calls.sweepMachineHealth++
    },
    reconcileOrphanedBoxes: async () => {
      calls.reconcileOrphanedBoxes++
    },
    reapEmptyMachines: async () => {
      calls.reapEmptyMachines++
    },
    listListeningPorts: async () => new Set<number>(),
    reconcileSquadSpecs: async () => {
      calls.reconcileSquadSpecs++
    },
    reconcileSetupIncidents: async () => {
      calls.reconcileSetupIncidents++
    },
    recoverMissingSetups: async () => {
      calls.recoverMissingSetups++
    },
    recoverDueSetups: async () => {
      calls.recoverDueSetups++
    },
    warmupSquads: async () => {
      calls.warmupSquads++
    },
    warmupWorkStreams: async () => {
      calls.warmupWorkStreams++
    },
    now: () => 5000, // 5000 - 0 = 5000 > idleTimeoutMs(1000) → stale
    log: silentLog,
    ...overrides,
  }
  return { deps, stopped, calls }
}

describe('runVmSandboxLifecycleTick — idle reap', () => {
  test('parks a stale, tracked, ready, not-always-on box (stopBox, never remove)', async () => {
    const { deps, stopped } = makeDeps()
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual(['agent_a1'])
  })

  test('does NOT park an always-on box', async () => {
    const { deps, stopped } = makeDeps({ getLifecycleState: () => trackedStale({ alwaysOn: true }) })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('does NOT park an active box (keepAlive wants it warm)', async () => {
    const { deps, stopped } = makeDeps({ keepAlive: async () => true })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('does NOT park a box whose DB row is not ready (e.g. stopped)', async () => {
    const { deps, stopped } = makeDeps({ listAllMachineBoxes: async () => [makeBox({ status: 'stopped' })] })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('boxStatus comes from the DB row, NOT getLifecycleState (T1 landmine)', async () => {
    // The box is fully parkable per getLifecycleState (ready + stale + not always-on),
    // but its authoritative DB row status is 'ensuring' → must NOT be parked. Proves
    // the readiness gate reads box.status, not the hardcoded getLifecycleState().status.
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ status: 'ensuring' })],
      getLifecycleState: () => trackedStale(), // .status === 'ready'
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('does NOT park an untracked box with no row heartbeat (no activity signal at all)', async () => {
    const { deps, stopped } = makeDeps({ getLifecycleState: () => undefined })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('a fresh row heartbeat (activity persisted by the OTHER process) outvotes stale local activity', async () => {
    // Locally stale (lastActivityAt 0, timeout 1000, now 5000 → parkable), but
    // the row heartbeat says the box was touched at t=4500 — e.g. a live api
    // terminal while this reaper runs in the worker. max(local, row) = 4500 →
    // idle 500 ≤ 1000 → NOT parked mid-use.
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ lastActivityAt: new Date(4500) })],
      getLifecycleState: () => trackedStale(),
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('an untracked box with a fresh row heartbeat is not reaped', async () => {
    // This process never ensured the box (getLifecycleState undefined), but the
    // ensuring process's heartbeat is fresh — parking would kill a box in use.
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ lastActivityAt: new Date(4500) })],
      getLifecycleState: () => undefined,
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('an untracked box with a STALE row heartbeat is NOT reaped under the vm always-on default (review finding #2)', async () => {
    // Historically (before the vm always-on default): an untracked box (e.g.
    // ensured by the OTHER process, or by THIS process before a restart wiped
    // its in-memory map) fell back to a hardcoded alwaysOn:false here, so a
    // stale row heartbeat past DEFAULT_IDLE_TIMEOUT_MS got it parked — the
    // shared-heartbeat fix's whole point. Now the sweep's fallback is
    // vmBoxAlwaysOnDefault() (the SAME policy manager.ts's tracked-ensure path
    // uses), not a bare `false`, so this exact box is no longer parkable
    // either — an api-ensured or post-worker-restart box must get the same
    // always-on treatment as one this process tracked directly, or the user's
    // original park/resume-latency symptom persists for every box the reaper
    // doesn't happen to have in memory (worker restarts wipe that map on
    // every deploy).
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ lastActivityAt: new Date(0) })],
      getLifecycleState: () => undefined,
      now: () => 16 * 60 * 1000, // 16m > 15m default timeout — would have parked pre-fix
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('FICUS_VM_BOX_PARK_ON_IDLE=true reaches the sweep too: the SAME untracked+stale box above IS reaped again once parking is explicitly re-enabled', async () => {
    const original = process.env.FICUS_VM_BOX_PARK_ON_IDLE
    process.env.FICUS_VM_BOX_PARK_ON_IDLE = 'true'
    try {
      const { deps, stopped } = makeDeps({
        listAllMachineBoxes: async () => [makeBox({ lastActivityAt: new Date(0) })],
        getLifecycleState: () => undefined,
        now: () => 16 * 60 * 1000,
      })
      await runVmSandboxLifecycleTick(deps)
      expect(stopped).toEqual(['agent_a1'])
    } finally {
      if (original === undefined) delete process.env.FICUS_VM_BOX_PARK_ON_IDLE
      else process.env.FICUS_VM_BOX_PARK_ON_IDLE = original
    }
  })

  test('a VM-mode ready box past the idle timeout is NOT parked — untracked/api-ensured case (getLifecycleState undefined)', async () => {
    // Directly pins the original brief's requested test ("a VM-mode ready box
    // past the idle timeout is NOT parked") for the specific gap review found:
    // a box THIS process never ensured (api-ensured while the reaper runs in
    // the worker, or any box at all in the window right after a worker
    // restart, before its first re-ensure repopulates the in-memory map).
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ status: 'ready', lastActivityAt: new Date(0) })],
      getLifecycleState: () => undefined, // post-restart / other-process-ensured
      now: () => 60 * 60 * 1000, // 1h — nowhere near "within timeout", proves it's alwaysOn, not activity
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('fresh LOCAL activity outvotes a stale row heartbeat (max, not row-wins)', async () => {
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ lastActivityAt: new Date(0) })],
      getLifecycleState: () => trackedStale({ lastActivityAt: 4500 }),
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([])
  })

  test('one box keepAlive throwing does not abort the sweep (per-candidate isolation)', async () => {
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [makeBox({ sandboxId: 'agent_bad' }), makeBox({ sandboxId: 'agent_good' })],
      keepAlive: async (id) => {
        if (id === 'agent_bad') throw new Error('keepAlive boom')
        return false
      },
    })
    await runVmSandboxLifecycleTick(deps)
    // The throwing box is skipped; the healthy parkable box is still parked.
    expect(stopped).toEqual(['agent_good'])
  })
})

describe('createVmKeepAlive — squad boxes delegate to the shared keep-warm predicate', () => {
  const NOW = 10_000_000

  function makeSquad(opts: { alwaysOn?: boolean; agentMsgMinutesAgo?: number | null }): SquadForKeepWarm {
    const last = opts.agentMsgMinutesAgo == null ? null : new Date(NOW - opts.agentMsgMinutesAgo * 60 * 1000)
    return {
      id: 's1',
      isSandboxAlwaysOn: opts.alwaysOn ?? false,
      getActiveAgents: async () => [{ id: 's1-agent', lastMessageAt: last }] as any,
    }
  }

  function makeKeepAlive(overrides: {
    squad?: SquadForKeepWarm | null
    deploy?: (id: string) => boolean
    workStream?: (id: string) => boolean
    findSquadCalls?: string[]
  }) {
    return createVmKeepAlive({
      findSquad: async (squadId) => {
        overrides.findSquadCalls?.push(squadId)
        return overrides.squad ?? null
      },
      hasActiveLocalDeployments: async (id) => overrides.deploy?.(id) ?? false,
      hasRecentWorkStreamActivity: async (id) => overrides.workStream?.(id) ?? false,
      now: () => NOW,
    })
  }

  test('squad box kept warm by recent agent activity (agent-message signal added)', async () => {
    const keepAlive = makeKeepAlive({ squad: makeSquad({ agentMsgMinutesAgo: 20 }) })
    expect(await keepAlive('squad_s1')).toBe(true)
  })

  test('consultant box uses the same squad activity window and can idle once it expires', async () => {
    expect(await makeKeepAlive({ squad: makeSquad({ agentMsgMinutesAgo: 20 }) })('consultants_s1')).toBe(true)
    expect(await makeKeepAlive({ squad: makeSquad({ agentMsgMinutesAgo: 120 }) })('consultants_s1')).toBe(false)
  })

  test('squad box kept warm when always-on', async () => {
    const keepAlive = makeKeepAlive({ squad: makeSquad({ alwaysOn: true }) })
    expect(await keepAlive('squad_s1')).toBe(true)
  })

  test('squad box kept warm by an active local deployment', async () => {
    const keepAlive = makeKeepAlive({ squad: makeSquad({ agentMsgMinutesAgo: 120 }), deploy: () => true })
    expect(await keepAlive('squad_s1')).toBe(true)
  })

  test('idle squad box with no signal is NOT kept warm', async () => {
    const keepAlive = makeKeepAlive({ squad: makeSquad({ agentMsgMinutesAgo: 120 }) })
    expect(await keepAlive('squad_s1')).toBe(false)
  })

  test('squad row missing → falls back to generic deploy ∨ work-stream signals', async () => {
    const keepAlive = makeKeepAlive({ squad: null, deploy: (id) => id === 'squad_gone' })
    expect(await keepAlive('squad_gone')).toBe(true)
  })

  test('agent box never loads a squad; uses generic deploy ∨ work-stream keepAlive', async () => {
    const findSquadCalls: string[] = []
    const keepAlive = makeKeepAlive({ findSquadCalls, workStream: (id) => id === 'agent_a1' })
    expect(await keepAlive('agent_a1')).toBe(true)
    expect(findSquadCalls).toEqual([]) // no squad lookup for a non-squad box
  })

  test('agent box with no signal is not kept warm', async () => {
    const keepAlive = makeKeepAlive({})
    expect(await keepAlive('agent_a1')).toBe(false)
  })
})

describe('runVmSandboxLifecycleTick — deferred stop verification', () => {
  test('retries a stop-unverified box once its machine is ready', async () => {
    const box = makeBox({ status: 'stop_unverified' })
    const { deps, stopped } = makeDeps({
      listAllMachineBoxes: async () => [box],
      listMachines: async () => [{ id: box.machineId, status: 'ready' } as any],
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stopped).toEqual([box.sandboxId])
  })

  test.each(['unreachable', 'parked', 'draining', 'missing'] as const)(
    'externalizes a stop-unverified box when its machine is %s',
    async (status) => {
      const box = makeBox({ status: 'stop_unverified' })
      const externalized: string[] = []
      const { deps, stopped } = makeDeps({
        listAllMachineBoxes: async () => [box],
        listMachines: async () => (status === 'missing' ? [] : ([{ id: box.machineId, status }] as any)),
        externalizeUnverifiedStop: async (sandboxId) => {
          externalized.push(sandboxId)
          return true
        },
      })
      await runVmSandboxLifecycleTick(deps)
      expect(stopped).toEqual([])
      expect(externalized).toEqual([box.sandboxId])
    }
  )

  test('isolates one failed verification and still runs later lifecycle steps', async () => {
    const first = makeBox({ sandboxId: 'agent_first', status: 'stop_unverified' })
    const second = makeBox({ sandboxId: 'agent_second', status: 'stop_unverified' })
    const attempted: string[] = []
    const { deps, calls } = makeDeps({
      listAllMachineBoxes: async () => [first, second],
      listMachines: async () => [{ id: first.machineId, status: 'ready' } as any],
      stopBox: async (id) => {
        attempted.push(id)
        if (id === first.sandboxId) throw new Error('injected verification failure')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(attempted).toEqual(['agent_first', 'agent_second'])
    expect(calls.reconcileOrphanedBoxes).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
  })
})

describe('runVmSandboxLifecycleTick — step isolation', () => {
  test('all steps run on the happy path', async () => {
    const { deps, calls } = makeDeps()
    await runVmSandboxLifecycleTick(deps)
    expect(calls).toEqual({
      sweepMachineHealth: 1,
      reconcileOrphanedBoxes: 1,
      reapEmptyMachines: 1,
      reconcileSquadSpecs: 1,
      reconcileSetupIncidents: 1,
      recoverMissingSetups: 1,
      recoverDueSetups: 1,
      warmupSquads: 1,
      warmupWorkStreams: 1,
    })
  })

  test('a failing machine-health sweep does NOT skip warmup', async () => {
    const { deps, calls } = makeDeps({
      sweepMachineHealth: async () => {
        throw new Error('sweep boom')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls.warmupSquads).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
    expect(calls.reconcileOrphanedBoxes).toBe(1)
  })

  test('a failing idle reap does NOT skip machine health or warmup', async () => {
    const { deps, calls } = makeDeps({
      listAllMachineBoxes: async () => {
        throw new Error('list boom')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls.sweepMachineHealth).toBe(1)
    expect(calls.warmupSquads).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
  })

  test('a failing empty-machine reap does NOT skip spec reconcile or warmup', async () => {
    const { deps, calls } = makeDeps({
      reapEmptyMachines: async () => {
        throw new Error('reap boom')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls.reconcileSquadSpecs).toBe(1)
    expect(calls.warmupSquads).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
  })

  test('a failing squad spec reconcile does NOT skip the two warmups', async () => {
    const { deps, calls } = makeDeps({
      reconcileSquadSpecs: async () => {
        throw new Error('spec boom')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls.warmupSquads).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
  })
})

describe('runVmSandboxLifecycleTick — one entity load per tick', () => {
  test('lists boxes ONCE and hands that same array to the orphan reconcile', async () => {
    const boxes = [makeBox({ sandboxId: 'agent_a1' }), makeBox({ sandboxId: 'agent_a2' })]
    let listCalls = 0
    let seen: MachineBox[] | undefined
    const { deps } = makeDeps({
      listAllMachineBoxes: async () => {
        listCalls++
        return boxes
      },
      reconcileOrphanedBoxes: async ({ boxes: given }) => {
        seen = given
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(listCalls).toBe(1)
    expect(seen).toBe(boxes)
  })

  test('lists machines ONCE and hands the orphan reconcile a map instead of a per-box lookup', async () => {
    const machine = { id: 'm1', name: 'm', status: 'unreachable' } as any
    let listCalls = 0
    let seen: ReadonlyMap<string, any> | undefined
    const { deps } = makeDeps({
      listAllMachineBoxes: async () => [
        makeBox({ sandboxId: 'agent_a1', machineId: 'm1' }),
        makeBox({ sandboxId: 'agent_a2', machineId: 'm1' }),
        makeBox({ sandboxId: 'agent_a3', machineId: 'm1' }),
      ],
      listMachines: async () => {
        listCalls++
        return [machine]
      },
      reconcileOrphanedBoxes: async ({ machines }) => {
        seen = machines
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(listCalls).toBe(1)
    expect(seen?.get('m1')).toBe(machine)
  })

  test('a failing box listing skips the orphan reconcile but not the rest of the tick', async () => {
    const { deps, calls } = makeDeps({
      listAllMachineBoxes: async () => {
        throw new Error('list boom')
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls.reconcileOrphanedBoxes).toBe(0)
    expect(calls.sweepMachineHealth).toBe(1)
    expect(calls.warmupSquads).toBe(1)
    expect(calls.warmupWorkStreams).toBe(1)
  })

  test('lists active squads ONCE and shares them with the spec reconcile AND the squad warmup', async () => {
    const squads = [{ id: 'sq1' }, { id: 'sq2' }] as any
    let listCalls = 0
    const seen: unknown[] = []
    const { deps } = makeDeps({
      listActiveSquads: async () => {
        listCalls++
        return squads
      },
      reconcileSquadSpecs: async (given) => {
        seen.push(given)
      },
      warmupSquads: async (given) => {
        seen.push(given)
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(listCalls).toBe(1)
    expect(seen).toEqual([squads, squads])
  })

  test('a failing squad listing still runs both squad steps (each falls back to its own fetch)', async () => {
    const seen: unknown[] = []
    const { deps, calls } = makeDeps({
      listActiveSquads: async () => {
        throw new Error('squads boom')
      },
      reconcileSquadSpecs: async (given) => {
        seen.push(given)
      },
      warmupSquads: async (given) => {
        seen.push(given)
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(seen).toEqual([undefined, undefined])
    expect(calls.warmupWorkStreams).toBe(1)
  })
})

/**
 * Socket activation (spec D2) makes the keep-warm sweep dangerous: every warmup
 * ensure used to HTTP-probe its box, and a probe through the socket unit WAKES a
 * server that deliberately stood down — so the 60s tick alone would resurrect
 * every idle box on the host and give back the 1.7 GB the layout reclaims. The
 * tick therefore learns liveness from ONE `ss -ltnH` per machine and hands the
 * warmups a hint instead.
 */
describe('runVmSandboxLifecycleTick — listening-port sweep', () => {
  const ready = { id: 'm1', name: 'm1', status: 'ready' } as any
  const ready2 = { id: 'm2', name: 'm2', status: 'ready' } as any

  function sweepDeps(overrides: Partial<VmLifecycleTickDeps> = {}) {
    const swept: string[] = []
    const hints: Array<string | undefined> = []
    const { deps } = makeDeps({
      // alwaysOn so the reaper never parks these boxes out from under the sweep.
      getLifecycleState: () => trackedStale({ alwaysOn: true }),
      listAllMachineBoxes: async () => [
        makeBox({ sandboxId: 'squad_s1', machineId: 'm1', port: 50100 }),
        makeBox({ sandboxId: 'agent_a1', machineId: 'm1', port: 50101 }),
        makeBox({ sandboxId: 'agent_a2', machineId: 'm2', port: 50100 }),
      ],
      listMachines: async () => [ready, ready2],
      listListeningPorts: async (machine) => {
        swept.push(machine.id)
        // m1: only the squad box's port is up. m2: nothing.
        return machine.id === 'm1' ? new Set([50100]) : new Set<number>()
      },
      warmupSquads: async (_squads, resolve) => {
        hints.push(resolve?.('squad_s1'), resolve?.('agent_a1'), resolve?.('agent_a2'))
      },
      ...overrides,
    })
    return { deps, swept, hints }
  }

  test('runs ONE ss per machine — never one per box — and hints only the listening ones', async () => {
    const { deps, swept, hints } = sweepDeps()
    await runVmSandboxLifecycleTick(deps)
    expect(swept.sort()).toEqual(['m1', 'm2'])
    expect(hints).toEqual(['listening', undefined, undefined])
  })

  test('skips machines that are not ready rather than paying an SSH timeout per tick', async () => {
    const { deps, swept } = sweepDeps({ listMachines: async () => [{ ...ready2, status: 'unreachable' }] })
    await runVmSandboxLifecycleTick(deps)
    expect(swept).toEqual([])
  })

  test('a failed sweep leaves that machine hint-less (probing, i.e. the pre-socket behavior), never fatal', async () => {
    const seen: Array<string | undefined> = []
    const { deps } = sweepDeps({
      listListeningPorts: async () => {
        throw new Error('ssh down')
      },
      warmupSquads: async (_squads, resolve) => {
        seen.push(resolve?.('squad_s1'))
      },
      warmupWorkStreams: async () => {},
    })
    await runVmSandboxLifecycleTick(deps)
    expect(seen).toEqual([undefined])
  })

  test('stamps exactly the listening boxes so the API-side status path can skip its probe', async () => {
    // The tick is the ONLY thing that learns liveness without an HTTP probe, and
    // it runs in the worker. The status path runs in the api, where the same
    // `ss` is not available per poll — so the sweep persists its result and the
    // status path reads the watermark instead of waking the box.
    const stamps: Array<{ ids: string[]; at: Date }> = []
    const { deps } = sweepDeps({
      stampBoxesListening: async (ids, at) => {
        stamps.push({ ids: [...ids], at })
      },
      now: () => 1_700_000_000_000,
    })
    await runVmSandboxLifecycleTick(deps)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].ids).toEqual(['squad_s1'])
    expect(stamps[0].at.getTime()).toBe(1_700_000_000_000)
  })

  test('does not stamp when nothing is listening', async () => {
    let calls = 0
    const { deps } = sweepDeps({
      listListeningPorts: async () => new Set<number>(),
      stampBoxesListening: async () => {
        calls++
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(calls).toBe(0)
  })

  test('a failed stamp never fails the tick nor drops the in-memory hints', async () => {
    const hints: Array<string | undefined> = []
    const { deps } = sweepDeps({
      stampBoxesListening: async () => {
        throw new Error('db down')
      },
      warmupSquads: async (_squads, resolve) => {
        hints.push(resolve?.('squad_s1'), resolve?.('agent_a1'))
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(hints).toEqual(['listening', undefined])
  })

  test('hands the SAME resolver to both warmups', async () => {
    let fromSquads: unknown
    let fromStreams: unknown
    const { deps } = sweepDeps({
      warmupSquads: async (_squads, resolve) => {
        fromSquads = resolve
      },
      warmupWorkStreams: async (resolve) => {
        fromStreams = resolve
      },
    })
    await runVmSandboxLifecycleTick(deps)
    expect(typeof fromSquads).toBe('function')
    expect(fromStreams).toBe(fromSquads)
  })
})

describe('createVmLifecycleTick — re-entrancy guard', () => {
  test('skips a second invocation while the first is still running', async () => {
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let listCalls = 0
    const { deps } = makeDeps({
      listAllMachineBoxes: async () => {
        listCalls++
        await gate
        return []
      },
    })
    const tick = createVmLifecycleTick(deps)

    const first = tick() // starts, blocks on the gate
    await tick() // should short-circuit on the re-entrancy guard
    expect(listCalls).toBe(1)

    releaseFirst()
    await first
    // Once the first completes, a later tick runs again.
    await tick()
    expect(listCalls).toBe(2)
  })
})

describe('buildProductionTickDeps — reaper parks via manager.stopSandbox', () => {
  const savedRuntime = process.env.FICUS_SANDBOX_RUNTIME

  afterEach(() => {
    if (savedRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = savedRuntime
  })

  // The production park effect MUST route through VmSandboxManager.stopSandbox
  // (which closes the box's SandboxClient + deletes the in-memory `sandboxes`
  // entry BEFORE parking the box), not the bare box-manager `stopBox` (which
  // would leave a stale client pointed at a now-cancelled, re-bindable forward
  // port → silent cross-box exec). Assert the wired `stopBox` invokes the
  // manager's stopSandbox for the given box.
  test('production stopBox dep invokes manager.stopSandbox (not the bare box-manager stopBox)', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const { getSandboxManager } = await import('../factory')
    const manager = getSandboxManager() as unknown as import('./manager').VmSandboxManager

    const seen: string[] = []
    const spy = spyOn(manager, 'stopSandbox').mockImplementation(async (id: string) => {
      seen.push(id)
      return { kind: 'stopped' }
    })
    try {
      const deps = await buildProductionTickDeps()
      await deps.stopBox('agent_park_me')
      expect(seen).toEqual(['agent_park_me'])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('startVmSandboxLifecycle / stopVmSandboxLifecycle — runtime gating', () => {
  const savedRuntime = process.env.FICUS_SANDBOX_RUNTIME

  afterEach(async () => {
    await stopVmSandboxLifecycle()
    if (savedRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = savedRuntime
  })

  test('is inert on a non-vm runtime (k8s) — no runner registered', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
    startVmSandboxLifecycle()
    expect(listPeriodicRunnerNames()).not.toContain('vm-sandbox-lifecycle')
  })

  test('is inert on the docker (default) runtime — no runner registered', () => {
    delete process.env.FICUS_SANDBOX_RUNTIME
    startVmSandboxLifecycle()
    expect(listPeriodicRunnerNames()).not.toContain('vm-sandbox-lifecycle')
  })

  test('registers a runner on the vm runtime and stop removes it', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    startVmSandboxLifecycle()
    expect(listPeriodicRunnerNames()).toContain('vm-sandbox-lifecycle')
    await stopVmSandboxLifecycle()
    expect(listPeriodicRunnerNames()).not.toContain('vm-sandbox-lifecycle')
  })

  test('classifies production agent owners with the exact live and dormancy-generation fences', () => {
    const base = { metadata: null as Record<string, unknown> | null }
    expect(classifyVmSetupAgentOwner({ ...base, status: 'active' as const })).toMatchObject({ kind: 'live' })
    expect(
      classifyVmSetupAgentOwner({
        status: 'dormant' as const,
        metadata: { resourceGeneration: 'generation-b', dormancyResourceGeneration: 'generation-a' },
      })
    ).toEqual({ kind: 'retire', lifecycleGeneration: 'generation-a' })
    expect(classifyVmSetupAgentOwner({ ...base, status: 'dormant' as const })).toEqual({
      kind: 'retire',
      lifecycleGeneration: null,
    })
    expect(classifyVmSetupAgentOwner({ ...base, status: 'terminated' as const })).toEqual({
      kind: 'retire',
      lifecycleGeneration: undefined,
    })
    expect(classifyVmSetupAgentOwner(null)).toEqual({ kind: 'retire', lifecycleGeneration: undefined })
  })

  test('production owner recovery reads durable status and the dormancy generation', async () => {
    const find = spyOn(Agent, 'find')
      .mockResolvedValueOnce({ status: 'active', metadata: { resourceGeneration: 'generation-b' } } as unknown as Agent)
      .mockResolvedValueOnce({
        status: 'dormant',
        metadata: { resourceGeneration: 'generation-b', dormancyResourceGeneration: 'generation-a' },
      } as unknown as Agent)
    try {
      expect(await productionVmSetupAgentOwnerRecovery.classifyAgentOwner('live')).toMatchObject({ kind: 'live' })
      expect(await productionVmSetupAgentOwnerRecovery.classifyAgentOwner('dormant')).toEqual({
        kind: 'retire',
        lifecycleGeneration: 'generation-a',
      })
      expect(find).toHaveBeenNthCalledWith(1, 'live', { eager: false })
      expect(find).toHaveBeenNthCalledWith(2, 'dormant', { eager: false })
    } finally {
      find.mockRestore()
    }
  })

  test('converges a mismatched dormant setup generation before an exact retry', async () => {
    const retired: Array<string | null | undefined> = []
    const converged: unknown[][] = []
    const warnings: string[] = []
    await retireVmSetupRecoveryWithConvergence('agent_owner', 'generation-a', {
      retire: async (generation) => {
        retired.push(generation)
        return generation === 'generation-a'
          ? { kind: 'generation-mismatch', actualLifecycleGeneration: 'generation-b' }
          : { kind: 'retired' }
      },
      converge: async (...args) => {
        converged.push(args)
        return true
      },
      warn: (message) => warnings.push(message),
    })
    expect(retired).toEqual(['generation-a', 'generation-b'])
    expect(converged).toEqual([['owner', 'generation-a', 'generation-b']])
    expect(warnings).toEqual([])
  })

  test('does not retry a mismatched setup retirement after a concurrent wake wins the CAS', async () => {
    const retired: Array<string | null | undefined> = []
    const warnings: string[] = []
    await retireVmSetupRecoveryWithConvergence('agent_owner', 'generation-a', {
      retire: async (generation) => {
        retired.push(generation)
        return { kind: 'generation-mismatch', actualLifecycleGeneration: 'generation-b' }
      },
      converge: async () => false,
      warn: (message) => warnings.push(message),
    })
    expect(retired).toEqual(['generation-a'])
    expect(warnings).toEqual(['setup retirement generation changed concurrently for agent_owner'])
  })

  test('maps durable setup recovery to its high-level owner', async () => {
    const calls: string[] = []
    const deps = {
      reconcileTracked: async (id: string) => {
        if (id.startsWith('agent_')) throw new Error('agent recovery must classify before tracked reconciliation')
        return false
      },
      ensureSquad: async (id: string) => {
        calls.push(`squad:${id}`)
      },
      classifyAgentOwner: async (id: string) =>
        id === 'missing' || id === 'terminated'
          ? { kind: 'retire' as const, lifecycleGeneration: undefined }
          : id === 'dormant'
            ? { kind: 'retire' as const, lifecycleGeneration: 'generation-a' }
            : { kind: 'live' as const, agent: { id } },
      ensureAgent: async (agent: { id: string }) => {
        calls.push(`agent:${agent.id}`)
      },
      ensureSystemManager: async (id: string) => {
        calls.push(`system:${id}`)
      },
      retireSetupRecovery: async (id: string, lifecycleGeneration?: string | null) => {
        calls.push(`stop:${id}:${lifecycleGeneration ?? 'unfenced'}`)
      },
    }
    await recoverVmSetupOwner('squad_abc', deps)
    await recoverVmSetupOwner('agent_xyz', deps)
    await recoverVmSetupOwner('system_manager_root', deps)
    await recoverVmSetupOwner('agent_tracked', deps)
    // A box whose owner is gone (deleted or terminated) is retired, not
    // re-ensured — re-ensuring throws ancestry errors on every sweep forever.
    await recoverVmSetupOwner('agent_missing', deps)
    await recoverVmSetupOwner('agent_terminated', deps)
    await recoverVmSetupOwner('agent_dormant', deps)
    expect(calls).toEqual([
      'squad:abc',
      'agent:xyz',
      'system:system_manager_root',
      'agent:tracked',
      'stop:agent_missing:unfenced',
      'stop:agent_terminated:unfenced',
      'stop:agent_dormant:generation-a',
    ])
  })

  test('a dormant classification retires only A and preserves a wake to B before stop', async () => {
    let physicalGeneration = 'generation-a'
    const retireEntered = Promise.withResolvers<void>()
    const releaseRetire = Promise.withResolvers<void>()
    const recovering = recoverVmSetupOwner('agent_race', {
      reconcileTracked: async () => {
        throw new Error('agent recovery must not use tracked state')
      },
      ensureSquad: async () => undefined,
      classifyAgentOwner: async () => ({ kind: 'retire', lifecycleGeneration: 'generation-a' }),
      ensureAgent: async () => undefined,
      ensureSystemManager: async () => undefined,
      retireSetupRecovery: async (_id, expectedGeneration) => {
        retireEntered.resolve()
        await releaseRetire.promise
        if (physicalGeneration === expectedGeneration) physicalGeneration = 'stopped'
      },
    })
    await retireEntered.promise
    physicalGeneration = 'generation-b'
    releaseRetire.resolve()
    await recovering

    expect(physicalGeneration).toBe('generation-b')
  })
})

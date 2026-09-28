import { afterEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_MACHINE_IDLE_GRACE_MS,
  isReapCandidate,
  isUnmarkedDrainCandidate,
  reapEmptyMachines,
  resolveMachineIdleGraceMs,
  type ReapEmptyMachinesDeps,
} from './machine-reaper'
import type { MachineProvider } from './provider'
import {
  bindMachineBox,
  deleteMachine as deleteMachineDb,
  getMachine as getMachineDb,
  getMachineBox,
  insertMachine,
  listMachineBoxes as listMachineBoxesDb,
  listMachines as listMachinesDb,
  MachineNotReadyError,
} from './queries'
import type { Machine, MachineBox } from './queries'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const GRACE = 10_000

/** Default shape: the canonical reap candidate — a drained packer VM. Tests
 *  override single fields to prove each exclusion. */
function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'exe-0a1b2c3d',
    provider: 'exe',
    providerRef: 'vm-ref',
    sshHost: 'vm.exe.xyz',
    sshPort: 22,
    sshUser: 'exedev',
    sshKeyId: 'exe-provider-ssh-key',
    sshPublicKey: '',
    status: 'ready',
    capabilities: { forwarding: 'yes' },
    scope: 'shared',
    purpose: 'shared',
    squadId: null,
    autoProvisioned: true,
    emptySince: new Date(NOW - GRACE - 1), // just past the grace
    egressPolicy: false,
    bootstrapVersion: null,
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as Machine
}

function makeHarness(
  machines: Machine[],
  opts: {
    /** machineId → live box count (prefilter AND the fake claim/stamp re-check). */
    boxCounts?: Record<string, number>
    /** Force the claim outcome (default: derived from boxCounts + the predicate). */
    claim?: (machineId: string, isEligible: (m: Machine) => boolean) => Promise<boolean>
    terminate?: (machine: Machine) => Promise<void>
    closeMachine?: (machine: Machine) => Promise<void>
  } = {}
) {
  const terminated: string[] = []
  const deleted: string[] = []
  const closed: string[] = []
  const claimed: string[] = []
  const restored: string[] = []
  const stamped: Array<{ machineId: string; at: Date }> = []
  const boxCount = (machineId: string) => opts.boxCounts?.[machineId] ?? 0
  const deps: ReapEmptyMachinesDeps = {
    listMachines: async () => machines,
    listMachineBoxes: async (machineId) =>
      Array.from({ length: boxCount(machineId) }, (_, i) => ({ sandboxId: `sb-${i}`, machineId }) as MachineBox),
    // Fake claim mirrors the real transaction's semantics: re-check the (fake)
    // locked row via the predicate + zero-count, then "flip" the status.
    claimMachine:
      opts.claim ??
      (async (machineId, isEligible) => {
        const machine = machines.find((m) => m.id === machineId)
        if (!machine || !isEligible(machine) || boxCount(machineId) > 0) return false
        claimed.push(machineId)
        return true
      }),
    restoreMachine: async (machineId) => {
      restored.push(machineId)
    },
    stampEmptySince: async (machineId, at) => {
      if (boxCount(machineId) > 0) return false
      stamped.push({ machineId, at })
      return true
    },
    getProvider: (key) =>
      ({
        key,
        provision: async () => {
          throw new Error('never provisions')
        },
        status: async () => 'running',
        terminate:
          opts.terminate ??
          (async (machine: Machine) => {
            terminated.push(machine.id)
          }),
      }) as MachineProvider,
    deleteMachine: async (id) => {
      deleted.push(id)
    },
    tunnels: {
      closeMachine:
        opts.closeMachine ??
        (async (machine: Machine) => {
          closed.push(machine.id)
        }),
    },
    now: () => NOW,
    graceMs: GRACE,
  }
  return { deps, terminated, deleted, closed, claimed, restored, stamped }
}

afterEach(() => {
  delete process.env.FICUS_MACHINE_IDLE_GRACE_MS
})

// ---------------------------------------------------------------------------
// Grace knob
// ---------------------------------------------------------------------------

describe('resolveMachineIdleGraceMs', () => {
  it('defaults to 10 minutes', () => {
    expect(DEFAULT_MACHINE_IDLE_GRACE_MS).toBe(10 * 60_000)
    expect(resolveMachineIdleGraceMs()).toBe(DEFAULT_MACHINE_IDLE_GRACE_MS)
  })

  it('honors a positive-int FICUS_MACHINE_IDLE_GRACE_MS and rejects invalid values', () => {
    process.env.FICUS_MACHINE_IDLE_GRACE_MS = '30000'
    expect(resolveMachineIdleGraceMs()).toBe(30_000)
    process.env.FICUS_MACHINE_IDLE_GRACE_MS = '-5'
    expect(resolveMachineIdleGraceMs()).toBe(DEFAULT_MACHINE_IDLE_GRACE_MS)
    process.env.FICUS_MACHINE_IDLE_GRACE_MS = 'soon'
    expect(resolveMachineIdleGraceMs()).toBe(DEFAULT_MACHINE_IDLE_GRACE_MS)
  })
})

// ---------------------------------------------------------------------------
// Eligibility predicates
// ---------------------------------------------------------------------------

describe('isReapCandidate', () => {
  it('accepts a ready, auto-provisioned, non-dedicated exe machine empty past the grace', () => {
    expect(isReapCandidate(makeMachine(), NOW, GRACE)).toBe(true)
  })

  it('requires empty_since to be STRICTLY older than the grace', () => {
    expect(isReapCandidate(makeMachine({ emptySince: new Date(NOW - GRACE) }), NOW, GRACE)).toBe(false)
    expect(isReapCandidate(makeMachine({ emptySince: new Date(NOW - GRACE - 1) }), NOW, GRACE)).toBe(true)
  })

  it('rejects every non-ready status except reaping (unreachable/parked/bootstrapping/registered/terminated)', () => {
    for (const status of ['unreachable', 'parked', 'bootstrapping', 'registered', 'terminated']) {
      expect(isReapCandidate(makeMachine({ status }), NOW, GRACE)).toBe(false)
    }
  })

  it("accepts 'reaping' — a claim stranded by a crashed pass is re-eligible (crash recovery)", () => {
    expect(isReapCandidate(makeMachine({ status: 'reaping' }), NOW, GRACE)).toBe(true)
  })

  it('rejects a machine that has never drained (empty_since null — the stamp pass owns those)', () => {
    expect(isReapCandidate(makeMachine({ emptySince: null }), NOW, GRACE)).toBe(false)
  })

  it('never touches dedicated machines, even drained past grace', () => {
    expect(isReapCandidate(makeMachine({ purpose: 'dedicated', scope: 'dedicated' }), NOW, GRACE)).toBe(false)
  })

  it('never touches BYO machines (provider ssh, not auto-provisioned)', () => {
    expect(
      isReapCandidate(
        makeMachine({ provider: 'ssh', autoProvisioned: false, sshPublicKey: 'ssh-ed25519 AAAA x' }),
        NOW,
        GRACE
      )
    ).toBe(false)
  })

  it('never touches a user-registered exe VM (row-identical to a packer VM except the marker)', () => {
    expect(isReapCandidate(makeMachine({ autoProvisioned: false }), NOW, GRACE)).toBe(false)
  })

  it('belt: rejects a non-exe row even if the marker is (wrongly) set', () => {
    expect(isReapCandidate(makeMachine({ provider: 'ssh' }), NOW, GRACE)).toBe(false)
  })

  it('accepts drained LEGACY squad/commons VMs (backfilled auto-provisioned)', () => {
    expect(isReapCandidate(makeMachine({ purpose: 'squad', squadId: 'sq-1' }), NOW, GRACE)).toBe(true)
    expect(isReapCandidate(makeMachine({ purpose: 'commons' }), NOW, GRACE)).toBe(true)
  })
})

describe('isUnmarkedDrainCandidate', () => {
  it('accepts a ready, auto-provisioned, non-dedicated exe machine with a null marker', () => {
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null }))).toBe(true)
  })

  it('rejects a marked machine (the grace clock is already running)', () => {
    expect(isUnmarkedDrainCandidate(makeMachine())).toBe(false)
  })

  it('rejects non-ready, non-auto-provisioned, non-exe, and dedicated machines', () => {
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null, status: 'reaping' }))).toBe(false)
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null, status: 'unreachable' }))).toBe(false)
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null, autoProvisioned: false }))).toBe(false)
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null, provider: 'ssh' }))).toBe(false)
    expect(isUnmarkedDrainCandidate(makeMachine({ emptySince: null, purpose: 'dedicated' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reapEmptyMachines (injected effects)
// ---------------------------------------------------------------------------

describe('reapEmptyMachines', () => {
  it('claims, terminates + deletes an empty auto-provisioned shared VM past the grace (and closes its tunnels)', async () => {
    const machine = makeMachine()
    const { deps, terminated, deleted, closed, claimed } = makeHarness([machine])
    await reapEmptyMachines(deps)
    expect(claimed).toEqual([machine.id])
    expect(terminated).toEqual([machine.id])
    expect(closed).toEqual([machine.id])
    expect(deleted).toEqual([machine.id])
  })

  it('keeps a machine that is empty but still within the grace', async () => {
    const machine = makeMachine({ emptySince: new Date(NOW - GRACE + 1) })
    const { deps, terminated, deleted, stamped } = makeHarness([machine])
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([])
    expect(deleted).toEqual([])
    expect(stamped).toEqual([]) // marked → the stamp pass leaves the clock alone
  })

  it('starts the idle clock on an EMPTY never-marked machine instead of terminating it', async () => {
    // Finding-2 repair: repoint-drained or provisioned-but-never-bound machines
    // arrive here ready+empty with empty_since null. This pass stamps the clock
    // (making them reap-eligible a grace later) and never terminates same-pass.
    const machine = makeMachine({ emptySince: null })
    const { deps, terminated, deleted, stamped } = makeHarness([machine])
    await reapEmptyMachines(deps)
    expect(stamped).toEqual([{ machineId: machine.id, at: new Date(NOW) }])
    expect(terminated).toEqual([])
    expect(deleted).toEqual([])
  })

  it('does not stamp a never-marked machine that hosts boxes (normal fresh VM in use)', async () => {
    const machine = makeMachine({ emptySince: null })
    const { deps, terminated, stamped } = makeHarness([machine], { boxCounts: { [machine.id]: 2 } })
    await reapEmptyMachines(deps)
    expect(stamped).toEqual([])
    expect(terminated).toEqual([])
  })

  it('never reaps or stamps dedicated, BYO, or user-registered exe machines', async () => {
    const machines = [
      makeMachine({ id: '11111111-1111-1111-1111-111111111111', purpose: 'dedicated', scope: 'dedicated' }),
      makeMachine({ id: '22222222-2222-2222-2222-222222222222', provider: 'ssh', autoProvisioned: false }),
      makeMachine({ id: '33333333-3333-3333-3333-333333333333', autoProvisioned: false }),
      makeMachine({ id: '44444444-4444-4444-4444-444444444444', autoProvisioned: false, emptySince: null }),
    ]
    const { deps, terminated, deleted, stamped } = makeHarness(machines)
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([])
    expect(deleted).toEqual([])
    expect(stamped).toEqual([])
  })

  it('belt: a box present at claim time saves the machine even with a stale empty_since', async () => {
    // A placement picked this empty-but-within-grace machine and bound onto it;
    // suppose the empty_since clear raced this pass and the row still looks
    // drained. The claim's zero-box re-check must refuse, so no terminate.
    const machine = makeMachine({ emptySince: new Date(NOW - GRACE - 60_000) })
    const { deps, terminated, deleted, claimed } = makeHarness([machine], { boxCounts: { [machine.id]: 1 } })
    await reapEmptyMachines(deps)
    expect(claimed).toEqual([])
    expect(terminated).toEqual([])
    expect(deleted).toEqual([])
  })

  it('a lost claim (bind won the row lock) skips the machine without touching the provider', async () => {
    const machine = makeMachine()
    const { deps, terminated, deleted } = makeHarness([machine], {
      claim: async () => false, // simulate: a bind committed between snapshot and claim
    })
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([])
    expect(deleted).toEqual([])
  })

  it("re-claims and reaps a stale 'reaping' machine (crashed pass) — never stranded", async () => {
    const stale = makeMachine({ status: 'reaping' })
    const { deps, terminated, deleted, claimed } = makeHarness([stale])
    await reapEmptyMachines(deps)
    expect(claimed).toEqual([stale.id])
    expect(terminated).toEqual([stale.id])
    expect(deleted).toEqual([stale.id])
  })

  it('reaps a drained legacy squad VM (backfilled marker) — the pre-packer fleet shrinks', async () => {
    const legacy = makeMachine({ name: 'exe-sq-old', purpose: 'squad', squadId: 'sq-old' })
    const { deps, terminated, deleted } = makeHarness([legacy])
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([legacy.id])
    expect(deleted).toEqual([legacy.id])
  })

  it("one machine's failed terminate restores its claim, keeps its row, and does not block the sweep", async () => {
    const bad = makeMachine({ id: '11111111-1111-1111-1111-111111111111', name: 'exe-bad' })
    const good = makeMachine({ id: '22222222-2222-2222-2222-222222222222', name: 'exe-good' })
    const terminated: string[] = []
    const { deps, deleted, restored } = makeHarness([bad, good], {
      terminate: async (machine) => {
        if (machine.id === bad.id) throw new Error('provider exploded')
        terminated.push(machine.id)
      },
    })
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([good.id])
    // The failed machine's claim is rolled back to 'ready' (binds may land again;
    // next pass retries) and only the successfully terminated VM's row is deleted.
    expect(restored).toEqual([bad.id])
    expect(deleted).toEqual([good.id])
  })

  it('a failed tunnel close is best-effort: the row is still deleted after a successful terminate', async () => {
    const machine = makeMachine()
    const { deps, terminated, deleted } = makeHarness([machine], {
      closeMachine: async () => {
        throw new Error('no master to close')
      },
    })
    await reapEmptyMachines(deps)
    expect(terminated).toEqual([machine.id])
    expect(deleted).toEqual([machine.id])
  })
})

// ---------------------------------------------------------------------------
// DB-backed integration: the real claim/stamp transactions under the reaper
// ---------------------------------------------------------------------------

describe('reapEmptyMachines (integration: real claim/stamp/bind against the DB)', () => {
  const prefix = `reaptest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  function exeMachineValues(name: string, overrides: Record<string, unknown> = {}) {
    return {
      name: `${prefix}-${name}`,
      provider: 'exe',
      providerRef: `ref-${name}`,
      sshHost: 'vm.exe.xyz',
      sshUser: 'exedev',
      sshKeyId: 'exe-provider-ssh-key',
      sshPublicKey: '',
      status: 'ready',
      autoProvisioned: true,
      ...overrides,
    }
  }

  async function cleanup() {
    const all = await listMachinesDb()
    for (const m of all) {
      if (m.name.startsWith(prefix)) await deleteMachineDb(m.id)
    }
  }
  afterEach(cleanup)

  /** Real-queries deps: only the fleet listing is scoped to this test's rows and
   *  the provider/tunnel effects are recorded fakes; claim, stamp, restore, and
   *  the row delete are the production implementations. */
  function integrationDeps(opts: { nowMs: number; terminate?: (m: Machine) => Promise<void> }) {
    const terminated: string[] = []
    const deps: ReapEmptyMachinesDeps = {
      listMachines: async () => (await listMachinesDb()).filter((m) => m.name.startsWith(prefix)),
      getProvider: () =>
        ({
          key: 'exe',
          provision: async () => {
            throw new Error('never provisions')
          },
          status: async () => 'running',
          terminate:
            opts.terminate ??
            (async (machine: Machine) => {
              terminated.push(machine.id)
            }),
        }) as MachineProvider,
      tunnels: { closeMachine: async () => {} },
      now: () => opts.nowMs,
      graceMs: GRACE,
    }
    return { deps, terminated }
  }

  it('Finding 2a: a repoint-drained machine is stamped, then reaped a grace later', async () => {
    const oldMachine = await insertMachine(exeMachineValues('repoint-old'))
    const newMachine = await insertMachine(exeMachineValues('repoint-new'))
    const sandboxId = `${prefix}-box`
    await bindMachineBox({ sandboxId, machineId: oldMachine.id, unixUser: 'box' })
    // The re-place path repoints the row (no deleteMachineBox for oldMachine).
    await bindMachineBox({ sandboxId, machineId: newMachine.id, unixUser: 'box' })
    expect((await getMachineDb(oldMachine.id))?.emptySince).toBeNull()

    // Pass 1 (t0): stamps the old machine's clock, terminates nothing.
    const t0 = Date.now()
    const pass1 = integrationDeps({ nowMs: t0 })
    await reapEmptyMachines(pass1.deps)
    expect(pass1.terminated).toEqual([])
    const stampedRow = await getMachineDb(oldMachine.id)
    expect(stampedRow?.emptySince?.getTime()).toBe(t0)
    // The new machine hosts the box → untouched.
    expect((await getMachineDb(newMachine.id))?.emptySince).toBeNull()

    // Pass 2 (t0 + grace + 1): the old machine is reaped; the new one survives.
    const pass2 = integrationDeps({ nowMs: t0 + GRACE + 1 })
    await reapEmptyMachines(pass2.deps)
    expect(pass2.terminated).toEqual([oldMachine.id])
    expect(await getMachineDb(oldMachine.id)).toBeNull()
    expect((await getMachineDb(newMachine.id))?.status).toBe('ready')
    expect(await getMachineBox(sandboxId)).not.toBeNull()
  })

  it('Finding 2b: a provisioned-but-never-bound machine is stamped, then reaped a grace later', async () => {
    const orphan = await insertMachine(exeMachineValues('never-bound'))
    expect(orphan.emptySince).toBeNull()

    const t0 = Date.now()
    const pass1 = integrationDeps({ nowMs: t0 })
    await reapEmptyMachines(pass1.deps)
    expect(pass1.terminated).toEqual([])
    expect((await getMachineDb(orphan.id))?.emptySince?.getTime()).toBe(t0)

    const pass2 = integrationDeps({ nowMs: t0 + GRACE + 1 })
    await reapEmptyMachines(pass2.deps)
    expect(pass2.terminated).toEqual([orphan.id])
    expect(await getMachineDb(orphan.id)).toBeNull()
  })

  it("recovery: a stale 'reaping' machine (crashed pass) is re-claimed and reaped, not stranded", async () => {
    const stale = await insertMachine(
      exeMachineValues('stale-reaping', {
        status: 'reaping',
        emptySince: new Date(Date.now() - GRACE - 60_000),
      })
    )

    const pass = integrationDeps({ nowMs: Date.now() })
    await reapEmptyMachines(pass.deps)
    expect(pass.terminated).toEqual([stale.id])
    expect(await getMachineDb(stale.id)).toBeNull()
  })

  it('a failed terminate rolls the claim back to ready (row kept for retry)', async () => {
    const machine = await insertMachine(
      exeMachineValues('term-fail', { emptySince: new Date(Date.now() - GRACE - 60_000) })
    )
    const pass = integrationDeps({
      nowMs: Date.now(),
      terminate: async () => {
        throw new Error('provider exploded')
      },
    })
    await reapEmptyMachines(pass.deps)
    const row = await getMachineDb(machine.id)
    expect(row?.status).toBe('ready') // restored — binds may land again
    expect(row?.emptySince).toBeInstanceOf(Date) // clock kept; next pass retries
  })

  it('reap-vs-bind race: a bind concurrent with the pass either aborts the reap or is rejected — never a terminated VM with a live box', async () => {
    for (let i = 0; i < 3; i++) {
      const machine = await insertMachine(
        exeMachineValues(`race-${i}`, { emptySince: new Date(Date.now() - GRACE - 60_000) })
      )
      const pass = integrationDeps({ nowMs: Date.now() })
      const [, bindRes] = await Promise.allSettled([
        reapEmptyMachines(pass.deps),
        bindMachineBox({ sandboxId: `${prefix}-race-${i}`, machineId: machine.id, unixUser: 'box' }),
      ])

      const terminatedThis = pass.terminated.includes(machine.id)
      if (bindRes.status === 'fulfilled') {
        // The bind won: the machine must NOT have been terminated and still hosts the box.
        expect(terminatedThis).toBe(false)
        expect((await listMachineBoxesDb(machine.id)).length).toBe(1)
        expect((await getMachineDb(machine.id))?.status).toBe('ready')
      } else {
        // The claim won: the bind was rejected loudly (re-placeable) and the VM
        // was terminated with zero boxes.
        expect(bindRes.reason).toBeInstanceOf(MachineNotReadyError)
        expect(terminatedThis).toBe(true)
        expect(await getMachineDb(machine.id)).toBeNull()
      }
    }
  })
})

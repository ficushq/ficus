import { afterEach, describe, expect, it } from 'bun:test'
import type { MigrateResult } from './box-migrate'
import type { Machine } from './queries'
import { planRebalance, rebalanceFleet, RebalanceInProgressError, type RebalanceDeps } from './rebalance'

// ---------------------------------------------------------------------------
// Fakes (same shapes as placement.test.ts)
// ---------------------------------------------------------------------------

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'm-test',
    provider: 'exe',
    providerRef: null,
    sshHost: '10.0.0.5',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: 'secret-key',
    sshPublicKey: '',
    status: 'ready',
    capabilities: { forwarding: 'yes' },
    scope: 'shared',
    purpose: 'shared',
    squadId: null,
    autoProvisioned: true,
    emptySince: null,
    egressPolicy: false,
    bootstrapVersion: null,
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as Machine
}

/** N agent sandboxIds, deterministic (`agent_<prefix>01` ...). */
function agents(n: number, prefix = 'a'): string[] {
  return Array.from({ length: n }, (_, i) => `agent_${prefix}${String(i + 1).padStart(2, '0')}`)
}

/**
 * Fake deps around an in-memory fleet snapshot. Records every migrateBox and
 * provisionMachine call so tests can assert exactly what the loop executed
 * (and that dry runs / pure planning execute NOTHING).
 */
function makeDeps(fleet: Array<{ machine: Machine; boxSandboxIds: string[] }>, overrides: Partial<RebalanceDeps> = {}) {
  const migrations: Array<{ sandboxId: string; targetMachineId: string }> = []
  const provisioned: Machine[] = []
  const deps: RebalanceDeps = {
    isVmRuntime: () => true,
    queryReadyMachineLoads: async () => fleet,
    countMachines: async () => fleet.length + provisioned.length,
    maxMachines: 50,
    provisionMachine: async (opts) => {
      const machine = makeMachine({
        id: `prov-${provisioned.length}`,
        name: opts.name,
        purpose: opts.purpose,
        scope: opts.scope ?? 'shared',
        createdAt: new Date('2021-01-01T00:00:00Z'),
      })
      provisioned.push(machine)
      return machine
    },
    migrateBox: async (sandboxId: string, targetMachineId: string): Promise<MigrateResult> => {
      migrations.push({ sandboxId, targetMachineId })
      return { moved: true }
    },
    ...overrides,
  }
  return { deps, migrations, provisioned }
}

afterEach(() => {
  delete process.env.FICUS_UNIT_WEIGHT_SQUAD
  delete process.env.FICUS_UNIT_WEIGHT_AGENT
  delete process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER
  delete process.env.FICUS_MACHINE_UNIT_CAPACITY
})

// ---------------------------------------------------------------------------
// planRebalance
// ---------------------------------------------------------------------------

describe('planRebalance', () => {
  it('throws off the VM runtime', async () => {
    const { deps } = makeDeps([])
    await expect(planRebalance({ ...deps, isVmRuntime: () => false })).rejects.toThrow(/VM sandbox runtime/)
  })

  it('moves the agent — never the squad — off a squad VM with a co-tenant', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps, migrations, provisioned } = makeDeps([
      { machine: m1, boxSandboxIds: ['squad_s1', 'agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves).toEqual([{ sandboxId: 'agent_a01', fromMachineId: 'm1', toMachineId: 'm2' }])
    expect(plan.unplaceable).toEqual([])
    expect(plan.skippedActive).toEqual([])
    expect(plan.unresolvable).toEqual([])
    // Pure planning: nothing was migrated or provisioned.
    expect(migrations).toEqual([])
    expect(provisioned).toEqual([])
  })

  it('evacuates exactly one agent off an over-packed pool VM (11 agents, capacity 10)', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: agents(11) },
      { machine: m2, boxSandboxIds: agents(5, 'b') },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(1)
    expect(plan.moves[0].fromMachineId).toBe('m1')
    expect(plan.moves[0].toMachineId).toBe('m2')
    expect(plan.unplaceable).toEqual([])
  })

  it('returns an empty plan for a balanced fleet (idempotent no-op)', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const m3 = makeMachine({ id: 'm3', createdAt: new Date('2020-01-03T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: ['squad_s1'] }, // squad alone: exclusive, full — fine
      { machine: m2, boxSandboxIds: agents(10) }, // at capacity, not over
      { machine: m3, boxSandboxIds: agents(3, 'c') },
    ])

    const plan = await planRebalance(deps)

    expect(plan).toEqual({ moves: [], skippedActive: [], unplaceable: [], unresolvable: [] })
  })

  it('never targets a squad VM, even one with free unit capacity', async () => {
    // Shrink the squad weight so the squad VM has free room the packer's
    // arithmetic would otherwise accept — exclusivity must still exclude it.
    process.env.FICUS_UNIT_WEIGHT_SQUAD = '5'
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: agents(11) },
      { machine: m2, boxSandboxIds: ['squad_s1'] }, // used 5, free 5 — but squad-exclusive
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(1)
    expect(plan.moves[0].toMachineId).toBe('provision:0')
  })

  it('marks the evacuee unplaceable when nothing fits and the fleet cap is reached', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const { deps } = makeDeps([{ machine: m1, boxSandboxIds: agents(11) }], { maxMachines: 1 })

    const plan = await planRebalance(deps)

    expect(plan.moves).toEqual([])
    expect(plan.unplaceable.length).toBe(1)
    expect(plan.unplaceable[0]).toMatch(/^agent_/)
  })

  it('accounts for virtually-assigned evacuees: a target VM fills up as the plan assigns to it', async () => {
    // m1 must shed 3 units; m2 has room for only 2 — the third goes to provision.
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: agents(13) },
      { machine: m2, boxSandboxIds: agents(8, 'b') },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(3)
    expect(plan.moves.filter((m) => m.toMachineId === 'm2').length).toBe(2)
    expect(plan.moves.filter((m) => m.toMachineId === 'provision:0').length).toBe(1)
    expect(plan.unplaceable).toEqual([])
  })

  it('consolidates within a tight cap: 2 evacuees share ONE planned provision', async () => {
    // 2 evacuees, no existing target, room for exactly ONE more machine: both
    // pack onto the same virtual new VM — nothing is unplaceable (before
    // provision-group consolidation the second would have been).
    const m1 = makeMachine({ id: 'm1' })
    const { deps } = makeDeps([{ machine: m1, boxSandboxIds: agents(12) }], { maxMachines: 2 })

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(2)
    expect(plan.moves.every((m) => m.toMachineId === 'provision:0')).toBe(true)
    expect(plan.unplaceable).toEqual([])
  })

  it('evacuates the LIGHTEST box when only one needs to move (agent over system-manager)', async () => {
    // system-manager weighs 2, agents 1: Σ = 2 + 9 = 11 > 10 — shedding ONE
    // agent (weight 1) suffices; the heavier system-manager must stay put.
    process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER = '2'
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: ['system_manager_sm1', ...agents(9)] },
      { machine: m2, boxSandboxIds: agents(3, 'b') },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(1)
    expect(plan.moves[0].sandboxId).toMatch(/^agent_/)
    expect(plan.moves[0].toMachineId).toBe('m2')
  })

  it('leaves a lone over-weight non-squad box alone (no move, no churn, no unplaceable)', async () => {
    // Weight 15 > capacity 10: the packer tolerates this by giving the box its
    // own VM — evacuating it to a fresh VM would reproduce the violation forever.
    process.env.FICUS_UNIT_WEIGHT_AGENT = '15'
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: ['agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const plan = await planRebalance(deps)

    expect(plan).toEqual({ moves: [], skippedActive: [], unplaceable: [], unresolvable: [] })
  })

  it('stops shedding at a lone over-weight remainder instead of pointlessly evacuating it', async () => {
    // system-manager weighs 15 (> capacity): moving the weight-1 agent is the
    // only useful move — the remaining lone system-manager is the packer's
    // tolerated own-VM configuration, not an evacuee and not unresolvable.
    process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER = '15'
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: ['system_manager_sm1', 'agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves).toEqual([{ sandboxId: 'agent_a01', fromMachineId: 'm1', toMachineId: 'm2' }])
    expect(plan.unplaceable).toEqual([])
    expect(plan.unresolvable).toEqual([])
  })

  it('consolidates provision evacuees onto the FEWEST virtual new VMs (13 → 2, not 13)', async () => {
    // Squad exclusivity evicts all 13 agents; no existing VM can take any.
    // They must pack onto ceil(13/10) = 2 planned new VMs, not 13 one-box VMs.
    const m1 = makeMachine({ id: 'm1' })
    const { deps } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1', ...agents(13)] }])

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(13)
    expect(plan.unplaceable).toEqual([])
    const targets = new Set(plan.moves.map((m) => m.toMachineId))
    expect([...targets].sort()).toEqual(['provision:0', 'provision:1'])
    expect(plan.moves.filter((m) => m.toMachineId === 'provision:0').length).toBe(10)
    expect(plan.moves.filter((m) => m.toMachineId === 'provision:1').length).toBe(3)
  })

  it('counts each virtual new VM once against the cap: overflow evacuees are unplaceable', async () => {
    // Room for exactly ONE more machine: one provision group fills to capacity
    // (10 moves), the remaining 3 evacuees are unplaceable.
    const m1 = makeMachine({ id: 'm1' })
    const { deps } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1', ...agents(13)] }], { maxMachines: 2 })

    const plan = await planRebalance(deps)

    expect(plan.moves.length).toBe(10)
    expect(plan.moves.every((m) => m.toMachineId === 'provision:0')).toBe(true)
    expect(plan.unplaceable.length).toBe(3)
  })

  it('surfaces a VM with two squad boxes as unresolvable (no move can fix it)', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps([
      { machine: m1, boxSandboxIds: ['squad_s1', 'squad_s2'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const plan = await planRebalance(deps)

    expect(plan.moves).toEqual([])
    expect(plan.unplaceable).toEqual([])
    expect(plan.unresolvable).toEqual(['m1'])
  })

  it('surfaces a lone over-weight squad as unresolvable', async () => {
    process.env.FICUS_UNIT_WEIGHT_SQUAD = '15'
    const m1 = makeMachine({ id: 'm1' })
    const { deps } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1'] }])

    const plan = await planRebalance(deps)

    expect(plan.moves).toEqual([])
    expect(plan.unresolvable).toEqual(['m1'])
  })

  it('orders a machine`s outbound moves before its inbound moves', async () => {
    // m2 both sheds (a system-manager to m3) and receives (an agent from m1):
    // its outbound move must execute first, or m2 is transiently over capacity.
    process.env.FICUS_UNIT_WEIGHT_SYSTEM_MANAGER = '3'
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const m3 = makeMachine({ id: 'm3', createdAt: new Date('2020-01-03T00:00:00Z') })
    const sms = ['system_manager_b1', 'system_manager_b2', 'system_manager_b3', 'system_manager_b4']
    const { deps, migrations } = makeDeps([
      { machine: m1, boxSandboxIds: agents(11) }, // 11 > 10: sheds one agent → m2 (best fit, free 1)
      { machine: m2, boxSandboxIds: sms }, // 12 > 10: sheds one sm → m3
      { machine: m3, boxSandboxIds: [] },
    ])

    const out = await rebalanceFleet({}, deps)

    expect(out.moves.length).toBe(2)
    // m2's outbound (sm → m3) is ordered before m2's inbound (agent → m2).
    expect(out.moves[0]).toEqual({ sandboxId: 'system_manager_b1', fromMachineId: 'm2', toMachineId: 'm3' })
    expect(out.moves[1].sandboxId).toMatch(/^agent_/)
    expect(out.moves[1].toMachineId).toBe('m2')
    expect(migrations.map((m) => m.sandboxId)).toEqual(out.moves.map((m) => m.sandboxId))
  })
})

// ---------------------------------------------------------------------------
// rebalanceFleet
// ---------------------------------------------------------------------------

describe('rebalanceFleet', () => {
  it('dryRun returns the plan and executes nothing', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps, migrations, provisioned } = makeDeps([
      { machine: m1, boxSandboxIds: ['squad_s1', 'agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const out = await rebalanceFleet({ dryRun: true }, deps)

    expect(out.moves.length).toBe(1)
    expect(out.results).toEqual([])
    expect(migrations).toEqual([])
    expect(provisioned).toEqual([])
  })

  it('executes the plan: migrates each move sequentially to its target', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps, migrations } = makeDeps([
      { machine: m1, boxSandboxIds: ['squad_s1', 'agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ])

    const out = await rebalanceFleet({}, deps)

    expect(migrations).toEqual([{ sandboxId: 'agent_a01', targetMachineId: 'm2' }])
    // A move to an existing VM stamps that VM's id as the resolved target.
    expect(out.results).toEqual([{ sandboxId: 'agent_a01', result: { moved: true }, targetMachineId: 'm2' }])
    expect(out.skippedActive).toEqual([])
  })

  it('resolves provision moves to a freshly provisioned machine before migrating', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps, migrations, provisioned } = makeDeps([
      { machine: m1, boxSandboxIds: agents(13) },
      { machine: m2, boxSandboxIds: agents(8, 'b') },
    ])

    const out = await rebalanceFleet({}, deps)

    expect(out.results.length).toBe(3)
    expect(provisioned.length).toBe(1)
    expect(provisioned[0].purpose).toBe('shared')
    expect(provisioned[0].scope).toBe('shared')
    expect(migrations.length).toBe(3)
    // The provision move was migrated onto the machine actually provisioned.
    const provisionTargets = migrations.filter((m) => m.targetMachineId === provisioned[0].id)
    expect(provisionTargets.length).toBe(1)
  })

  it('stamps provision-group results with the REAL provisioned machine id, never the placeholder', async () => {
    // 13 evacuees across 2 provision groups: every executed result must carry
    // the id of the machine its group actually provisioned (so an operator can
    // tell which real VM got the box), never a `provision:<n>` placeholder.
    const m1 = makeMachine({ id: 'm1' })
    const { deps, provisioned } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1', ...agents(13)] }])

    const out = await rebalanceFleet({}, deps)

    expect(provisioned.length).toBe(2)
    expect(out.results.length).toBe(13)
    for (const r of out.results) {
      expect(r.targetMachineId).toBeDefined()
      expect(r.targetMachineId!.startsWith('provision:')).toBe(false)
    }
    expect(out.results.filter((r) => r.targetMachineId === provisioned[0].id).length).toBe(10)
    expect(out.results.filter((r) => r.targetMachineId === provisioned[1].id).length).toBe(3)
  })

  it('provisions ONE machine per provision group and packs the group onto it', async () => {
    // 13 evacuees, 2 provision groups → exactly 2 machines provisioned (not 13),
    // 10 migrations onto the first and 3 onto the second.
    const m1 = makeMachine({ id: 'm1' })
    const { deps, migrations, provisioned } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1', ...agents(13)] }])

    const out = await rebalanceFleet({}, deps)

    expect(provisioned.length).toBe(2)
    expect(migrations.length).toBe(13)
    expect(migrations.filter((m) => m.targetMachineId === provisioned[0].id).length).toBe(10)
    expect(migrations.filter((m) => m.targetMachineId === provisioned[1].id).length).toBe(3)
    expect(out.results.every((r) => r.result.moved)).toBe(true)
  })

  it('fails a whole provision group when its provisioning throws, and continues to the next group', async () => {
    const m1 = makeMachine({ id: 'm1' })
    let provisionCalls = 0
    const { deps, migrations, provisioned } = makeDeps([{ machine: m1, boxSandboxIds: ['squad_s1', ...agents(13)] }])
    const innerProvision = deps.provisionMachine!
    deps.provisionMachine = async (opts) => {
      provisionCalls++
      if (provisionCalls === 1) throw new Error('exe.dev is down')
      return innerProvision(opts)
    }

    const out = await rebalanceFleet({}, deps)

    // Group 0's provision failed once (not retried per move): its 10 evacuees are
    // recorded failed; group 1 still provisioned and migrated its 3.
    expect(provisionCalls).toBe(2)
    expect(provisioned.length).toBe(1)
    expect(migrations.length).toBe(3)
    expect(out.results.length).toBe(13)
    const failed = out.results.filter((r) => !r.result.moved)
    expect(failed.length).toBe(10)
    expect(failed.every((r) => r.result.reason === 'provision-failed')).toBe(true)
    // No machine exists for the failed group, so there is no target to stamp.
    expect(failed.every((r) => r.targetMachineId === undefined)).toBe(true)
  })

  it('folds an active-turn migrate result into skippedActive', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    const { deps } = makeDeps(
      [
        { machine: m1, boxSandboxIds: ['squad_s1', 'agent_a01'] },
        { machine: m2, boxSandboxIds: [] },
      ],
      { migrateBox: async (): Promise<MigrateResult> => ({ moved: false, reason: 'active-turn' }) }
    )

    const out = await rebalanceFleet({}, deps)

    expect(out.skippedActive).toEqual(['agent_a01'])
    expect(out.results).toEqual([
      { sandboxId: 'agent_a01', result: { moved: false, reason: 'active-turn' }, targetMachineId: 'm2' },
    ])
  })

  it('continues past a single migrateBox failure and still attempts the other moves', async () => {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    let calls = 0
    const attempted: string[] = []
    const { deps } = makeDeps(
      [
        { machine: m1, boxSandboxIds: agents(12) },
        { machine: m2, boxSandboxIds: agents(5, 'b') },
      ],
      {
        migrateBox: async (sandboxId: string): Promise<MigrateResult> => {
          attempted.push(sandboxId)
          calls++
          if (calls === 1) throw new Error('ssh exploded')
          return { moved: true }
        },
      }
    )

    const out = await rebalanceFleet({}, deps)

    expect(attempted.length).toBe(2)
    expect(out.results.length).toBe(2)
    // A thrown migrate is a generic 'failed' — NOT 'provision-failed' (nothing
    // was provisioned; mislabeling would point operators at the wrong subsystem).
    expect(out.results[0].result).toEqual({ moved: false, reason: 'failed' })
    expect(out.results[1].result).toEqual({ moved: true })
  })
})

// ---------------------------------------------------------------------------
// rebalanceFleet — execute single-flight (in-process guard)
// ---------------------------------------------------------------------------

describe('rebalanceFleet single-flight', () => {
  /** Fresh two-VM fleet with exactly one planned move (agent off the squad VM). */
  function oneMoveFleet() {
    const m1 = makeMachine({ id: 'm1' })
    const m2 = makeMachine({ id: 'm2', createdAt: new Date('2020-01-02T00:00:00Z') })
    return [
      { machine: m1, boxSandboxIds: ['squad_s1', 'agent_a01'] },
      { machine: m2, boxSandboxIds: [] },
    ]
  }

  it('rejects a second execute while one is in flight; dry-run stays allowed; guard clears after', async () => {
    // Hold the first execute mid-migrate so it is provably "in flight".
    let release!: (r: MigrateResult) => void
    const gate = new Promise<MigrateResult>((resolve) => {
      release = resolve
    })
    const { deps } = makeDeps(oneMoveFleet(), { migrateBox: () => gate })
    const first = rebalanceFleet({}, deps)

    // A concurrent EXECUTE would double-provision billed VMs — refused fast.
    await expect(rebalanceFleet({}, makeDeps(oneMoveFleet()).deps)).rejects.toThrow(RebalanceInProgressError)

    // A dry run is read-only and must NOT be blocked by the guard.
    const dry = await rebalanceFleet({ dryRun: true }, makeDeps(oneMoveFleet()).deps)
    expect(dry.moves.length).toBe(1)
    expect(dry.results).toEqual([])

    release({ moved: true })
    const out = await first
    expect(out.results).toEqual([{ sandboxId: 'agent_a01', result: { moved: true }, targetMachineId: 'm2' }])

    // The guard cleared on completion: a fresh execute proceeds.
    const { deps: freshDeps, migrations } = makeDeps(oneMoveFleet())
    await rebalanceFleet({}, freshDeps)
    expect(migrations.length).toBe(1)
  })

  it('clears the guard when an execute throws (finally), so the next execute proceeds', async () => {
    const { deps } = makeDeps(oneMoveFleet(), {
      queryReadyMachineLoads: async () => {
        throw new Error('db exploded')
      },
    })
    await expect(rebalanceFleet({}, deps)).rejects.toThrow('db exploded')

    const { deps: freshDeps, migrations } = makeDeps(oneMoveFleet())
    await rebalanceFleet({}, freshDeps)
    expect(migrations.length).toBe(1)
  })
})

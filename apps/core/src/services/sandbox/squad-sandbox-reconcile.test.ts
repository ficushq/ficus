import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Squad } from '../../entities/Squad'
import * as factory from './factory'
import type { ISandboxManager, SandboxOptions } from './types'
import { reconcileSquadSandboxSpecs } from './squad-sandbox-reconcile'
import { WorkspaceDotDirConflictError } from '../workspace/dot-dir'

type TestSquad = Pick<Squad, 'id'>

function logger() {
  return { info: () => {}, warn: () => {} }
}

interface ManagerStub {
  /** Map of sandboxId -> durable running spec hash (null = absent on an old box). */
  running: Record<string, string | null>
  /** Map of squadId -> desired spec hash. */
  desired: Record<string, string>
  recreated: string[]
}

function makeManager(stub: ManagerStub): ISandboxManager {
  return {
    computeSpecHash: (opts: SandboxOptions) => stub.desired[(opts.k8s as any).squadId],
    getRunningSandboxSpecHash: async (sandboxId: string) => stub.running[sandboxId] ?? null,
    recreateSandbox: async (sandboxId: string) => {
      stub.recreated.push(sandboxId)
      return sandboxId
    },
  } as unknown as ISandboxManager
}

// buildOptions stashes the squadId so the stubbed computeSpecHash can look up
// the desired hash for that squad.
const buildOptions = (squad: { id: string }): SandboxOptions =>
  ({ workspacePath: `/ws/${squad.id}`, k8s: { squadId: squad.id } }) as unknown as SandboxOptions

describe('reconcileSquadSandboxSpecs', () => {
  let listSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    listSpy?.mockRestore()
    listSpy = undefined
  })

  function mockSquadList(squads: TestSquad[]): TestSquad[] {
    listSpy = spyOn(Squad, 'list').mockResolvedValue(squads as Squad[])
    return squads
  }

  test('a squad whose workspace dot dir needs a manual fix is skipped; the squads around it are still reconciled', async () => {
    const squads = mockSquadList([{ id: 'sq1' }, { id: 'sq2' }, { id: 'sq3' }])
    const stub: ManagerStub = {
      running: { [Squad.getSandboxId('sq1')]: 'OLD', [Squad.getSandboxId('sq3')]: 'OLD' },
      desired: { sq1: 'NEW', sq3: 'NEW' },
      recreated: [],
    }
    const warnings: string[] = []

    await expect(
      reconcileSquadSandboxSpecs(
        { info: () => {}, warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) },
        {
          manager: makeManager(stub),
          buildOptions: (squad) => {
            if (squad.id === 'sq2') throw new WorkspaceDotDirConflictError('/home/w/sq2', 'both-present')
            return buildOptions(squad)
          },
          isIdle: async () => true,
        }
      )
    ).resolves.toBeUndefined()

    expect(stub.recreated.sort()).toEqual([Squad.getSandboxId('sq1'), Squad.getSandboxId('sq3')].sort())
    expect(warnings).toEqual([
      `Sandbox spec reconcile skipped for squad sq2: ${new WorkspaceDotDirConflictError('/home/w/sq2', 'both-present').message}`,
    ])
    expect(squads.length).toBe(3)
  })

  test('recreates a drifted sandbox when the squad is idle', async () => {
    const squads = mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: 'OLD' }, desired: { sq1: 'NEW' }, recreated: [] }

    await reconcileSquadSandboxSpecs(logger(), {
      manager: makeManager(stub),
      buildOptions,
      isIdle: async () => true,
    })

    expect(stub.recreated).toEqual([sandboxId])
    expect(squads.length).toBe(1)
  })

  // Perf: the vm lifecycle tick fetches the active squads once and shares the
  // array with the squad warmup — this step must consume it instead of running
  // its own identical `Squad.list` a second time in the same tick.
  test('uses squads passed in by the caller without touching Squad.list', async () => {
    const listSpy2 = spyOn(Squad, 'list')
    try {
      const sandboxId = Squad.getSandboxId('sq1')
      const stub: ManagerStub = { running: { [sandboxId]: 'OLD' }, desired: { sq1: 'NEW' }, recreated: [] }

      await reconcileSquadSandboxSpecs(logger(), {
        manager: makeManager(stub),
        buildOptions,
        isIdle: async () => true,
        squads: [{ id: 'sq1' }] as Squad[],
      })

      expect(stub.recreated).toEqual([sandboxId])
      expect(listSpy2).not.toHaveBeenCalled()
    } finally {
      listSpy2.mockRestore()
    }
  })

  test('does not recreate when the spec is up to date', async () => {
    mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: 'SAME' }, desired: { sq1: 'SAME' }, recreated: [] }

    await reconcileSquadSandboxSpecs(logger(), { manager: makeManager(stub), buildOptions, isIdle: async () => true })

    expect(stub.recreated).toEqual([])
  })

  test('does not recreate a drifted sandbox while the squad is busy', async () => {
    mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: 'OLD' }, desired: { sq1: 'NEW' }, recreated: [] }

    await reconcileSquadSandboxSpecs(logger(), { manager: makeManager(stub), buildOptions, isIdle: async () => false })

    expect(stub.recreated).toEqual([])
  })

  test('recreates an idle ready VM box with a null durable hash', async () => {
    mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: null }, desired: { sq1: 'NEW' }, recreated: [] }

    await reconcileSquadSandboxSpecs(logger(), { manager: makeManager(stub), buildOptions, isIdle: async () => true })

    expect(stub.recreated).toEqual([sandboxId])
  })

  test('defers a ready VM box with a null durable hash while the squad is active', async () => {
    mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: null }, desired: { sq1: 'NEW' }, recreated: [] }

    await reconcileSquadSandboxSpecs(logger(), { manager: makeManager(stub), buildOptions, isIdle: async () => false })

    expect(stub.recreated).toEqual([])
  })

  test('reconciles only the drifted, idle squads in a mixed set', async () => {
    const squads = mockSquadList([{ id: 'drift-idle' }, { id: 'drift-busy' }, { id: 'fresh' }, { id: 'nopod' }])
    const id = (s: string) => Squad.getSandboxId(s)
    const stub: ManagerStub = {
      running: {
        [id('drift-idle')]: 'OLD',
        [id('drift-busy')]: 'OLD',
        [id('fresh')]: 'NEW',
        [id('nopod')]: null,
      },
      desired: { 'drift-idle': 'NEW', 'drift-busy': 'NEW', fresh: 'NEW', nopod: 'NEW' },
      recreated: [],
    }

    await reconcileSquadSandboxSpecs(logger(), {
      manager: makeManager(stub),
      buildOptions,
      isIdle: async (squad) => squad.id !== 'drift-busy',
    })

    expect(stub.recreated).toEqual([id('drift-idle'), id('nopod')])
    expect(squads.length).toBe(4)
  })

  test('continues when one recreate fails', async () => {
    mockSquadList([{ id: 'bad' }, { id: 'good' }])
    const id = (s: string) => Squad.getSandboxId(s)
    const stub: ManagerStub = {
      running: { [id('bad')]: 'OLD', [id('good')]: 'OLD' },
      desired: { bad: 'NEW', good: 'NEW' },
      recreated: [],
    }
    const manager = makeManager(stub)
    const realRecreate = manager.recreateSandbox!
    manager.recreateSandbox = mock(async (sandboxId: string, opts: SandboxOptions) => {
      if (sandboxId === id('bad')) throw new Error('boom')
      return realRecreate(sandboxId, opts)
    })

    await reconcileSquadSandboxSpecs(logger(), { manager, buildOptions, isIdle: async () => true })

    expect(stub.recreated).toEqual([id('good')])
  })

  test('(vm runtime) reaches the runtime sandbox manager when none is injected', async () => {
    // vm is a remote runtime whose VmSandboxManager implements the drift methods,
    // so the proactive reconciler must reach it via the runtime gate — not skip it
    // (the old isK8sRuntime() gate left vm always-on squads without drift repair).
    const squads = mockSquadList([{ id: 'sq1' }])
    const sandboxId = Squad.getSandboxId('sq1')
    const stub: ManagerStub = { running: { [sandboxId]: 'OLD' }, desired: { sq1: 'NEW' }, recreated: [] }

    const remoteSpy = spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(true)
    const mgrSpy = spyOn(factory, 'getSandboxManager').mockReturnValue(makeManager(stub))
    try {
      // No manager injected → the gate must consult getSandboxManager for vm.
      await reconcileSquadSandboxSpecs(logger(), { buildOptions, isIdle: async () => true })
      expect(mgrSpy).toHaveBeenCalled()
      expect(stub.recreated).toEqual([sandboxId])
      expect(squads.length).toBe(1)
    } finally {
      remoteSpy.mockRestore()
      mgrSpy.mockRestore()
    }
  })

  test('no-ops when the manager lacks reconciliation support', async () => {
    const listSpyLocal = spyOn(Squad, 'list').mockResolvedValue([{ id: 'sq1' }] as Squad[])
    const minimalManager = {} as ISandboxManager

    await reconcileSquadSandboxSpecs(logger(), { manager: minimalManager, buildOptions, isIdle: async () => true })

    // Should bail before even listing squads.
    expect(listSpyLocal).toHaveBeenCalledTimes(0)
    listSpyLocal.mockRestore()
  })
})

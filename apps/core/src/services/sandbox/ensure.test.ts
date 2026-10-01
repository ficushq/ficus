import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { randomUUID, createHash, createPublicKey } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { getSquadMemoryBasePath, getSquadMemoryPath, ensureSquadMemoryPath } from '../memory/paths'
import * as homeUtils from '../../lib/utils/home'
import * as sandboxFactory from './factory'
import * as localDeploymentHealth from '../deploy/local-deployment-health'
import * as identityModule from '../amtp/agent-identity'
import { db, agents } from '../../db'
import { squads } from '../../db/schema'
import { ToolchainAdapterError, ToolchainProvisioningError } from './toolchain/provision'
import { getProvisionState } from './toolchain/state'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { getSquadWorkspacePath } from '../squad/workspace'
import { resolveSandboxAssets } from './asset-manifest'
import { ensureWorkspaceSandbox, type EnsureWorkspaceDeps } from './ensure'
import { SandboxProvisionError } from './k8s/provision-errors'
import {
  SANDBOX_EXECUTOR_PROTOCOL_VERSION,
  reconcilableSpecHash,
  resolveEphemeralStorageLimit,
  type SquadSandboxConfig,
} from './k8s/pod-spec'
import type { AdmissionEffectSpec } from '../maintenance/admission-reservation'
import { trackSandboxSetupWork, type SandboxSetupProgressEvent } from './setup-progress'
import { computeDockerSpecHash } from './docker/manager'
import type { SandboxOptions as ManagerSandboxOptions } from './types'

describe('normalizeWatchPatterns', () => {
  it('matches the watcher: strips leading slash, workspace/ prefix, whitespace; drops empties', async () => {
    const { normalizeWatchPatterns } = await import('./ensure')
    expect(normalizeWatchPatterns(['/src/**', ' workspace/docs/**/*.md ', 'lib/**'])).toEqual([
      'src/**',
      'docs/**/*.md',
      'lib/**',
    ])
    expect(normalizeWatchPatterns(['', '   ', '/'])).toEqual([])
  })
})

describe('ensureK8sCliForSandbox', () => {
  it('stages built CLI into shared core-data for k8s pods', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-cli-stage-'))
    const source = join(tmp, 'ficus.js')
    writeFileSync(source, '#!/usr/bin/env bun\nconsole.log("ok")\n', { mode: 0o755 })

    const { ensureK8sCliForSandbox } = await import('./ensure')
    const staged = ensureK8sCliForSandbox({ cliHostPath: source, homeDir: tmp })

    expect(staged).toBe(join(tmp, 'cli', 'ficus.js'))
    expect(readFileSync(staged, 'utf8')).toContain('console.log("ok")')
    expect(statSync(staged).mode & 0o777).toBe(0o755)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('does not rewrite staged CLI when contents are unchanged', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-cli-stage-'))
    const source = join(tmp, 'source-ficus.js')
    writeFileSync(source, '#!/usr/bin/env bun\nconsole.log("same")\n', { mode: 0o755 })

    const { ensureK8sCliForSandbox } = await import('./ensure')
    const staged = ensureK8sCliForSandbox({ cliHostPath: source, homeDir: tmp })
    const before = statSync(staged)

    ensureK8sCliForSandbox({ cliHostPath: source, homeDir: tmp })

    const after = statSync(staged)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('refreshes staged CLI in-place so k8s subPath mounts keep working', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-cli-stage-'))
    const source = join(tmp, 'source-ficus.js')
    writeFileSync(source, '#!/usr/bin/env bun\nconsole.log("v1")\n', { mode: 0o755 })

    const { ensureK8sCliForSandbox } = await import('./ensure')
    const staged = ensureK8sCliForSandbox({ cliHostPath: source, homeDir: tmp })
    const before = statSync(staged).ino

    writeFileSync(source, '#!/usr/bin/env bun\nconsole.log("v2")\n', { mode: 0o755 })
    ensureK8sCliForSandbox({ cliHostPath: source, homeDir: tmp })

    expect(statSync(staged).ino).toBe(before)
    expect(readFileSync(staged, 'utf8')).toContain('console.log("v2")')
    expect(statSync(staged).mode & 0o777).toBe(0o755)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws actionable error when built CLI is missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-cli-stage-'))
    const { ensureK8sCliForSandbox } = await import('./ensure')

    expect(() => ensureK8sCliForSandbox({ cliHostPath: join(tmp, 'missing'), homeDir: tmp })).toThrow(
      'Ficus CLI build not found'
    )
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('squad-memory', () => {
  const testSquadId = `test-squad-memory-${Date.now()}`

  afterEach(() => {
    // Clean up test memory directory
    const fullPath = getSquadMemoryPath(testSquadId)
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  })

  describe('getSquadMemoryBasePath', () => {
    it('returns a path ending with memory', () => {
      const basePath = getSquadMemoryBasePath()
      expect(basePath.endsWith('memory')).toBe(true)
    })

    it('creates base directory if it does not exist', () => {
      const basePath = getSquadMemoryBasePath()
      expect(existsSync(basePath)).toBe(true)
    })
  })

  describe('getSquadMemoryPath', () => {
    it('returns path with squad ID', () => {
      const path = getSquadMemoryPath(testSquadId)
      expect(path).toContain(testSquadId)
      expect(path).toContain('memory')
    })
  })

  describe('ensureSquadMemoryPath', () => {
    it('creates memory directory for squad', () => {
      const result = ensureSquadMemoryPath(testSquadId)
      expect(existsSync(result)).toBe(true)
      expect(result).toContain(testSquadId)
    })

    it('is idempotent', () => {
      const first = ensureSquadMemoryPath(testSquadId)
      const second = ensureSquadMemoryPath(testSquadId)
      expect(first).toBe(second)
      expect(existsSync(first)).toBe(true)
    })
  })
})

describe('ensureWorkspaceSandbox admission effect boundaries', () => {
  it('authorizes physical ensure before invoking the manager adapter', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-effect-'))
    const order: string[] = []
    const manager = {
      ensureSandbox: async () => order.push('adapter'),
      getWorkspaceLayout: () => ({ privateMount: '/private', workspaceMount: '/workspace' }),
    } as any
    const admissionScope = {
      runEffect: async <T>(spec: AdmissionEffectSpec, operation: (context: any) => Promise<T>) => {
        order.push(`${spec.phase}:${spec.resourceKey}`)
        return operation({ operationId: 'test-operation', signal: new AbortController().signal, phaseSequence: 1 })
      },
    } as any

    await ensureWorkspaceSandbox(
      { sandboxId: 'test-effect', workspaceId: 'test-effect', admissionScope },
      {
        isK8sRuntime: () => false,
        isRemoteSandboxRuntime: () => false,
        getSandboxManager: () => manager,
        getCliHostPath: () => join(tmp, 'ficus.js'),
        getHomeDir: () => tmp,
        ensureSquadWorkspace: () => tmp,
        isSessionActive: () => false,
      }
    )

    expect(order).toEqual(['sandbox-ensure:sandbox:test-effect', 'adapter'])
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('ensureWorkspaceSandbox private + squad-aware', () => {
  it('(solo) works in /private — workspacePath is the private dir, no separate privateVolumePath, no /memory', async () => {
    let capturedOptions: any = null
    const mockManager = {
      ensureSandbox: async (_id: string, options: any) => {
        capturedOptions = options
        return '/workspace'
      },
      hasSandbox: (_id: string) => false,
    }
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-docker-solo-'))

    try {
      await ensureWorkspaceSandbox(
        { sandboxId: 'agent_solo_1', workspaceId: 'agent_solo_1' },
        {
          isK8sRuntime: () => false,
          getSandboxManager: () => mockManager as any,
          getCliHostPath: () => '/tmp/ficus.js',
          getHomeDir: () => tmp,
          ensureSquadWorkspace: () => '/unused',
          isSessionActive: () => false,
        }
      )

      expect(capturedOptions).toBeDefined()
      expect(capturedOptions.workspacePath).toContain('agent_solo_1')
      expect(capturedOptions.privateVolumePath).toBeUndefined()
      expect(capturedOptions.squadId).toBeUndefined()
      const hasMemoryMount = (capturedOptions.volumes ?? []).some((v: string) => v.includes(':/memory:ro'))
      expect(hasMemoryMount).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      // The manifest-driven skills mount pre-creates its host source dir.
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', 'agent-solo-1'), { recursive: true, force: true })
    }
  })

  it('(squad member) calls ensureSquadWorkspace, passes squadId, mounts NO memory, sets privateVolumePath', async () => {
    const squadId = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-docker-squad-'))
    const fakeCliSrc = join(tmp, 'ficus.js')
    const fakeHome = join(tmp, 'home')
    writeFileSync(fakeCliSrc, '#!/usr/bin/env bun\nconsole.log("ok")\n', { mode: 0o755 })

    let capturedOptions: any = null
    const squadWorkspaceArgs: string[] = []
    const mockManager = {
      ensureSandbox: async (_id: string, options: any) => {
        capturedOptions = options
        return '/workspace'
      },
      hasSandbox: (_id: string) => false,
    }

    try {
      await ensureWorkspaceSandbox(
        { sandboxId: 'agent_w_2', workspaceId: 'agent_w_2', squadId },
        {
          isK8sRuntime: () => false,
          getSandboxManager: () => mockManager as any,
          getCliHostPath: () => fakeCliSrc,
          getHomeDir: () => fakeHome,
          ensureSquadWorkspace: (id: string) => {
            squadWorkspaceArgs.push(id)
            return `/mock/workspace/${squadId}`
          },
          isSessionActive: () => false,
        }
      )

      expect(squadWorkspaceArgs).toEqual([squadId])
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions.workspacePath).toBe(`/mock/workspace/${squadId}`)
      expect(capturedOptions.squadId).toBe(squadId)
      expect(capturedOptions.volumes).toContain(`${fakeCliSrc}:/usr/local/bin/ficus:ro`)
      // Squad memory is delivered only to the squad box (asset-manifest scope);
      // members get NO memory mount at all.
      expect((capturedOptions.volumes ?? []).find((v: string) => v.includes(':/memory'))).toBeUndefined()
      expect(capturedOptions.privateVolumePath).toBe(join(fakeHome, 'private', 'agent_w_2'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      // The manifest-driven mounts pre-create their real host source dirs.
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', 'agent-w-2'), { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'ssh', squadId), { recursive: true, force: true })
    }
  })

  it('(k8s, squad member) forwards squadId and privateStorageKey to manager options', async () => {
    const squadId = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-k8s-squad-'))
    const fakeCliSrc = join(tmp, 'ficus.js')
    writeFileSync(fakeCliSrc, '#!/usr/bin/env bun\nconsole.log("ok")\n', { mode: 0o755 })

    let capturedOptions: any = null
    const mockManager = {
      ensureSandbox: async (_id: string, options: any) => {
        capturedOptions = options
      },
      getWorkspaceLayout: () => ({
        workspaceMount: '/workspace',
        memoryMount: '/memory',
        cwd: '/workspace',
        privateMount: '/workspace',
      }),
      hasSandbox: (_id: string) => false,
    }

    try {
      const result = await ensureWorkspaceSandbox(
        { sandboxId: 'agent_k8s_3', workspaceId: 'agent_k8s_3', squadId },
        {
          isK8sRuntime: () => true,
          getSandboxManager: () => mockManager as any,
          getCliHostPath: () => fakeCliSrc,
          getHomeDir: () => tmp,
          ensureSquadWorkspace: () => `/mock/workspace/${squadId}`,
          isSessionActive: () => false,
        }
      )

      expect(result).toBe('/workspace')
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions.squadId).toBe(squadId)
      expect(capturedOptions.k8s.privateStorageKey).toBe('agent_k8s_3')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  describe('(k8s) self-heal spec drift', () => {
    function makeDriftManager(runningHash: string | null) {
      const calls = { ensure: 0, recreate: 0 }
      const manager = {
        ensureSandbox: async () => {
          calls.ensure++
        },
        recreateSandbox: async () => {
          calls.recreate++
          return '/workspace'
        },
        computeSpecHash: () => 'DESIRED',
        assertProvisionInspectionAllowed: async () => {},
        getRunningSandboxSpecHash: async () => runningHash,
        getWorkspaceLayout: () => ({
          workspaceMount: '/workspace',
          memoryMount: '/memory',
          cwd: '/workspace',
          privateMount: '/workspace',
        }),
        hasSandbox: () => true,
      }
      return { manager, calls }
    }

    async function runEnsure(
      manager: any,
      isActive: boolean,
      sandboxId = 'agent_heal_1',
      setupProgress?: (event: SandboxSetupProgressEvent) => void
    ) {
      const tmp = mkdtempSync(join(tmpdir(), 'ficus-k8s-heal-'))
      const fakeCliSrc = join(tmp, 'ficus.js')
      writeFileSync(fakeCliSrc, '#!/usr/bin/env bun\nconsole.log("ok")\n', { mode: 0o755 })

      try {
        await ensureWorkspaceSandbox(
          { sandboxId, workspaceId: sandboxId, setupProgress },
          {
            isK8sRuntime: () => true,
            getSandboxManager: () => manager,
            getCliHostPath: () => fakeCliSrc,
            getHomeDir: () => tmp,
            ensureSquadWorkspace: () => '/unused',
            isSessionActive: () => isActive,
          }
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }

    it('skips drift inspection while open and lets a healthy warm manager bypass', async () => {
      const { manager, calls } = makeDriftManager('STALE')
      let specReads = 0
      manager.getRunningSandboxSpecHash = async () => {
        specReads++
        return 'STALE'
      }
      manager.assertProvisionInspectionAllowed = async () => {
        throw new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'circuit open', 30_000)
      }
      await runEnsure(manager, false)
      expect(specReads).toBe(0)
      expect(calls.ensure).toBe(1)
      expect(calls.recreate).toBe(0)
    })

    it('still rejects a cold ensure while open after skipping the Kubernetes drift read', async () => {
      const { manager } = makeDriftManager('STALE')
      let specReads = 0
      manager.getRunningSandboxSpecHash = async () => {
        specReads++
        return 'STALE'
      }
      manager.assertProvisionInspectionAllowed = async () => {
        throw new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'circuit open', 30_000)
      }
      manager.ensureSandbox = async () => {
        throw new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'circuit open', 30_000)
      }
      await expect(runEnsure(manager, false)).rejects.toMatchObject({ code: 'SANDBOX_PROVISION_UNAVAILABLE' })
      expect(specReads).toBe(0)
    })

    it('recreates a drifted box when the agent has no active session', async () => {
      const { manager, calls } = makeDriftManager('STALE')
      await runEnsure(manager, false)
      expect(calls.recreate).toBe(1)
      expect(calls.ensure).toBe(0)
    })

    it('forwards manager setup progress during physical reconciliation', async () => {
      const { manager } = makeDriftManager('STALE')
      const events: SandboxSetupProgressEvent[] = []
      manager.recreateSandbox = () =>
        trackSandboxSetupWork(manager as any, 'agent_heal_1', 'spec_reconcile', async () => '/workspace')

      await runEnsure(manager, false, 'agent_heal_1', (event) => events.push(event))

      expect(events.map((event) => event.type)).toEqual(['started', 'finished'])
      expect(events[0]).toMatchObject({ sandboxId: 'agent_heal_1', reason: 'spec_reconcile' })
    })

    it('does NOT recreate a drifted box while a session is active (warmup-sweep safety)', async () => {
      const { manager, calls } = makeDriftManager('STALE')
      await runEnsure(manager, true)
      expect(calls.recreate).toBe(0)
      expect(calls.ensure).toBe(1)
    })

    it('does NOT recreate when the running hash matches the desired spec', async () => {
      const { manager, calls } = makeDriftManager('DESIRED')
      await runEnsure(manager, false)
      expect(calls.recreate).toBe(0)
      expect(calls.ensure).toBe(1)
    })

    it('recreates an idle ready box with a null durable hash', async () => {
      const { manager, calls } = makeDriftManager(null)
      await runEnsure(manager, false)
      expect(calls.recreate).toBe(1)
      expect(calls.ensure).toBe(0)
    })

    it('defers a ready box with a null durable hash while its session is active', async () => {
      const { manager, calls } = makeDriftManager(null)
      await runEnsure(manager, true)
      expect(calls.recreate).toBe(0)
      expect(calls.ensure).toBe(1)
    })

    it('does NOT recreate non-agent_ boxes even when drifted', async () => {
      const { manager, calls } = makeDriftManager('STALE')
      await runEnsure(manager, false, 'system-manager_user1')
      expect(calls.recreate).toBe(0)
      expect(calls.ensure).toBe(1)
    })
  })
})

describe('ensureWorkspaceSandbox vm runtime (env-driven)', () => {
  const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
  })

  // Drive the REAL factory runtime predicates off FICUS_SANDBOX_RUNTIME=vm, faking
  // only the manager — this proves the vm env selects the remote manager flow.
  // getCliHostPath points at a non-existent build on purpose: if the vm path
  // wrongly ran the k8s CLI subPath staging it would throw "Ficus CLI build not
  // found" (vm boxes receive the CLI via syncBoxFiles, not a host subPath mount).
  function vmDeps(manager: any, tmp: string): any {
    return {
      isK8sRuntime: sandboxFactory.isK8sRuntime,
      isRemoteSandboxRuntime: sandboxFactory.isRemoteSandboxRuntime,
      getSandboxManager: () => manager,
      getCliHostPath: () => join(tmp, 'nonexistent-ficus.js'),
      getHomeDir: () => tmp,
      ensureSquadWorkspace: (id: string) => join(tmp, 'squad-ws', id),
      isSessionActive: () => false,
    }
  }

  it('(solo agent) routes to the vm manager ensureSandbox with agent opts + machineId, skipping k8s CLI staging', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-vm-solo-'))
    let captured: any = null
    const manager = {
      ensureSandbox: async (_id: string, opts: any) => {
        captured = opts
      },
      getWorkspaceLayout: (ctx: { squadId?: string; sandboxId?: string }) => ({
        workspaceMount: ctx.squadId ? '/home/tau/workspace' : '/private',
        memoryMount: '/memory',
        cwd: ctx.squadId ? '/home/tau/workspace' : '/private',
        privateMount: '/private',
      }),
      hasSandbox: () => false,
    }
    try {
      const result = await ensureWorkspaceSandbox(
        { sandboxId: 'agent_vm_solo', workspaceId: 'agent_vm_solo', machineId: 'machine-1' },
        vmDeps(manager, tmp)
      )
      expect(result).toBe('/private')
      expect(captured).toBeDefined()
      expect(captured.squadId).toBeUndefined()
      expect(captured.machineId).toBe('machine-1')
      expect(captured.k8s.sandboxType).toBe('agent')
      expect(captured.k8s.privateStorageKey).toBe('agent_vm_solo')
      expect(captured.workspacePath).toBe(join(tmp, 'private', 'agent_vm_solo'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('(squad member) passes squadId + shared squad workspace to the vm manager', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squadId = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-vm-squad-'))
    let captured: any = null
    const manager = {
      ensureSandbox: async (_id: string, opts: any) => {
        captured = opts
      },
      getWorkspaceLayout: (ctx: { squadId?: string; sandboxId?: string }) => ({
        workspaceMount: ctx.squadId ? '/home/tau/workspace' : '/private',
        memoryMount: '/memory',
        cwd: ctx.squadId ? '/home/tau/workspace' : '/private',
        privateMount: '/private',
      }),
      hasSandbox: () => false,
    }
    try {
      const result = await ensureWorkspaceSandbox(
        { sandboxId: 'agent_vm_member', workspaceId: 'agent_vm_member', squadId, machineId: 'm2' },
        vmDeps(manager, tmp)
      )
      expect(result).toBe('/home/tau/workspace')
      expect(captured.squadId).toBe(squadId)
      expect(captured.workspacePath).toBe(join(tmp, 'squad-ws', squadId))
      expect(captured.machineId).toBe('m2')
      expect(captured.k8s.sandboxType).toBe('agent')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('(system-manager) reaches ensureSandbox without drift-recreate (non-agent_ prefix)', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-vm-sysmgr-'))
    let ensureCalls = 0
    let recreateCalls = 0
    let captured: any = null
    const manager = {
      ensureSandbox: async (_id: string, opts: any) => {
        ensureCalls++
        captured = opts
      },
      recreateSandbox: async () => {
        recreateCalls++
        return '/private'
      },
      computeSpecHash: () => 'DESIRED',
      getRunningSandboxSpecHash: async () => 'STALE',
      getWorkspaceLayout: () => ({
        workspaceMount: '/private',
        memoryMount: '/memory',
        cwd: '/private',
        privateMount: '/private',
      }),
      hasSandbox: () => false,
    }
    try {
      await ensureWorkspaceSandbox(
        { sandboxId: 'system-manager_user1', workspaceId: 'system-manager_user1', machineId: 'm3' },
        vmDeps(manager, tmp)
      )
      // Non-agent_ prefix: drift self-heal is skipped, so ensureSandbox runs directly.
      expect(ensureCalls).toBe(1)
      expect(recreateCalls).toBe(0)
      expect(captured.k8s.sandboxType).toBe('agent')
      expect(captured.squadId).toBeUndefined()
      expect(captured.machineId).toBe('m3')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// ensureWorkspaceSandbox — federation identity generation (#788)
//
// Root cause: ensureAgentIdentity was only ever called from agent-warmup.ts,
// which fires on narrow triggers (spawn/resume/boot sweeps) — NOT from the
// per-turn execution path every runner's createSession() actually uses. An
// agent that never hit a warmup trigger got identity.pem nowhere: not on the
// host, not in the box. The fix folds identity-ensure into
// ensureWorkspaceSandbox itself, which every runner calls unconditionally
// every turn, BEFORE the manifest sync so the vm push transport never misses
// a freshly-generated key on its first sync.
// ---------------------------------------------------------------------------
describe('ensureWorkspaceSandbox federation identity (#788)', () => {
  const createdAgentIds: string[] = []
  const privateDirsToClean: string[] = []

  afterEach(async () => {
    for (const sid of privateDirsToClean.splice(0)) {
      rmSync(join(homeUtils.getHomeDir(), 'private', sid), { recursive: true, force: true })
    }
    for (const id of createdAgentIds.splice(0)) await db.delete(agents).where(eq(agents.id, id))
  })

  async function makeAgent(agentTypeId: string): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: null })
    createdAgentIds.push(agent.id)
    return agent
  }

  function fakeDeps(tmp: string) {
    const manager = {
      ensureSandbox: async () => {},
      hasSandbox: (_id: string) => false,
    }
    return {
      isK8sRuntime: () => false,
      getSandboxManager: () => manager as any,
      getCliHostPath: () => '/tmp/ficus.js',
      getHomeDir: () => tmp,
      ensureSquadWorkspace: () => '/unused',
      isSessionActive: () => false,
    }
  }

  it('canonicalizes warmup-shaped and runner-shaped ensures to the owner generation', async () => {
    const agent = await makeAgent('manager')
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-generation-canonical-'))
    const captured: ManagerSandboxOptions[] = []
    const deps = fakeDeps(tmp)
    deps.getSandboxManager = () =>
      ({
        ensureSandbox: async (_id: string, options: ManagerSandboxOptions) => {
          captured.push(options)
        },
        hasSandbox: () => false,
      }) as any
    const generation = (agent.metadata as Record<string, unknown>).resourceGeneration as string

    try {
      await ensureWorkspaceSandbox(
        { sandboxId, workspaceId: sandboxId, lifecycleGeneration: 'caller-selected-generation' },
        deps
      )
      await ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, deps)
      expect(captured.map((options) => options.lifecycleGeneration)).toEqual([generation, generation])
      expect(computeDockerSpecHash(captured[0])).toBe(computeDockerSpecHash(captured[1]))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('passes the canonical owner generation through the host ensure branch', async () => {
    const agent = await makeAgent('manager')
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-host-generation-'))
    let capturedGeneration: string | undefined
    const deps: EnsureWorkspaceDeps = { ...fakeDeps(tmp), isHostRuntime: () => true }
    deps.getSandboxManager = () =>
      ({
        ensureSandbox: async (_id: string, options: ManagerSandboxOptions) => {
          capturedGeneration = options.lifecycleGeneration
        },
        getWorkspaceLayout: () => ({
          workspaceMount: join(tmp, 'workspace'),
          memoryMount: join(tmp, 'memory'),
          cwd: join(tmp, 'private', sandboxId),
          privateMount: join(tmp, 'private', sandboxId),
        }),
        hasSandbox: () => false,
      }) as any

    try {
      await ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, deps)
      const expectedGeneration = agent.metadata?.resourceGeneration
      if (typeof expectedGeneration !== 'string') throw new Error('Expected the agent fixture to have a generation')
      expect(capturedGeneration).toBe(expectedGeneration)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('generates identity.pem on the host for a per-agent box and includes it in the synced manifest', async () => {
    const agent = await makeAgent('manager')
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-identity-solo-'))

    try {
      await ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, fakeDeps(tmp))

      const keyPath = join(homeUtils.getHomeDir(), 'private', sandboxId, '.ficus', 'identity.pem')
      expect(existsSync(keyPath)).toBe(true)
      expect(readFileSync(keyPath, 'utf-8')).toContain('BEGIN PRIVATE KEY')

      // "Included in the synced manifest": the identity asset's own source now
      // yields the freshly-generated file, so every transport (vm push
      // included) will deliver it on the very next sync.
      const resolved = await resolveSandboxAssets({ sandboxId, role: 'agent' })
      const identityAsset = resolved.find(({ asset }) => asset.name === 'identity')
      expect(identityAsset).toBeDefined()
      const files = await identityAsset!.source.files()
      expect(files.length).toBe(1)

      const reloaded = await Agent.find(agent.id)
      expect(reloaded!.identityPublicKey).toContain('BEGIN PUBLIC KEY')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', sandboxId.replace(/_/g, '-')), {
        recursive: true,
        force: true,
      })
    }
  })

  it('dedupes concurrent first-time identity generation for the same sandboxId (review follow-up #788)', async () => {
    // Without a per-sandboxId lock, two racing ensures for a never-before-generated
    // agent (e.g. a warmup sweep racing a live turn) can each observe the identity
    // file absent, each generate a DIFFERENT keypair, and race each other on the
    // atomic rename + DB update — leaving identityPublicKey in the DB not matching
    // the private key that actually won the rename on disk.
    const agent = await makeAgent('manager')
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-identity-race-'))

    const ensureIdentitySpy = spyOn(identityModule, 'ensureAgentIdentity')

    try {
      await Promise.all([
        ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, fakeDeps(tmp)),
        ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, fakeDeps(tmp)),
      ])

      // Exactly one generation happened — the second racer joined the first's
      // in-flight run rather than doing its own independent existsSync-check +
      // generate + rename.
      expect(ensureIdentitySpy).toHaveBeenCalledTimes(1)

      const keyPath = join(homeUtils.getHomeDir(), 'private', sandboxId, '.ficus', 'identity.pem')
      const privatePem = readFileSync(keyPath, 'utf-8')
      const derivedPublicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }) as string

      const reloaded = await Agent.find(agent.id)
      // The DB's recorded public key must match the key material that actually
      // won on disk — not a different keypair generated by a losing racer.
      expect(reloaded!.identityPublicKey).toBe(derivedPublicPem)
    } finally {
      ensureIdentitySpy.mockRestore()
      rmSync(tmp, { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', sandboxId.replace(/_/g, '-')), {
        recursive: true,
        force: true,
      })
    }
  })

  it('continues sandbox startup in degraded federation state when recorded custody is lost', async () => {
    const agent = await makeAgent('manager')
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-identity-degraded-'))

    try {
      await identityModule.ensureAgentIdentity(agent, sandboxId)
      const keyPath = join(homeUtils.getHomeDir(), 'private', sandboxId, '.ficus', 'identity.pem')
      rmSync(keyPath, { force: true })

      await expect(ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, fakeDeps(tmp))).resolves.toBeString()
      expect((await Agent.mustFind(agent.id)).identityPublicKey).toContain('BEGIN PUBLIC KEY')
      expect(existsSync(keyPath)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('guard: a system-manager agent does NOT get a per-agent identity', async () => {
    const agent = await makeAgent('system-manager')
    // Real system-manager sandboxIds never carry the agent_ prefix at all
    // (they're system_manager_<ownerUserId>), but assert the explicit
    // agentTypeId guard holds even against an agent_-prefixed id, matching
    // agent-warmup.ts's existing check defensively.
    const sandboxId = `agent_${agent.id}`
    privateDirsToClean.push(sandboxId)
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-identity-sysmgr-'))

    try {
      await ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, fakeDeps(tmp))

      const keyPath = join(homeUtils.getHomeDir(), 'private', sandboxId, '.ficus', 'identity.pem')
      expect(existsSync(keyPath)).toBe(false)

      const reloaded = await Agent.find(agent.id)
      expect(reloaded!.identityPublicKey).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', sandboxId.replace(/_/g, '-')), {
        recursive: true,
        force: true,
      })
    }
  })

  it("guard: a squad-role box (the squad's own shared sandbox) does NOT get a single-agent identity", async () => {
    const squadId = randomUUID()
    const sandboxId = `squad_${squadId}`

    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
      ensureSandbox: async () => {},
      hasSandbox: (_id: string) => false,
    } as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const restartLocalDeploymentsSpy = spyOn(
      localDeploymentHealth,
      'restartManagedLocalDeploymentsForSandbox'
    ).mockResolvedValue()

    const { ensureSquadSandbox } = await import('./ensure')

    try {
      await ensureSquadSandbox(squadId)

      const keyPath = join(homeUtils.getHomeDir(), 'private', sandboxId, '.ficus', 'identity.pem')
      expect(existsSync(keyPath)).toBe(false)
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      restartLocalDeploymentsSpy.mockRestore()
      const home = homeUtils.getHomeDir()
      rmSync(join(home, 'private', sandboxId), { recursive: true, force: true })
      rmSync(join(home, 'skills', 'sandboxes', `squad-${squadId}`), { recursive: true, force: true })
      rmSync(join(home, 'ssh', squadId), { recursive: true, force: true })
      rmSync(join(home, 'memory', squadId), { recursive: true, force: true })
    }
  })
})

describe('ensureSquadSandbox workspace lifecycle', () => {
  it('rejects archived squads before recreating their workspace', async () => {
    const squadId = randomUUID()
    const archivedSquad = {
      id: squadId,
      status: 'archived',
      archivedAt: new Date(),
    } as Squad
    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
      ensureSandbox: async () => {},
      hasSandbox: () => false,
    } as any)
    const isRemoteRuntimeSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(false)
    const { ensureSquadSandbox } = await import('./ensure')

    try {
      await expect(ensureSquadSandbox(archivedSquad)).rejects.toThrow('archived')
      expect(existsSync(getSquadWorkspacePath(squadId))).toBe(false)
    } finally {
      getSandboxManagerSpy.mockRestore()
      isRemoteRuntimeSpy.mockRestore()
      rmSync(getSquadWorkspacePath(squadId), { recursive: true, force: true })
    }
  })
})

describe('ensureSquadSandbox memory mount', () => {
  it('mounts squad memory read-only at /memory/<squadId>', async () => {
    const testSquadId = randomUUID()

    // Ensure test memory path exists
    const memoryPath = ensureSquadMemoryPath(testSquadId)

    // Spy on getSandboxManager to return a mock manager
    let capturedOptions: any = null
    const mockManager = {
      ensureSandbox: async (_id: string, options: any) => {
        capturedOptions = options
        return '/workspace'
      },
    }
    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockManager as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const restartLocalDeploymentsSpy = spyOn(
      localDeploymentHealth,
      'restartManagedLocalDeploymentsForSandbox'
    ).mockResolvedValue()

    // Import after spy setup to ensure the spy is used
    const { ensureSquadSandbox } = await import('./ensure')

    try {
      await ensureSquadSandbox(testSquadId)

      // Verify getSandboxManager was called
      expect(getSandboxManagerSpy).toHaveBeenCalled()

      // Verify the volumes include the memory mount
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions.volumes).toBeDefined()

      // Find the memory mount in volumes - look for the /memory/<squadId> container path specifically
      expect(capturedOptions.volumes.find((v: string) => v.includes(`:/memory/${testSquadId}:ro`))).toBeDefined()
      expect(capturedOptions.volumes.find((v: string) => v.includes(':/memory:ro'))).toBeUndefined()
      expect(restartLocalDeploymentsSpy).toHaveBeenCalledWith(`squad_${testSquadId}`)
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      restartLocalDeploymentsSpy.mockRestore()

      // Clean up test memory directory
      if (existsSync(memoryPath)) {
        rmSync(memoryPath, { recursive: true, force: true })
      }
      // The manifest-driven mounts pre-create their host source dirs.
      const home = homeUtils.getHomeDir()
      rmSync(join(home, 'skills', 'sandboxes', `squad-${testSquadId}`), { recursive: true, force: true })
      rmSync(join(home, 'ssh', testSquadId), { recursive: true, force: true })
    }
  })

  it('threads squadId into the warm-box ensureSandbox options (Docker)', async () => {
    const squadId = randomUUID()
    let capturedOptions: any = null
    const mockManager = {
      ensureSandbox: async (_id: string, options: any) => {
        capturedOptions = options
      },
    }
    const getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockManager as any)
    const isK8sRuntimeSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const restartLocalDeploymentsSpy = spyOn(
      localDeploymentHealth,
      'restartManagedLocalDeploymentsForSandbox'
    ).mockResolvedValue()

    const { ensureSquadSandbox } = await import('./ensure')

    try {
      await ensureSquadSandbox(squadId)
      expect(capturedOptions.squadId).toBe(squadId)
    } finally {
      getSandboxManagerSpy.mockRestore()
      isK8sRuntimeSpy.mockRestore()
      restartLocalDeploymentsSpy.mockRestore()
      // The manifest-driven mounts pre-create their host source dirs.
      const home = homeUtils.getHomeDir()
      rmSync(join(home, 'skills', 'sandboxes', `squad-${squadId}`), { recursive: true, force: true })
      rmSync(join(home, 'ssh', squadId), { recursive: true, force: true })
      rmSync(join(home, 'memory', squadId), { recursive: true, force: true })
    }
  })
})

describe('ensureSquadSandbox setup progress extent', () => {
  it('observes physical setup through toolchain but not post-ready hooks', async () => {
    const squad = await Squad.create({
      name: `setup observation ${randomUUID()}`,
      purpose: 'test',
      metadata: { sandbox: { toolchain: { packages: ['python3@latest'] } } },
    })
    const sandboxId = Squad.getSandboxId(squad.id)
    const events: SandboxSetupProgressEvent[] = []
    const phases: string[] = []
    const manager: any = {
      hasSandbox: () => false,
      ensureSandbox: () => trackSandboxSetupWork(manager, sandboxId, 'runtime_start', async () => sandboxId),
      reconcileToolchain: () =>
        trackSandboxSetupWork(manager, sandboxId, 'toolchain_reconcile', async () => 'applied' as const),
    }
    const scope = {
      runEffect: async (spec: AdmissionEffectSpec, operation: (context: any) => Promise<any>) => {
        phases.push(spec.phase)
        if (spec.phase === 'workspace-watch-configure' || spec.phase === 'local-deployment-restart') {
          await trackSandboxSetupWork(manager, sandboxId, 'asset_reconcile', async () => undefined)
        }
        return operation({ signal: new AbortController().signal })
      },
    } as any
    const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(manager)
    const remoteSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(false)
    const k8sSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
    const restartSpy = spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue()

    try {
      const { ensureSquadSandbox } = await import('./ensure')
      await ensureSquadSandbox(squad, {
        admissionScope: scope,
        setupProgress: (event) => events.push(event),
      })

      expect(events.filter((event) => event.type === 'started').map((event) => event.reason)).toEqual([
        'runtime_start',
        'toolchain_reconcile',
      ])
      expect(phases).toEqual([
        'sandbox-ensure',
        'toolchain-reconcile',
        'workspace-watch-configure',
        'local-deployment-restart',
      ])
      expect(restartSpy).toHaveBeenCalledWith(sandboxId)
    } finally {
      managerSpy.mockRestore()
      remoteSpy.mockRestore()
      k8sSpy.mockRestore()
      restartSpy.mockRestore()
      await db.delete(squads).where(eq(squads.id, squad.id))
      const home = homeUtils.getHomeDir()
      rmSync(join(home, 'skills', 'sandboxes', `squad-${squad.id}`), { recursive: true, force: true })
      rmSync(join(home, 'ssh', squad.id), { recursive: true, force: true })
      rmSync(join(home, 'memory', squad.id), { recursive: true, force: true })
    }
  })
})

describe('ensureWorkspaceSandbox managed toolchain gate', () => {
  const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
  })

  // The orchestrator and every runtime adapter are unit-tested in
  // services/sandbox/toolchain, but those tests call the provisioner directly.
  // This covers the seam they cannot: that `ensure` actually invokes it, after
  // the physical box exists, and that readiness is genuinely GATED on it —
  // deleting the call site must not leave the suite green.
  function toolchainDeps(manager: any, tmp: string): any {
    return {
      isK8sRuntime: sandboxFactory.isK8sRuntime,
      isRemoteSandboxRuntime: sandboxFactory.isRemoteSandboxRuntime,
      getSandboxManager: () => manager,
      getCliHostPath: () => join(tmp, 'nonexistent-ficus.js'),
      getHomeDir: () => tmp,
      ensureSquadWorkspace: (id: string) => join(tmp, 'squad-ws', id),
      isSessionActive: () => false,
    }
  }

  function toolchainManager(calls: string[], reconcile?: () => Promise<never>) {
    return {
      ensureSandbox: async () => void calls.push('ensureSandbox'),
      reconcileToolchain: async (_id: string, _opts: any, request: any) => {
        calls.push(
          `reconcile:${request.config?.packages.join(',') ?? 'none'}:${request.devboxJson ? 'json' : 'nojson'}`
        )
        if (reconcile) return reconcile()
        return 'applied' as const
      },
      getWorkspaceLayout: () => ({
        workspaceMount: '/home/tau/workspace',
        memoryMount: '/memory',
        cwd: '/home/tau/workspace',
        privateMount: '/private',
      }),
      hasSandbox: () => false,
    }
  }

  it('provisions the squad declaration only after the physical box is ready', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squad = await Squad.create({
      name: `toolchain gate ${randomUUID()}`,
      purpose: 'test',
      metadata: { sandbox: { toolchain: { packages: ['python3@latest'], setupScript: 'echo ready' } } },
    })
    const gateSandboxUuid = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-toolchain-gate-'))
    const calls: string[] = []
    try {
      await ensureWorkspaceSandbox(
        { sandboxId: `agent_${gateSandboxUuid}`, workspaceId: 'w', squadId: squad.id },
        toolchainDeps(toolchainManager(calls), tmp)
      )
      // Ordering is the invariant: provisioning a box that does not exist yet
      // cannot succeed, so the call must follow ensureSandbox.
      expect(calls).toEqual(['ensureSandbox', 'reconcile:python3@latest:json'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('fails the ensure when the declaration cannot be provisioned', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squad = await Squad.create({
      name: `toolchain gate fail ${randomUUID()}`,
      purpose: 'test',
      metadata: { sandbox: { toolchain: { packages: ['python3@latest'] } } },
    })
    const gateSandboxUuid = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-toolchain-gate-fail-'))
    const calls: string[] = []
    const manager = toolchainManager(calls, async () => {
      throw new ToolchainAdapterError('install_failed', 1)
    })
    try {
      await expect(
        ensureWorkspaceSandbox(
          { sandboxId: `agent_${gateSandboxUuid}`, workspaceId: 'w', squadId: squad.id },
          toolchainDeps(manager, tmp)
        )
      ).rejects.toBeInstanceOf(ToolchainProvisioningError)
      expect(await getProvisionState(`agent_${gateSandboxUuid}`)).toMatchObject({
        status: 'failed',
        errorCode: 'install_failed',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('does not gate readiness for a squad without a declaration', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squad = await Squad.create({ name: `toolchain none ${randomUUID()}`, purpose: 'test' })
    const gateSandboxUuid = randomUUID()
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-toolchain-none-'))
    const calls: string[] = []
    try {
      await ensureWorkspaceSandbox(
        { sandboxId: `agent_${gateSandboxUuid}`, workspaceId: 'w', squadId: squad.id },
        toolchainDeps(toolchainManager(calls), tmp)
      )
      expect(calls).toEqual(['ensureSandbox'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('(k8s) drift recreate is serialized across concurrent callers', () => {
  it('two callers that both observe the stale stamp trigger ONE recreate; the second falls through to a plain ensure', async () => {
    const calls = { ensure: 0, recreate: 0 }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let stamp = 'STALE'
    const manager = {
      ensureSandbox: async () => {
        calls.ensure++
      },
      recreateSandbox: async () => {
        calls.recreate++
        await gate
        stamp = 'DESIRED'
        return '/workspace'
      },
      computeSpecHash: () => 'DESIRED',
      assertProvisionInspectionAllowed: async () => {},
      getRunningSandboxSpecHash: async () => stamp,
      getWorkspaceLayout: () => ({
        workspaceMount: '/workspace',
        memoryMount: '/memory',
        cwd: '/workspace',
        privateMount: '/workspace',
      }),
      hasSandbox: () => true,
    }
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-k8s-heal-race-'))
    const fakeCliSrc = join(tmp, 'ficus.js')
    writeFileSync(fakeCliSrc, '#!/usr/bin/env bun\nconsole.log("ok")\n', { mode: 0o755 })
    const deps = {
      isK8sRuntime: () => true,
      getSandboxManager: () => manager as any,
      getCliHostPath: () => fakeCliSrc,
      getHomeDir: () => tmp,
      ensureSquadWorkspace: () => '/unused',
      isSessionActive: () => false,
    }
    try {
      const sandboxId = 'agent_heal_race'
      const a = ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, deps)
      await Bun.sleep(20) // let A reach the gated recreate
      const b = ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, deps)
      await Bun.sleep(20)
      release()
      await Promise.all([a, b])
      expect(calls.recreate).toBe(1)
      expect(calls.ensure).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('the ficus CLI is the only CLI a sandbox gets', () => {
  /** Volume targets on the PATH directories a container shell searches. */
  const pathMounts = (volumes: string[]) => volumes.filter((v) => /:\/usr\/(local\/)?s?bin\//.test(v))

  it('(docker) mounts the built ficus.js at /usr/local/bin/ficus and nothing else on PATH', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-docker-cli-'))
    const cli = join(tmp, 'ficus.js')
    writeFileSync(cli, '#!/usr/bin/env bun\n', { mode: 0o755 })
    const captured: any[] = []
    const manager = {
      ensureSandbox: async (_id: string, options: any) => void captured.push(options),
      getWorkspaceLayout: () => ({ privateMount: '/private', workspaceMount: '/workspace' }),
    }
    try {
      await ensureWorkspaceSandbox(
        { sandboxId: 'agent_cli_only', workspaceId: 'agent_cli_only' },
        {
          isK8sRuntime: () => false,
          isRemoteSandboxRuntime: () => false,
          getSandboxManager: () => manager as any,
          getCliHostPath: () => cli,
          getHomeDir: () => tmp,
          ensureSquadWorkspace: () => '/unused',
          isSessionActive: () => false,
        }
      )
      expect(pathMounts(captured[0].volumes)).toEqual([`${cli}:/usr/local/bin/ficus:ro`])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', 'agent-cli-only'), { recursive: true, force: true })
    }
  })

  it('(docker) a container stamped without the ficus mount drifts; the recreate is deferred only while a session runs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-docker-drift-'))
    const cli = join(tmp, 'ficus.js')
    writeFileSync(cli, '#!/usr/bin/env bun\n', { mode: 0o755 })
    const captured: any[] = []
    const manager = {
      ensureSandbox: async (_id: string, options: any) => void captured.push(options),
      getWorkspaceLayout: () => ({ privateMount: '/private', workspaceMount: '/workspace' }),
    }
    const run = (active: boolean) =>
      ensureWorkspaceSandbox(
        { sandboxId: 'agent_cli_drift', workspaceId: 'agent_cli_drift' },
        {
          isK8sRuntime: () => false,
          isRemoteSandboxRuntime: () => false,
          getSandboxManager: () => manager as any,
          getCliHostPath: () => cli,
          getHomeDir: () => tmp,
          ensureSquadWorkspace: () => '/unused',
          isSessionActive: () => active,
        }
      )
    try {
      await run(true)
      await run(false)
      const [busy, idle] = captured
      // The docker manager defers a drift recreate exactly when hasActiveSession is set
      // (docker/manager.test.ts "(g)"); ensure sets it from the agent's live session only.
      expect(busy.hasActiveSession).toBe(true)
      expect(idle.hasActiveSession).toBe(false)
      // A container created without the ficus mount (any pre-ficus volume set) carries a different stamp.
      const withoutFicus = {
        ...idle,
        volumes: idle.volumes.filter((v: string) => !v.endsWith(':/usr/local/bin/ficus:ro')),
      }
      expect(computeDockerSpecHash(withoutFicus)).not.toBe(computeDockerSpecHash(idle))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(join(homeUtils.getHomeDir(), 'skills', 'sandboxes', 'agent-cli-drift'), { recursive: true, force: true })
    }
  })

  describe('(k8s) a pod created before the ficus mount', () => {
    /** The reconcilable-spec stamp a pre-ficus Core wrote on its pods (no CLI mount field). */
    const preFicusStamp = (config?: SquadSandboxConfig) =>
      createHash('sha256')
        .update(
          JSON.stringify({
            executorProtocolVersion: SANDBOX_EXECUTOR_PROTOCOL_VERSION,
            ephemeralStorage: resolveEphemeralStorageLimit(config?.ephemeralStorageLimitGi),
            squadIds: config?.squadId ? [config.squadId] : [],
          })
        )
        .digest('hex')
        .slice(0, 16)

    async function runK8s(active: boolean) {
      const tmp = mkdtempSync(join(tmpdir(), 'ficus-k8s-cli-'))
      const cli = join(tmp, 'build', 'ficus.js')
      mkdirSync(join(tmp, 'build'), { recursive: true })
      writeFileSync(cli, '#!/usr/bin/env bun\nconsole.log("ficus")\n', { mode: 0o755 })
      const calls = { ensure: 0, recreate: 0 }
      const toPodConfig = (opts: ManagerSandboxOptions) =>
        opts.squadId ? { ...opts.k8s, squadId: opts.squadId } : opts.k8s
      const manager = {
        ensureSandbox: async () => void calls.ensure++,
        recreateSandbox: async () => {
          calls.recreate++
          return '/workspace'
        },
        // The real K8sSandboxManager hash: reconcilableSpecHash over its pod config.
        computeSpecHash: (opts: ManagerSandboxOptions) => reconcilableSpecHash(toPodConfig(opts)),
        assertProvisionInspectionAllowed: async () => {},
        getRunningSandboxSpecHash: async () =>
          preFicusStamp({ sandboxType: 'agent', alwaysOn: false, privateStorageKey: 'agent_old_pod' }),
        getWorkspaceLayout: () => ({ workspaceMount: '/workspace', privateMount: '/private' }),
        hasSandbox: () => true,
      }
      try {
        await ensureWorkspaceSandbox(
          { sandboxId: 'agent_old_pod', workspaceId: 'agent_old_pod' },
          {
            isK8sRuntime: () => true,
            getSandboxManager: () => manager as any,
            getCliHostPath: () => cli,
            getHomeDir: () => tmp,
            ensureSquadWorkspace: () => '/unused',
            isSessionActive: () => active,
          }
        )
        // Only ficus.js is staged for the subPath mount.
        expect(readdirSync(join(tmp, 'cli'))).toEqual(['ficus.js'])
        expect(readFileSync(join(tmp, 'cli', 'ficus.js'), 'utf8')).toContain('console.log("ficus")')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      return calls
    }

    it('is recreated when the agent is idle', async () => {
      expect(await runK8s(false)).toEqual({ ensure: 0, recreate: 1 })
    })

    it('is kept while the agent has a running session', async () => {
      expect(await runK8s(true)).toEqual({ ensure: 1, recreate: 0 })
    })
  })
})

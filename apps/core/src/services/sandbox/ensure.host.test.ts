import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { db, agents } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { HostSandboxManager } from './host/manager'
import { clearHostWorkspaceOverrides, getHostWorkspaceOverride } from './host/workspace-overrides'
import { ensureSquadSandbox, ensureWorkspaceSandbox, type EnsureWorkspaceDeps } from './ensure'
import * as sandboxFactory from './factory'
import * as localDeploymentHealth from '../deploy/local-deployment-health'
import { spyOn } from 'bun:test'

describe('ensure — host runtime', () => {
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined
  let manager: HostSandboxManager
  let squad: Squad
  const spies: Array<{ mockRestore(): void }> = []
  const createdAgentIds: string[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'tau-host-ensure-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    manager = new HostSandboxManager({ baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }) })
    spies.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(manager))
    squad = await Squad.create({ name: `host-ensure-${Date.now()}`, purpose: 'test' })
  })
  afterEach(async () => {
    for (const s of spies.splice(0)) s.mockRestore()
    await manager.cleanup()
    await squad.archive({ deleteWorkspace: true })
    for (const id of createdAgentIds.splice(0)) await db.delete(agents).where(eq(agents.id, id))
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  // Deviation from the brief's literal test: `ensureWorkspaceSandbox` sources its
  // manager from `deps.getSandboxManager` (defaulted to `defaultWorkspaceDeps`,
  // a plain object built once at module load from `sandboxFactory.getSandboxManager`
  // *by value*). Spying on `sandboxFactory.getSandboxManager` — as the brief's test
  // does for `ensureSquadSandbox`, which looks the manager up fresh via a live
  // `sandboxFactory.getSandboxManager()` call each time — cannot reach that
  // pre-captured reference, so an un-dep'd `ensureWorkspaceSandbox` call would
  // silently run against the real `getHostManager()` process singleton instead of
  // this test's own `manager`. Passing `deps` explicitly (mirroring the existing
  // `fakeDeps` pattern in ensure.test.ts) routes the call to the right instance.
  function hostDeps(): EnsureWorkspaceDeps {
    return {
      isK8sRuntime: () => false,
      isRemoteSandboxRuntime: () => false,
      isHostRuntime: () => true,
      getSandboxManager: () => manager,
      getCliHostPath: () => {
        throw new Error('host runtime must not stage the CLI')
      },
      getHomeDir: () => home,
      ensureSquadWorkspace: () => {
        throw new Error('host runtime must not use the docker/k8s squad-workspace path')
      },
      isSessionActive: () => false,
    }
  }

  it('ensureWorkspaceSandbox (squad member) creates private + workspace dirs and returns the workspace', async () => {
    // Also deviates from the brief's literal `sandboxId: 'agent_h1'`: identity
    // provisioning (ensureAgentIdentityForSandbox, unconditional and unrelated
    // to Task 6) resolves the agent id from the sandboxId via a real DB lookup
    // (Agent.find), so a made-up id can never produce identity.pem regardless
    // of the host branch — confirmed against ensure.test.ts's identical
    // '#788 federation identity' suite, which creates a real Agent for the
    // same reason. Using a real agent here keeps the assertion meaningful
    // instead of silently unwinnable.
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id })
    createdAgentIds.push(agent.id)
    const sandboxId = `agent_${agent.id}`
    const root = await ensureWorkspaceSandbox({ sandboxId, workspaceId: 'w', squadId: squad.id }, hostDeps())
    expect(root).toBe(join(home, 'workspaces', 'squads', squad.id))
    expect(existsSync(root)).toBe(true)
    expect(existsSync(join(home, 'private', sandboxId, '.tau', 'identity.pem'))).toBe(true)
    expect(manager.hasSandbox(sandboxId)).toBe(true)
  })

  it('ensureWorkspaceSandbox (solo) returns the private dir', async () => {
    const root = await ensureWorkspaceSandbox({ sandboxId: 'system_manager_h1', workspaceId: 'w' }, hostDeps())
    expect(root).toBe(join(home, 'private', 'system_manager_h1'))
  })

  it('ensureSquadSandbox refreshes the override cache from the row and creates the override dir', async () => {
    const override = join(home, 'my-repo')
    await squad.update({ hostWorkspacePath: override })
    const root = await ensureSquadSandbox(squad.id)
    expect(root).toBe(override)
    expect(existsSync(override)).toBe(true)
    expect(getHostWorkspaceOverride(squad.id)).toBe(override)
    expect(manager.hasSandbox(`squad_${squad.id}`)).toBe(true)
  })

  // The api process's override cache is updated the instant a PATCH lands, so
  // reading it back is a PREDICTION, not the truth: agents keep running in the
  // old directory until the next sandbox start. Ensure records the path it
  // actually applied so the status endpoint can report what is live.
  it('ensureSquadSandbox records the applied workspace path on the squad row', async () => {
    const override = join(home, 'applied-repo')
    await squad.update({ hostWorkspacePath: override })
    await ensureSquadSandbox(squad.id)

    const applied = (await Squad.mustFind(squad.id)).metadata?.hostRuntime as {
      activeWorkspacePath?: string
      appliedAt?: string
    }
    expect(applied?.activeWorkspacePath).toBe(override)
    expect(new Date(applied?.appliedAt ?? '').getTime()).toBeGreaterThan(0)
  })

  it('ensureSquadSandbox leaves other metadata alone and does not rewrite an unchanged path', async () => {
    await squad.update({ metadata: { memory: { enabled: true } } })
    await ensureSquadSandbox(squad.id)
    const first = (await Squad.mustFind(squad.id)).metadata as Record<string, unknown>
    const appliedAt = (first.hostRuntime as { appliedAt?: string }).appliedAt

    await ensureSquadSandbox(squad.id)
    const second = (await Squad.mustFind(squad.id)).metadata as Record<string, unknown>
    expect((second.memory as { enabled?: boolean }).enabled).toBe(true)
    // Unchanged path => no write at all, so the timestamp must be identical.
    expect((second.hostRuntime as { appliedAt?: string }).appliedAt).toBe(appliedAt)
  })

  it('ensureWorkspaceSandbox (squad member) records the applied workspace path too', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id })
    createdAgentIds.push(agent.id)
    const override = join(home, 'member-repo')
    await squad.update({ hostWorkspacePath: override })

    await ensureWorkspaceSandbox({ sandboxId: `agent_${agent.id}`, workspaceId: 'w', squadId: squad.id }, hostDeps())

    const applied = (await Squad.mustFind(squad.id)).metadata?.hostRuntime as { activeWorkspacePath?: string }
    expect(applied?.activeWorkspacePath).toBe(override)
  })

  it('archive with deleteWorkspace never touches an override directory', async () => {
    const override = join(home, 'keep-me')
    await squad.update({ hostWorkspacePath: override })
    await ensureSquadSandbox(squad.id)
    await squad.archive({ deleteWorkspace: true })
    expect(existsSync(override)).toBe(true)
    expect(existsSync(join(home, 'workspaces', 'squads', squad.id))).toBe(false)
  })

  it('ensureSquadSandbox skips toolchain reconcile on host and warns when a toolchain is configured', async () => {
    const toolchainSquad = await Squad.create({
      name: `host-ensure-toolchain-${Date.now()}`,
      purpose: 'test',
      metadata: { sandbox: { toolchain: { packages: ['python3@latest'] } } },
    })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(ensureSquadSandbox(toolchainSquad.id)).resolves.toBeString()
      const warned = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('managed toolchain') && arg.includes('host runtime'))
      )
      expect(warned).toBe(true)
    } finally {
      warnSpy.mockRestore()
      await toolchainSquad.archive({ deleteWorkspace: true })
    }
  })

  // --- workspace watch (_configureWorkspaceWatch) ---

  function fakeWatchManager(extra: Record<string, unknown>): any {
    const ws = join(home, 'workspaces', 'squads', squad.id)
    return {
      hasSandbox: () => false,
      ensureSandbox: async () => ws,
      getWorkspaceLayout: () => ({
        workspaceMount: ws,
        memoryMount: join(home, 'memory', squad.id),
        cwd: ws,
        privateMount: join(home, 'private', `squad_${squad.id}`),
      }),
      getSandboxRuntime: () => 'host',
      ...extra,
    }
  }

  it('ensure prefers manager.configureWatch over getClient when both exist', async () => {
    await squad.update({
      metadata: {
        memory: {
          enabled: true,
          workspacePaths: { include: ['/workspace/docs/**/*.md'], exclude: ['docs/draft/**'] },
        },
      },
    })
    const calls: any[] = []
    const clientStarts: any[] = []
    const fake = fakeWatchManager({
      configureWatch: async (squadId: string, config: any) => {
        calls.push({ squadId, config })
        return { owned: true, fileCount: 0, skipped: [] }
      },
      getClient: () => ({
        startWatch: async (c: any) => clientStarts.push(c),
        getWatchStatus: async () => ({ active: false, config: null }),
      }),
    })
    spies.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(fake))
    spies.push(spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue())
    await ensureSquadSandbox(squad)
    expect(calls).toEqual([{ squadId: squad.id, config: { include: ['docs/**/*.md'], exclude: ['docs/draft/**'] } }])
    expect(clientStarts).toEqual([])
  })

  it('ensure still uses getClient.startWatch when configureWatch is absent (container/vm parity)', async () => {
    await squad.update({
      metadata: { memory: { enabled: true, workspacePaths: { include: ['/workspace/docs/**/*.md'] } } },
    })
    const clientStarts: any[] = []
    const fake = fakeWatchManager({
      getClient: () => ({
        startWatch: async (c: any) => clientStarts.push(c),
        getWatchStatus: async () => ({ active: false, config: null }),
      }),
    })
    spies.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(fake))
    spies.push(spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue())
    await ensureSquadSandbox(squad)
    expect(clientStarts).toEqual([{ include: ['docs/**/*.md'], exclude: [], squadId: squad.id }])
  })

  it('ensure stops the host watch when memoryConfig is disabled', async () => {
    await squad.update({ metadata: { memory: { enabled: false } } })
    const stops: string[] = []
    const stopSpy = spyOn(manager, 'stopWatch').mockImplementation(async (squadId: string) => {
      stops.push(squadId)
    })
    spies.push(stopSpy)
    await ensureSquadSandbox(squad)
    expect(stops).toEqual([squad.id])
  })

  it('host ensure watches the squad workspace and ingests edits end to end', async () => {
    await squad.update({
      metadata: { memory: { enabled: true, workspacePaths: { include: ['docs/**/*.md'] } } },
    })
    const ws = join(home, 'workspaces', 'squads', squad.id)
    mkdirSync(join(ws, 'docs'), { recursive: true })
    writeFileSync(join(ws, 'docs', 'note.md'), '# v1')

    const ingested: any[] = []
    const watchManager = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      ingestWorkspaceFiles: async (id: string, payload: any) => {
        ingested.push({ id, payload })
        return { squadFound: true }
      },
    })
    spies.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(watchManager))
    spies.push(spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue())
    try {
      await ensureSquadSandbox(squad)
      expect(ingested).toHaveLength(1) // initial reconcile
      expect(ingested[0].id).toBe(squad.id)
      expect(ingested[0].payload.files[0]).toMatchObject({ path: 'docs/note.md', event: 'change' })
      expect(ingested[0].payload.reconcile).toBe(true)

      await Bun.sleep(500)
      writeFileSync(join(ws, 'docs', 'note.md'), '# v2')
      const deadline = Date.now() + 10_000
      while (ingested.length < 2 && Date.now() < deadline) await Bun.sleep(250)
      expect(ingested[1].payload.reconcile).toBe(false)
      expect(ingested[1].payload.files[0]).toMatchObject({ path: 'docs/note.md', event: 'change' })

      // disabled config on re-ensure stops the watcher
      await squad.update({ metadata: { memory: { enabled: false } } })
      await ensureSquadSandbox(squad)
      expect(watchManager.getWatchStatus(squad.id).active).toBe(false)
    } finally {
      await watchManager.cleanup()
    }
  }, 25_000)
})

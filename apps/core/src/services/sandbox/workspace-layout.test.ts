import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveWorkspaceLayout,
  resolveContainerWorkRoot,
  containerWorkspaceLayout,
  containerWorkRoot,
  vmWorkspaceLayout,
  hostWorkspaceLayout,
} from './workspace-layout'
import { clearHostWorkspaceOverrides, setHostWorkspaceOverride } from './host/workspace-overrides'
import { getSquadWorkspacePath } from '../squad/workspace'
import { getAgentPrivateStoragePath } from './ensure'
import { WORKSPACE_MOUNT, MEMORY_MOUNT } from './types'
import { boxUnixUser } from '../machines/box-paths'

/**
 * Pin FICUS_SANDBOX_RUNTIME to "unset" (container dispatch) for a describe block
 * whose assertions depend on the ambient runtime, restoring it afterwards —
 * so the suite passes regardless of the environment it runs in.
 */
function pinContainerRuntime(): void {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FICUS_SANDBOX_RUNTIME
    delete process.env.FICUS_SANDBOX_RUNTIME
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })
}

describe('resolveWorkspaceLayout', () => {
  pinContainerRuntime()

  test('returns the legacy /workspace mount (Phase 1a is behavior-preserving)', () => {
    const layout = resolveWorkspaceLayout()
    expect(layout.workspaceMount).toBe(WORKSPACE_MOUNT)
    expect(layout.workspaceMount).toBe('/workspace')
    expect(layout.cwd).toBe('/workspace')
  })

  test('includes privateMount for per-agent private volume', () => {
    const layout = resolveWorkspaceLayout()
    expect(layout.privateMount).toBe('/private')
  })

  test('solo layout (no squadId) is the legacy /workspace + /memory', () => {
    const layout = resolveWorkspaceLayout()
    expect(layout.workspaceMount).toBe('/workspace')
    expect(layout.memoryMount).toBe('/memory')
    expect(layout.cwd).toBe('/workspace')
    expect(layout.privateMount).toBe('/private')
    expect(MEMORY_MOUNT).toBe('/memory')
  })

  test('squad layout namespaces workspace + memory under the squad id', () => {
    const layout = resolveWorkspaceLayout({ squadId: 'sq1' })
    expect(layout.workspaceMount).toBe('/workspace/sq1')
    expect(layout.memoryMount).toBe('/memory/sq1')
    expect(layout.cwd).toBe('/workspace/sq1')
    expect(layout.privateMount).toBe('/private')
  })
})

describe('resolveContainerWorkRoot', () => {
  pinContainerRuntime()

  test('solo (non-squad) agents work in /private — no /workspace', () => {
    expect(resolveContainerWorkRoot()).toBe('/private')
    expect(resolveContainerWorkRoot({})).toBe('/private')
    expect(resolveContainerWorkRoot({ squadId: undefined })).toBe('/private')
  })

  test('squad members + the squad box work in the shared squad workspace', () => {
    expect(resolveContainerWorkRoot({ squadId: 'sq1' })).toBe('/workspace/sq1')
  })

  test('container layout ignores sandboxId (mounts are fixed)', () => {
    expect(containerWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })).toEqual(
      containerWorkspaceLayout({ squadId: 'sq1' })
    )
    expect(containerWorkRoot({ sandboxId: 'agent_a1' })).toBe('/private')
  })
})

describe('vmWorkspaceLayout (box-native paths, derived from the deterministic box user)', () => {
  const home = (sandboxId: string) => `/home/${boxUnixUser(sandboxId)}`

  test('squad-scoped agent: shared workspace + memory in the SQUAD box home, private in its OWN box home', () => {
    const layout = vmWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })
    expect(layout.workspaceMount).toBe(`${home('squad_sq1')}/workspace`)
    expect(layout.cwd).toBe(`${home('squad_sq1')}/workspace`)
    expect(layout.memoryMount).toBe(`${home('squad_sq1')}/memory`)
    expect(layout.privateMount).toBe(`${home('agent_a1')}/.private`)
  })

  test('the squad warm box itself resolves its own home for every area', () => {
    const layout = vmWorkspaceLayout({ squadId: 'sq1', sandboxId: 'squad_sq1' })
    expect(layout.workspaceMount).toBe(`${home('squad_sq1')}/workspace`)
    expect(layout.privateMount).toBe(`${home('squad_sq1')}/.private`)
  })

  test('squad-scoped with no sandboxId still derives the shared paths (squad-box-scoped callers)', () => {
    const layout = vmWorkspaceLayout({ squadId: 'sq1' })
    expect(layout.workspaceMount).toBe(`${home('squad_sq1')}/workspace`)
    expect(layout.memoryMount).toBe(`${home('squad_sq1')}/memory`)
  })

  test('solo agent: work root, cwd, and private are its own ~/.private; memory its own ~/memory', () => {
    const layout = vmWorkspaceLayout({ sandboxId: 'agent_a1' })
    const priv = `${home('agent_a1')}/.private`
    expect(layout.workspaceMount).toBe(priv)
    expect(layout.cwd).toBe(priv)
    expect(layout.privateMount).toBe(priv)
    expect(layout.memoryMount).toBe(`${home('agent_a1')}/memory`)
  })

  test('paths are absolute and never use ~', () => {
    const layout = vmWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })
    for (const p of Object.values(layout)) {
      expect(p.startsWith('/home/box_')).toBe(true)
      expect(p).not.toContain('~')
    }
  })

  test('no identifiers: falls back to the container literals (server-side rebase compatibility)', () => {
    expect(vmWorkspaceLayout({})).toEqual(containerWorkspaceLayout({}))
  })
})

describe('resolveWorkspaceLayout runtime dispatch (FICUS_SANDBOX_RUNTIME)', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FICUS_SANDBOX_RUNTIME
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('k8s + both docker runtimes resolve the container layout (pinned exact values)', () => {
    for (const runtime of ['k8s', 'docker-sysbox', 'docker-socket']) {
      process.env.FICUS_SANDBOX_RUNTIME = runtime
      const layout = resolveWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })
      expect(layout).toEqual({
        workspaceMount: '/workspace/sq1',
        memoryMount: '/memory/sq1',
        cwd: '/workspace/sq1',
        privateMount: '/private',
      })
    }
  })

  test('vm resolves box-native paths', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(resolveWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })).toEqual(
      vmWorkspaceLayout({ squadId: 'sq1', sandboxId: 'agent_a1' })
    )
    expect(resolveContainerWorkRoot({ sandboxId: 'agent_a1' })).toBe(`/home/${boxUnixUser('agent_a1')}/.private`)
  })
})

describe('hostWorkspaceLayout', () => {
  const SQUAD = '11111111-2222-4333-8444-555555555555'
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tau-host-layout-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
  })
  afterEach(() => {
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  test("squad member: storage paths, bash cwd is the workspace, private dir is the agent's", () => {
    const layout = hostWorkspaceLayout({ squadId: SQUAD, sandboxId: 'agent_a1' })
    expect(layout.workspaceMount).toBe(join(home, 'workspaces', 'squads', SQUAD))
    expect(layout.workspaceMount).toBe(getSquadWorkspacePath(SQUAD))
    expect(layout.cwd).toBe(layout.workspaceMount)
    expect(layout.privateMount).toBe(join(home, 'private', 'agent_a1'))
    expect(layout.privateMount).toBe(getAgentPrivateStoragePath('agent_a1'))
    expect(layout.memoryMount).toBe(join(home, 'memory', SQUAD))
  })

  test('squad override replaces only the workspace', () => {
    setHostWorkspaceOverride(SQUAD, '/srv/my-repo')
    const layout = hostWorkspaceLayout({ squadId: SQUAD, sandboxId: 'agent_a1' })
    expect(layout.workspaceMount).toBe('/srv/my-repo')
    expect(layout.cwd).toBe('/srv/my-repo')
    expect(layout.privateMount).toBe(join(home, 'private', 'agent_a1'))
    expect(layout.memoryMount).toBe(join(home, 'memory', SQUAD))
  })

  test('solo agent: everything is the private dir', () => {
    const layout = hostWorkspaceLayout({ sandboxId: 'system_manager_u1' })
    const priv = join(home, 'private', 'system_manager_u1')
    expect(layout).toEqual({ workspaceMount: priv, cwd: priv, privateMount: priv, memoryMount: join(home, 'memory') })
  })

  test('no ids: falls back to the container literals', () => {
    expect(hostWorkspaceLayout({})).toEqual(containerWorkspaceLayout({}))
  })

  test('resolveWorkspaceLayout dispatches to host under FICUS_SANDBOX_RUNTIME=host', () => {
    expect(resolveWorkspaceLayout({ sandboxId: 'agent_x' }).privateMount).toBe(join(home, 'private', 'agent_x'))
  })
})

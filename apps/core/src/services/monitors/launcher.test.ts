import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { monitorWorkRoot } from './launcher'
import { setHostWorkspaceOverride, clearHostWorkspaceOverrides } from '../sandbox/host/workspace-overrides'
import { boxHome } from '../machines/box-paths'

const SQUAD = '11111111-2222-3333-4444-555555555555'

describe('monitorWorkRoot', () => {
  let prevRuntime: string | undefined
  let prevHome: string | undefined
  let home: string

  beforeEach(() => {
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    prevHome = process.env.HOME_DIR
    home = mkdtempSync(join(tmpdir(), 'tau-monitor-root-'))
    process.env.HOME_DIR = home
    clearHostWorkspaceOverrides()
  })

  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    clearHostWorkspaceOverrides()
  })

  it('container runtimes: the fixed /workspace mounts', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    expect(monitorWorkRoot({ squadId: SQUAD, sandboxId: 'agent_a1' })).toBe(`/workspace/${SQUAD}`)
    expect(monitorWorkRoot({ sandboxId: 'agent_a1' })).toBe('/workspace')
  })

  it("vm runtime: the monitor's OWN box work root, never the squad box workspace", () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(monitorWorkRoot({ squadId: SQUAD, sandboxId: 'agent_a1' })).toBe(`${boxHome('agent_a1')}/.private`)
  })

  it('host runtime: the squad workspace on the real filesystem, honouring an override', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    // No override: the storage workspace, NOT the container literal.
    expect(monitorWorkRoot({ squadId: SQUAD, sandboxId: 'agent_a1' })).toBe(join(home, 'workspaces', 'squads', SQUAD))

    const override = join(home, 'repos', 'acme')
    setHostWorkspaceOverride(SQUAD, override)
    expect(monitorWorkRoot({ squadId: SQUAD, sandboxId: 'agent_a1' })).toBe(override)
  })

  it('host runtime: a solo monitor roots in its own private dir', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    expect(monitorWorkRoot({ sandboxId: 'agent_solo' })).toBe(join(home, 'private', 'agent_solo'))
  })
})

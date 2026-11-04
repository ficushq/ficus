import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LAUNCHER_SCRIPT,
  MONITOR_TOKEN_FILE,
  monitorTokenFileCommand,
  monitorWorkRoot,
  sessionNameForMonitor,
} from './launcher'
import { LAUNCH_PATH_FILE } from '../sandbox/launch-path'
import { runCapturedProcess } from '../../test-utils/captured-process'
import { setHostWorkspaceOverride, clearHostWorkspaceOverrides } from '../sandbox/host/workspace-overrides'
import { boxHome } from '../machines/box-paths'

const SQUAD = '11111111-2222-4333-8444-555555555555'

describe('monitorWorkRoot', () => {
  let prevRuntime: string | undefined
  let prevHome: string | undefined
  let home: string

  beforeEach(() => {
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    prevHome = process.env.HOME_DIR
    home = mkdtempSync(join(tmpdir(), 'ficus-monitor-root-'))
    process.env.HOME_DIR = home
    clearHostWorkspaceOverrides()
  })

  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    clearHostWorkspaceOverrides()
    rmSync(home, { recursive: true, force: true })
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

  it('vm runtime: a selected squad box uses its own workspace even if the agent changes squads', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(monitorWorkRoot({ squadId: 'other-squad', sandboxId: `squad_${SQUAD}` })).toBe(
      `${boxHome(`squad_${SQUAD}`)}/workspace`
    )
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

it('gives new monitors canonical session identities', () => {
  expect(sessionNameForMonitor('abcdef12-1234-4234-8234-123456789abc')).toBe('ficus-monitor-abcdef12')
})

describe('monitor command credentials', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ficus-monitor-token-'))
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, LAUNCH_PATH_FILE), '/usr/bin:/bin')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** The launch command's token step, then the launcher, exactly as the supervisor runs them (minus tmux). */
  async function launch(token: string | undefined) {
    writeFileSync(join(dir, 'run.sh'), LAUNCHER_SCRIPT, { mode: 0o755 })
    const shell = `${monitorTokenFileCommand(dir)}\necho "launch-env:\${FICUS_MONITOR_TOKEN-unset}" >&2\nexec bash run.sh`
    return runCapturedProcess(['bash', '-c', shell], {
      cwd: dir,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dir,
        ...(token ? { FICUS_MONITOR_TOKEN: token } : {}),
        FICUS_MONITOR_DIR: dir,
        FICUS_MONITOR_CWD: dir,
        FICUS_MONITOR_TIMEOUT_SECONDS: '30',
        FICUS_MONITOR_API_URL: 'http://core.test:3000',
        FICUS_MONITOR_SQUAD_ID: SQUAD,
        FICUS_MONITOR_COMMAND:
          'echo "token=${FICUS_TOKEN-none} api=${FICUS_API_URL-none} squad=${FICUS_SQUAD_ID-none} context=${FICUS_AGENT_CONTEXT-none}"',
      },
      timeoutMs: 10_000,
    })
  }

  it('hands the token to the command only, through an owner-only file, with the Core URL and squad', async () => {
    const result = await launch('ficus_agent_monitor-secret')
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    // Dropped from the launch environment before tmux (here: the launcher) starts.
    expect(result.stderr).toContain('launch-env:unset')
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe(
      `token=ficus_agent_monitor-secret api=http://core.test:3000 squad=${SQUAD} context=1\n`
    )
    expect(readFileSync(join(dir, MONITOR_TOKEN_FILE), 'utf8')).toBe('ficus_agent_monitor-secret')
    expect(statSync(join(dir, MONITOR_TOKEN_FILE)).mode & 0o777).toBe(0o600)
  })

  it('a launch without a token removes the previous launch token and runs without one', async () => {
    writeFileSync(join(dir, MONITOR_TOKEN_FILE), 'ficus_agent_stale', { mode: 0o600 })
    const result = await launch(undefined)
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe(
      `token=none api=http://core.test:3000 squad=${SQUAD} context=none\n`
    )
    expect(() => statSync(join(dir, MONITOR_TOKEN_FILE))).toThrow()
  })
})

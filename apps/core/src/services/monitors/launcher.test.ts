import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LAUNCHER_SCRIPT,
  MONITOR_TOKEN_DIR,
  monitorTokenCleanupCommand,
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
  const MONITOR_ID = 'cccccccc-dddd-4eee-8fff-000000000000'
  const SECRET = 'ficus_agent_monitor-secret'
  let root: string
  /** The served tree: workspace with the monitor's work dir inside it. */
  let workspace: string
  let dir: string
  /** The box user's home: served by no route. */
  let home: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-monitor-token-'))
    workspace = join(root, 'workspace')
    dir = join(workspace, '.ficus', 'monitors', MONITOR_ID)
    home = join(root, 'home')
    mkdirSync(join(dir, 'logs'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(dir, LAUNCH_PATH_FILE), '/usr/bin:/bin')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const handOff = () => join(home, MONITOR_TOKEN_DIR, MONITOR_ID)

  /** Every file under a tree whose contents include the token. */
  function filesHoldingToken(tree: string): string[] {
    return readdirSync(tree, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => readFileSync(file, 'utf8').includes(SECRET))
  }

  function env(extra: Record<string, string | undefined> = {}) {
    return {
      PATH: '/usr/bin:/bin',
      HOME: home,
      FICUS_MONITOR_ID: MONITOR_ID,
      FICUS_MONITOR_DIR: dir,
      FICUS_MONITOR_CWD: workspace,
      FICUS_MONITOR_TIMEOUT_SECONDS: '30',
      FICUS_MONITOR_API_URL: 'http://core.test:3000',
      FICUS_MONITOR_SQUAD_ID: SQUAD,
      FICUS_MONITOR_COMMAND:
        // Reversed, so the token itself never lands in the (workspace) log this test scans.
        'echo "token=$(printf %s "${FICUS_TOKEN-enon}" | rev) api=${FICUS_API_URL-none} squad=${FICUS_SQUAD_ID-none} context=${FICUS_AGENT_CONTEXT-none}"',
      ...extra,
    }
  }

  /** The launch command's token step under `set -e`, then the launcher, as the supervisor runs them (minus tmux). */
  async function launch(token: string | undefined, extra: Record<string, string | undefined> = {}) {
    writeFileSync(join(dir, 'run.sh'), LAUNCHER_SCRIPT, { mode: 0o755 })
    const shell = `set -e\n${monitorTokenFileCommand(MONITOR_ID)}\necho "launch-env:\${FICUS_MONITOR_TOKEN-unset}" >&2\nexec bash run.sh`
    return runCapturedProcess(['bash', '-c', shell], {
      cwd: dir,
      env: env({ ...(token ? { FICUS_MONITOR_TOKEN: token } : {}), ...extra }),
      timeoutMs: 10_000,
    })
  }

  it('hands the token to the command only, with the Core URL and squad, and never through the workspace', async () => {
    const result = await launch(SECRET)
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    // Dropped from the launch environment before tmux (here: the launcher) starts.
    expect(result.stderr).toContain('launch-env:unset')
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe(
      `token=${[...SECRET].reverse().join('')} api=http://core.test:3000 squad=${SQUAD} context=1\n`
    )
    // The command consumed the hand-off file, and nothing a workspace:read
    // caller can fetch (the workspace, including the monitor work dir) ever held it.
    expect(existsSync(handOff())).toBe(false)
    expect(filesHoldingToken(workspace)).toEqual([])
  })

  it('writes the hand-off file owner-only under $HOME, outside the workspace', async () => {
    const result = await runCapturedProcess(['bash', '-c', `set -e\n${monitorTokenFileCommand(MONITOR_ID)}`], {
      env: env({ FICUS_MONITOR_TOKEN: SECRET }),
      timeoutMs: 5000,
    })
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    expect(readFileSync(handOff(), 'utf8')).toBe(SECRET)
    expect(statSync(handOff()).mode & 0o777).toBe(0o600)
    expect(filesHoldingToken(workspace)).toEqual([])
    // Killing an unconsumed launch removes it.
    expect(
      await runCapturedProcess(['bash', '-c', monitorTokenCleanupCommand(MONITOR_ID)], { env: env(), timeoutMs: 5000 })
    ).toMatchObject({ kind: 'exited', code: 0 })
    expect(existsSync(handOff())).toBe(false)
  })

  it('a launch without a token removes a stale hand-off file and runs without one', async () => {
    mkdirSync(join(home, MONITOR_TOKEN_DIR))
    writeFileSync(handOff(), 'ficus_agent_stale', { mode: 0o600 })
    const result = await launch(undefined)
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe(
      `token=none api=http://core.test:3000 squad=${SQUAD} context=none\n`
    )
    expect(existsSync(handOff())).toBe(false)
  })

  it('without a usable $HOME nothing is written and the launch still runs the command', async () => {
    const result = await launch(SECRET, { HOME: undefined })
    expect(result).toMatchObject({ kind: 'exited', code: 0 })
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe(
      `token=none api=http://core.test:3000 squad=${SQUAD} context=none\n`
    )
    expect(filesHoldingToken(root)).toEqual([])
  })
})

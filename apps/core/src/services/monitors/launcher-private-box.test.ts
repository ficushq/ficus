/**
 * The monitor launch and probe commands, run by real bash in a PRIVATE agent
 * box layout (a solo `agent_*` sandbox on the host runtime), against a fake
 * tmux (see tmux-fake.test-helper.ts). Reproduces the incident on an agent box:
 * a stale devbox tmux 3.7 server on the default socket hosting an old monitor,
 * the devbox tmux first on PATH, and /usr/bin/tmux 3.4 as the system tmux.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTmuxCandidatesForTesting, TMUX_UNREACHABLE_MARKER } from '../sandbox/tmux'
import { createFakeTmuxBox, type FakeTmuxBox } from '../sandbox/tmux-fake.test-helper'
import {
  MONITOR_LOG_SIZE_MARKER,
  MONITOR_PROCESS_GONE,
  monitorDir,
  monitorLaunchCommand,
  monitorProbeCommand,
  monitorWorkRoot,
  sessionNameForMonitor,
} from './launcher'

const SANDBOX = 'agent_5a5a5a5a'
const NEW_MONITOR = 'aaaaaaaa-1111-4222-8333-444444444444'
const OLD_MONITOR = 'bbbbbbbb-1111-4222-8333-444444444444'

describe('monitor commands in a private agent box with a stale tmux server of another version', () => {
  let root: string
  let box: FakeTmuxBox
  let systemTmux: string
  let devboxTmux: string
  let prevRuntime: string | undefined
  let prevHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-monitor-private-'))
    box = createFakeTmuxBox(root)
    systemTmux = box.install(join(root, 'system-bin', 'tmux'), '3.4')
    devboxTmux = box.install(join(root, 'devbox-bin', 'tmux'), '3.7')
    mkdirSync(join(root, 'user-bin'))
    writeFileSync(join(root, 'user-bin', 'ficus-user-tool'), '#!/bin/sh\necho "user tool ran"\n')
    chmodSync(join(root, 'user-bin', 'ficus-user-tool'), 0o755)
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    prevHome = process.env.HOME_DIR
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.HOME_DIR = root
    // The incident: the old monitor's session lives on a devbox tmux 3.7 server.
    box.seedSession('default', '3.7', sessionNameForMonitor(OLD_MONITOR))
    mkdirSync(join(dirFor(OLD_MONITOR), 'logs'), { recursive: true })
  })

  afterEach(() => {
    setTmuxCandidatesForTesting(null)
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  function dirFor(monitorId: string): string {
    return monitorDir(monitorWorkRoot({ sandboxId: SANDBOX }), monitorId)
  }

  function run(command: string) {
    const result = Bun.spawnSync(['/bin/bash', '-c', command], {
      env: {
        PATH: `${join(root, 'devbox-bin')}:${join(root, 'user-bin')}:/usr/bin:/bin`,
        HOME: root,
        FAKE_TMUX_STATE: box.state,
      },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  function launch(monitorId: string, command: string) {
    const dir = dirFor(monitorId)
    return run(
      monitorLaunchCommand({
        dir,
        logFile: `${dir}/logs/current.log`,
        processId: sessionNameForMonitor(monitorId),
        env: {
          FICUS_MONITOR_ID: monitorId,
          FICUS_MONITOR_CWD: root,
          FICUS_MONITOR_DIR: dir,
          FICUS_MONITOR_COMMAND: command,
          FICUS_MONITOR_TIMEOUT_SECONDS: '60',
        },
      })
    )
  }

  const probe = (monitorId: string) =>
    run(monitorProbeCommand(dirFor(monitorId), sessionNameForMonitor(monitorId))).stdout.trim()

  it('creates a new monitor with the pinned tmux on the Ficus socket despite the stale server', () => {
    setTmuxCandidatesForTesting([systemTmux])
    const out = launch(NEW_MONITOR, 'ficus-user-tool; echo "path=$PATH"; exit 3')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain(`${MONITOR_LOG_SIZE_MARKER}0`)
    expect(box.hasSession('ficus', sessionNameForMonitor(NEW_MONITOR))).toBe(true)
    expect(box.serverVersion('ficus')).toBe('3.4')
    // The devbox tmux first on PATH never ran, and the stale server is untouched.
    expect(box.callers()).not.toContain(devboxTmux)
    expect(box.hasSession('default', sessionNameForMonitor(OLD_MONITOR))).toBe(true)

    // The command ran with the caller's PATH, not the bare tmux-server one.
    const log = readFileSync(join(dirFor(NEW_MONITOR), 'logs', 'current.log'), 'utf8')
    expect(log).toContain('user tool ran')
    expect(log).toContain(join(root, 'user-bin'))
    expect(probe(NEW_MONITOR)).toBe('3')
  })

  it('reports an old monitor on a server no installed tmux can reach as unreachable, not lost', () => {
    setTmuxCandidatesForTesting([systemTmux])
    const answer = probe(OLD_MONITOR)
    expect(answer).not.toBe(MONITOR_PROCESS_GONE)
    expect(answer).toStartWith(TMUX_UNREACHABLE_MARKER)
    expect(answer).toContain('server exited unexpectedly')
  })

  it('still sees the old monitor alive when the tmux that started its server is installed', () => {
    setTmuxCandidatesForTesting([systemTmux, devboxTmux])
    expect(probe(OLD_MONITOR)).toBe('')
    box.seedSession('default', '3.7', 'unrelated')
    run(`rm -f ${box.state}/servers/default/sessions/${sessionNameForMonitor(OLD_MONITOR)}`)
    expect(probe(OLD_MONITOR)).toBe(MONITOR_PROCESS_GONE)
    expect(existsSync(dirFor(OLD_MONITOR))).toBe(true)
  })
})

/**
 * The monitor launcher, executed FOR REAL on the host runtime.
 *
 * Every other monitor test drives MonitorSupervisor through a FakeSandbox
 * whose `exec` only records argv — so LAUNCHER_SCRIPT itself was never once
 * run by the suite, and a GNU-only `date -Is` in it (fatal under `set -e` on
 * BSD/macOS) killed every monitor on its fourth line while 100% of the monitor
 * tests stayed green. These tests run the exact command the supervisor builds
 * through a real HostSandboxManager and assert the observable contract the
 * supervisor depends on: log lines stream, and `exitCode` lands.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxManager } from '../sandbox/host/manager'
import { clearHostWorkspaceOverrides } from '../sandbox/host/workspace-overrides'
import { LAUNCHER_SCRIPT, monitorDir, monitorWorkRoot, shellQuote } from './launcher'

const SQUAD = '77777777-2222-4333-8444-555555555555'
const SANDBOX = `agent_${'a'.repeat(8)}`

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(50)
  }
}

describe('monitor launcher on the host runtime', () => {
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined
  let manager: HostSandboxManager

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'tau-monitor-host-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    manager = new HostSandboxManager({ baseEnv: () => ({ PATH: process.env.PATH!, HOME: home }) })
    await manager.ensureSandbox(SANDBOX, { workspacePath: '', squadId: SQUAD })
  })

  afterEach(async () => {
    await manager.cleanup()
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  /** Byte-for-byte the launch command MonitorSupervisor.launch() builds, minus tmux. */
  function launchCommand(monitorId: string, command: string): { command: string; dir: string } {
    const workRoot = monitorWorkRoot({ squadId: SQUAD, sandboxId: SANDBOX })
    const dir = monitorDir(workRoot, monitorId)
    const script = `${dir}/run.sh`
    const envPrefix = [
      `FICUS_MONITOR_ID=${shellQuote(monitorId)}`,
      `FICUS_MONITOR_CWD=${shellQuote(workRoot)}`,
      `FICUS_MONITOR_DIR=${shellQuote(dir)}`,
      `FICUS_MONITOR_COMMAND=${shellQuote(command)}`,
      `bash ${shellQuote(script)}`,
    ].join(' ')
    return {
      dir,
      command: [
        'set -e',
        `mkdir -p ${shellQuote(`${dir}/logs`)}`,
        `cat > ${shellQuote(script)} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
        `chmod +x ${shellQuote(script)}`,
        // The supervisor backgrounds this under tmux; `&` keeps the test free
        // of a tmux dependency while running the identical launcher.
        `${envPrefix} </dev/null >/dev/null 2>&1 &`,
      ].join('\n'),
    }
  }

  test('the launcher runs the monitored command, streams its output, and records exitCode', async () => {
    const monitorId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const { command, dir } = launchCommand(monitorId, 'echo watched-line; exit 7')

    // The supervisor's own streamLogs command, verbatim.
    const logFile = `${dir}/logs/current.log`
    const streamCommand = `mkdir -p ${shellQuote(`${dir}/logs`)} && touch ${shellQuote(logFile)} && tail -n 0 -F ${shellQuote(logFile)}`
    const lines: string[] = []
    const stderr: string[] = []
    const sub = manager.streamExec!(
      SANDBOX,
      ['bash', '-lc', streamCommand],
      (chunk) => lines.push(...chunk.toString().split('\n').filter(Boolean)),
      (chunk) => stderr.push(chunk.toString())
    )

    try {
      await Bun.sleep(300) // let tail attach before the launcher writes
      await manager.exec(SANDBOX, ['bash', '-lc', command])
      await waitFor(() => lines.includes('watched-line'))
      expect(lines).toContain('watched-line')

      // The supervisor's pollExit probe, verbatim — it is the only signal that
      // ends a monitor, so a launcher that dies early hangs it in 'running'.
      let probe = ''
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        probe = (
          await manager.exec(SANDBOX, [
            'bash',
            '-lc',
            `if [ ! -d ${shellQuote(dir)} ]; then echo __MONITOR_DIR_GONE__; ` +
              `elif [ -f ${shellQuote(`${dir}/exitCode`)} ]; then cat ${shellQuote(`${dir}/exitCode`)}; fi`,
          ])
        )
          .toString()
          .trim()
        if (probe !== '') break
        await Bun.sleep(100)
      }
      expect(probe).toBe('7')
    } finally {
      sub.cancel()
    }
  }, 20000)

  test('the launcher writes a non-empty startedAt timestamp on this platform', async () => {
    const monitorId = 'bbbbbbbb-cccc-4ddd-8eee-fffffffffff1'
    const { command, dir } = launchCommand(monitorId, 'true')
    await manager.exec(SANDBOX, ['bash', '-lc', command])
    await waitFor(() => Bun.file(`${dir}/exitCode`).size > 0)
    // `date -Is` is GNU-only: on BSD it exits 1, leaving this file created but
    // EMPTY by the redirection — and, under `set -e`, killing the run.
    const startedAt = (await Bun.file(`${dir}/startedAt`).text()).trim()
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  }, 20000)
})

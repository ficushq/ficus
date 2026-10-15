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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxManager } from '../sandbox/host/manager'
import { recordLaunchPathCommand } from '../sandbox/launch-path'
import { clearHostWorkspaceOverrides } from '../sandbox/host/workspace-overrides'
import {
  LAUNCHER_SCRIPT,
  MONITOR_KILL_GRACE_SECONDS,
  MONITOR_TIMED_OUT_FILE,
  MONITOR_TIMEOUT_EXIT_CODE,
  monitorDir,
  monitorWorkRoot,
  shellQuote,
} from './launcher'

const SQUAD = '77777777-2222-4333-8444-555555555555'
const LAUNCHER_PID_MARKER = '__LAUNCHER_PID__='
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
    home = mkdtempSync(join(tmpdir(), 'ficus-monitor-host-'))
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

  /**
   * Byte-for-byte the launch command MonitorSupervisor.launch() builds, minus
   * tmux. `toolDir` goes on the caller's PATH only, and the launcher then runs
   * with a bare environment — what a tmux server started without it hands a
   * new session.
   */
  function launchCommand(
    monitorId: string,
    command: string,
    opts: { toolDir?: string; timeoutSeconds?: number } = {}
  ): { command: string; dir: string } {
    const workRoot = monitorWorkRoot({ squadId: SQUAD, sandboxId: SANDBOX })
    const dir = monitorDir(workRoot, monitorId)
    const script = `${dir}/run.sh`
    const envPrefix = [
      `FICUS_MONITOR_ID=${shellQuote(monitorId)}`,
      `FICUS_MONITOR_CWD=${shellQuote(workRoot)}`,
      `FICUS_MONITOR_DIR=${shellQuote(dir)}`,
      `FICUS_MONITOR_COMMAND=${shellQuote(command)}`,
      `FICUS_MONITOR_TIMEOUT_SECONDS=${opts.timeoutSeconds ?? 3600}`,
      `bash ${shellQuote(script)}`,
    ].join(' ')
    const launcherEnv = opts.toolDir ? `env -i PATH=/usr/bin:/bin HOME=${shellQuote(home)} ` : ''
    return {
      dir,
      command: [
        'set -e',
        ...(opts.toolDir ? [`export PATH=${shellQuote(opts.toolDir)}:"$PATH"`] : []),
        `mkdir -p ${shellQuote(`${dir}/logs`)}`,
        `cat > ${shellQuote(script)} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
        `chmod +x ${shellQuote(script)}`,
        recordLaunchPathCommand(dir),
        // The supervisor backgrounds this under tmux; `&` keeps the test free
        // of a tmux dependency while running the identical launcher.
        `${launcherEnv}${envPrefix} </dev/null >/dev/null 2>&1 &`,
        `echo "${LAUNCHER_PID_MARKER}$!"`,
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

  test('the monitored command finds tools on the PATH the start command ran with', async () => {
    const toolDir = join(home, 'toolchain-bin')
    mkdirSync(toolDir)
    // A name no host login profile can put on PATH.
    writeFileSync(join(toolDir, 'ficus-test-watch'), '#!/bin/sh\necho "toolchain watch $*"\n')
    chmodSync(join(toolDir, 'ficus-test-watch'), 0o755)
    const monitorId = 'bbbbbbbb-cccc-4ddd-8eee-fffffffffff2'
    const { command, dir } = launchCommand(monitorId, 'ficus-test-watch logs', { toolDir })

    await manager.exec(SANDBOX, ['bash', '-lc', command])
    await waitFor(() => Bun.file(`${dir}/exitCode`).size > 0)

    expect(await Bun.file(`${dir}/logs/current.log`).text()).toContain('toolchain watch logs')
    expect((await Bun.file(`${dir}/exitCode`).text()).trim()).toBe('0')
  }, 20000)

  describe('in-sandbox deadline watchdog (no Core involved)', () => {
    /** Start the launcher; returns its pid and the monitor dir. Nothing supervises it afterwards. */
    async function launch(monitorId: string, command: string, timeoutSeconds: number) {
      const { command: start, dir } = launchCommand(monitorId, command, { timeoutSeconds })
      const out = (await manager.exec(SANDBOX, ['bash', '-lc', start])).toString()
      const pid = Number(out.split(LAUNCHER_PID_MARKER)[1])
      expect(pid).toBeGreaterThan(0)
      return { dir, launcherPid: pid }
    }

    /** Pids the monitored command recorded (one per line) in `<dir>/pids`. */
    async function recordedPids(dir: string, count: number): Promise<number[]> {
      await waitFor(
        () => existsSync(`${dir}/pids`) && readFileSync(`${dir}/pids`, 'utf8').trim().split('\n').length >= count
      )
      return readFileSync(`${dir}/pids`, 'utf8').trim().split('\n').map(Number)
    }

    // A pipeline that never ends on its own, plus a background child: the
    // whole process group must go, not just the launcher's direct child.
    // (`sh -c 'echo $$; exec ...'` records each stage's pid portably.)
    const PIPELINE =
      'sleep 300 & echo $! >> "$FICUS_MONITOR_DIR/pids"; touch "$FICUS_MONITOR_DIR/watched"; ' +
      `sh -c 'echo $$ >> "$FICUS_MONITOR_DIR/pids"; exec tail -F "$FICUS_MONITOR_DIR/watched"' | ` +
      `sh -c 'echo $$ >> "$FICUS_MONITOR_DIR/pids"; exec grep --line-buffered NEVER-MATCHES'`

    test('kills the whole process group at the deadline and records a timed-out exit', async () => {
      const { dir } = await launch('cccccccc-cccc-4ddd-8eee-000000000001', PIPELINE, 1)
      const pids = await recordedPids(dir, 3)
      expect(pids.every(isAlive)).toBe(true)

      await waitFor(() => existsSync(`${dir}/exitCode`))
      expect(readFileSync(`${dir}/exitCode`, 'utf8').trim()).toBe(String(MONITOR_TIMEOUT_EXIT_CODE))
      expect(existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`)).toBe(true)
      await waitFor(() => !pids.some(isAlive))
      expect(pids.filter(isAlive)).toEqual([])
    }, 20000)

    test('SIGKILLs a command that ignores SIGTERM after the grace period', async () => {
      const { dir } = await launch(
        'cccccccc-cccc-4ddd-8eee-000000000002',
        'trap "" TERM; echo $$ >> "$FICUS_MONITOR_DIR/pids"; while :; do sleep 1; done',
        1
      )
      const [pid] = await recordedPids(dir, 1)
      await waitFor(() => existsSync(`${dir}/exitCode`), (MONITOR_KILL_GRACE_SECONDS + 6) * 1000)
      expect(readFileSync(`${dir}/exitCode`, 'utf8').trim()).toBe(String(MONITOR_TIMEOUT_EXIT_CODE))
      expect(isAlive(pid)).toBe(false)
    }, 30000)

    test('still enforces the deadline when the launcher itself is killed', async () => {
      const { dir, launcherPid } = await launch('cccccccc-cccc-4ddd-8eee-000000000003', PIPELINE, 2)
      const pids = await recordedPids(dir, 3)
      process.kill(launcherPid, 'SIGKILL')
      await waitFor(() => existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`))
      expect(existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`)).toBe(true)
      await waitFor(() => !pids.some(isAlive))
      expect(pids.filter(isAlive)).toEqual([])
    }, 20000)

    test('stops the command (as a loss, no marker) when the launcher is killed before the deadline', async () => {
      const { dir, launcherPid } = await launch('cccccccc-cccc-4ddd-8eee-000000000006', PIPELINE, 3600)
      const pids = await recordedPids(dir, 3)
      process.kill(launcherPid, 'SIGKILL')
      // The watchdog rechecks at least every 10s.
      await waitFor(() => !pids.some(isAlive), 15000)
      expect(pids.filter(isAlive)).toEqual([])
      expect(existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`)).toBe(false)
      expect(existsSync(`${dir}/exitCode`)).toBe(false)
    }, 30000)

    test('a session kill (SIGHUP) stops the command group without recording an exit', async () => {
      const { dir, launcherPid } = await launch('cccccccc-cccc-4ddd-8eee-000000000004', PIPELINE, 3600)
      const pids = await recordedPids(dir, 3)
      process.kill(launcherPid, 'SIGHUP')
      await waitFor(() => !pids.some(isAlive) && !isAlive(launcherPid))
      expect(pids.filter(isAlive)).toEqual([])
      // No exitCode and no timeout marker: Core's cancel/timeout owns the outcome.
      expect(existsSync(`${dir}/exitCode`)).toBe(false)
      expect(existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`)).toBe(false)
    }, 20000)

    test('a command that finishes in time records its own exit and leaves nothing running', async () => {
      const { dir, launcherPid } = await launch(
        'cccccccc-cccc-4ddd-8eee-000000000005',
        'echo $$ >> "$FICUS_MONITOR_DIR/pids"; echo done; exit 3',
        3600
      )
      await waitFor(() => existsSync(`${dir}/exitCode`))
      expect(readFileSync(`${dir}/exitCode`, 'utf8').trim()).toBe('3')
      expect(existsSync(`${dir}/${MONITOR_TIMED_OUT_FILE}`)).toBe(false)
      // The watchdog (a forked copy of the launcher, so its argv names run.sh) went with it.
      await waitFor(() => !isAlive(launcherPid) && processesRunning(`${dir}/run.sh`).length === 0)
      expect(isAlive(launcherPid)).toBe(false)
      expect(processesRunning(`${dir}/run.sh`)).toEqual([])
    }, 20000)
  })
})

/** Live processes whose command line mentions `needle`. */
function processesRunning(needle: string): string[] {
  const out = Bun.spawnSync(['ps', '-eo', 'pid=,args=']).stdout.toString()
  return out.split('\n').filter((line) => line.includes(needle))
}

/** Running (a zombie awaiting its reaper counts as gone: it has already exited). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const stat = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)])
    .stdout.toString()
    .trim()
  return stat !== '' && !stat.startsWith('Z')
}

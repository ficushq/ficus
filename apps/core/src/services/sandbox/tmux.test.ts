import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TMUX_CANDIDATES,
  TMUX_UNREACHABLE_EXIT_CODE,
  TMUX_UNREACHABLE_MARKER,
  TmuxServerUnreachableError,
  tmuxShellFunctions,
  tmuxUnreachableFromOutput,
} from './tmux'
import { createFakeTmuxBox, type FakeTmuxBox } from './tmux-fake.test-helper'

describe('pinned tmux shell functions', () => {
  let root: string
  let box: FakeTmuxBox
  let systemTmux: string
  let devboxTmux: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-tmux-'))
    box = createFakeTmuxBox(root)
    systemTmux = box.install(join(root, 'system-bin', 'tmux'), '3.4')
    devboxTmux = box.install(join(root, 'devbox-bin', 'tmux'), '3.7')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** Run `body` after the functions, with the devbox tmux FIRST on PATH. */
  function run(body: string, candidates: readonly string[] = [systemTmux, devboxTmux]) {
    const result = Bun.spawnSync(['bash', '-c', `${tmuxShellFunctions(candidates)}\n${body}`], {
      env: { PATH: `${join(root, 'devbox-bin')}:/usr/bin:/bin`, HOME: root, FAKE_TMUX_STATE: box.state },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  const status = (call: string) => `s=0; ${call} || s=$?; echo "status=$s"`

  it('uses the first installed candidate, not the tmux first on PATH', () => {
    const out = run(
      [
        status("ficus_tmux_new app 'true'"),
        status('ficus_tmux_has app'),
        status('ficus_tmux_kill app'),
        'echo "pinned=$FICUS_TMUX"',
      ].join('\n')
    )
    expect(out.stdout).toBe(`status=0\nstatus=0\nstatus=0\npinned=${systemTmux}\n`)
    expect(new Set(box.callers())).toEqual(new Set([systemTmux]))
    // Created on Ficus's own socket by the pinned binary.
    expect(box.serverVersion('ficus')).toBe('3.4')
    expect(box.serverVersion('default')).toBeNull()
  })

  it('falls back to PATH only when no fixed location has tmux', () => {
    const out = run('echo "pinned=$FICUS_TMUX"', [join(root, 'missing', 'tmux')])
    expect(out.stdout).toBe(`pinned=${devboxTmux}\n`)
  })

  it('reports a session that exists on neither socket as missing', () => {
    expect(run(status('ficus_tmux_has app')).stdout).toBe('status=1\n')
    expect(run(status('ficus_tmux_kill app')).stdout).toBe('status=0\n')
  })

  it('finds and stops a session created on the legacy default socket before the upgrade', () => {
    box.seedSession('default', '3.4', 'app')
    expect(run(status('ficus_tmux_has app')).stdout).toBe('status=0\n')
    expect(run(status('ficus_tmux_kill app')).stdout).toBe('status=0\n')
    expect(box.hasSession('default', 'app')).toBe(false)
  })

  it('reaches a stale server of another version with the tmux that started it, never starting one', () => {
    // The incident: a devbox tmux 3.7 server on the default socket.
    box.seedSession('default', '3.7', 'app')
    expect(run(status('ficus_tmux_has app')).stdout).toBe('status=0\n')
    // New sessions go to Ficus's socket with the pinned binary; the stale server is untouched.
    expect(run(status("ficus_tmux_new other 'true'")).stdout).toBe('status=0\n')
    expect(box.serverVersion('ficus')).toBe('3.4')
    expect(box.hasSession('default', 'app')).toBe(true)
    expect(run(status('ficus_tmux_kill app')).stdout).toBe('status=0\n')
    expect(box.hasSession('default', 'app')).toBe(false)
  })

  it('reports a server no installed tmux can reach as unreachable, never as missing', () => {
    box.seedSession('default', '3.7', 'app')
    const has = run(`${status('ficus_tmux_has app')}\necho "error=$ficus_tmux_error"`, [systemTmux])
    expect(has.stdout).toContain('status=2\n')
    expect(has.stdout).toContain('server exited unexpectedly')
    expect(run(status('ficus_tmux_kill app'), [systemTmux]).stdout).toBe('status=2\n')

    const fail = run('ficus_tmux_has app || ficus_tmux_unreachable', [systemTmux])
    expect(fail.exitCode).toBe(TMUX_UNREACHABLE_EXIT_CODE)
    expect(fail.stdout).toContain(TMUX_UNREACHABLE_MARKER)
    expect(fail.stderr).toContain(TMUX_UNREACHABLE_MARKER)
    const error = tmuxUnreachableFromOutput(`Command failed with exit code 86: ${fail.stderr}`)
    expect(error).toBeInstanceOf(TmuxServerUnreachableError)
    expect(error!.message).toContain('version mismatch')
    expect(error!.message).toContain('server exited unexpectedly')
  })

  it('reports creating a session on a Ficus server of another version as unreachable', () => {
    box.seedSession('ficus', '3.7', 'old')
    expect(run(status("ficus_tmux_new app 'true'"), [systemTmux]).stdout).toBe('status=2\n')
    // Creation never falls back to another binary.
    expect(box.callers()).toEqual([systemTmux])
  })

  it('reports a box without tmux as unreachable', () => {
    const out = Bun.spawnSync(
      ['/bin/bash', '-c', `${tmuxShellFunctions([join(root, 'missing')])}\n${status('ficus_tmux_has app')}`],
      { env: { PATH: '/nonexistent', HOME: root } }
    )
    expect(out.stdout.toString()).toBe('status=2\n')
  })

  it('looks in system locations before nix and devbox profiles', () => {
    expect(TMUX_CANDIDATES[0]).toBe('/usr/bin/tmux')
    const devbox = TMUX_CANDIDATES.findIndex((candidate) => candidate.includes('.devbox'))
    expect(devbox).toBeGreaterThan(TMUX_CANDIDATES.indexOf('/nix/var/nix/profiles/default/bin/tmux'))
  })

  it.skipIf(!existsSync('/usr/bin/tmux'))('pins /usr/bin/tmux with the real candidate list', () => {
    const out = Bun.spawnSync(['/bin/bash', '-c', `${tmuxShellFunctions()}\necho "pinned=$FICUS_TMUX"`], {
      env: { PATH: `${join(root, 'devbox-bin')}:/usr/bin:/bin`, HOME: root },
    })
    expect(out.stdout.toString()).toBe('pinned=/usr/bin/tmux\n')
  })

  it('ignores output without the unreachable marker', () => {
    expect(tmuxUnreachableFromOutput('Command failed with exit code 1: duplicate session')).toBeNull()
  })
})

/**
 * Real tmux, isolated in a temporary TMUX_TMPDIR so it can never touch a
 * server outside the test. Skipped where tmux is not installed.
 */
const realTmux = Bun.which('tmux', { PATH: '/usr/bin:/usr/local/bin:/opt/homebrew/bin:/bin' })
const devboxTmux = join(process.env.HOME ?? '', '.ficus/devbox/.devbox/nix/profile/default/bin/tmux')
function version(bin: string | null): string | null {
  if (!bin || !existsSync(bin)) return null
  return Bun.spawnSync([bin, '-V']).stdout.toString().trim()
}
const twoVersions = realTmux !== null && version(devboxTmux) !== null && version(devboxTmux) !== version(realTmux)

describe.skipIf(!realTmux)('pinned tmux shell functions against real tmux', () => {
  let tmuxDir: string

  beforeEach(() => {
    tmuxDir = mkdtempSync(join(tmpdir(), 'ficus-real-tmux-'))
  })

  afterEach(() => {
    for (const bin of [realTmux!, devboxTmux].filter((candidate) => existsSync(candidate)))
      for (const socket of ['ficus', 'default'])
        Bun.spawnSync([bin, '-L', socket, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir } })
    rmSync(tmuxDir, { recursive: true, force: true })
  })

  function run(body: string, candidates: readonly string[]) {
    const result = Bun.spawnSync(['bash', '-c', `${tmuxShellFunctions(candidates)}\n${body}`], {
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? tmuxDir, TMUX_TMPDIR: tmuxDir },
    })
    return result.stdout.toString()
  }
  const status = (call: string) => `s=0; ${call} || s=$?; echo "status=$s"`

  it('creates, finds and kills a session on the Ficus socket', () => {
    expect(run(status("ficus_tmux_new ficus-real-test 'sleep 30'"), [realTmux!])).toBe('status=0\n')
    expect(run(status('ficus_tmux_has ficus-real-test'), [realTmux!])).toBe('status=0\n')
    expect(existsSync(join(tmuxDir, `tmux-${process.getuid!()}`, 'ficus'))).toBe(true)
    expect(run(status('ficus_tmux_kill ficus-real-test'), [realTmux!])).toBe('status=0\n')
    expect(run(status('ficus_tmux_has ficus-real-test'), [realTmux!])).toBe('status=1\n')
  })

  it.skipIf(!twoVersions)('handles a real server of another tmux version on the default socket', () => {
    Bun.spawnSync([devboxTmux, '-L', 'default', 'new-session', '-d', '-s', 'ficus-stale', 'sleep 30'], {
      env: { ...process.env, TMUX_TMPDIR: tmuxDir },
    })
    // The pinned binary alone cannot talk to it: unknown, not gone.
    expect(run(status('ficus_tmux_has ficus-stale'), [realTmux!])).toBe('status=2\n')
    // With the other binary installed, the stale session is found and stopped.
    expect(run(status('ficus_tmux_has ficus-stale'), [realTmux!, devboxTmux])).toBe('status=0\n')
    expect(run(status("ficus_tmux_new ficus-fresh 'sleep 30'"), [realTmux!, devboxTmux])).toBe('status=0\n')
    expect(run(status('ficus_tmux_kill ficus-stale'), [realTmux!, devboxTmux])).toBe('status=0\n')
    expect(run(status('ficus_tmux_has ficus-stale'), [realTmux!, devboxTmux])).toBe('status=1\n')
  })
})

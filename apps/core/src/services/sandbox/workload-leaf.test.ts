import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LAUNCHER_SCRIPT as APP_LAUNCHER_SCRIPT } from '../deploy/local-deployment-process-supervisor'
import { setTmuxCandidatesForTesting, tmuxShellFunctions } from './tmux'
import { TMUX_SERVER_WORKLOAD_LEAF, WORKLOAD_LEAF_SHELL_FUNCTIONS } from './workload-leaf'

// A box whose sandbox server runs this command in workload/inv-1 of its
// delegated unit, with the cgroup2 mount faked under a temporary directory.
const UNIT = '/user.slice/user-1001.slice/user@1001.service/app.slice/ficus-sandbox-server.service'
let root: string
let fs: string
let selfCgroup: string
let workload: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ficus-workload-leaf-'))
  fs = join(root, 'cgroup')
  workload = join(fs, UNIT, 'workload')
  mkdirSync(join(workload, 'inv-1'), { recursive: true })
  selfCgroup = join(root, 'self-cgroup')
  writeFileSync(selfCgroup, `0::${UNIT}/workload/inv-1\n`)
})
afterEach(() => {
  setTmuxCandidatesForTesting(null)
  rmSync(root, { recursive: true, force: true })
})

function bash(script: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['/bin/bash', '-c', `${WORKLOAD_LEAF_SHELL_FUNCTIONS}\n${script}`], {
    env: {
      PATH: '/usr/bin:/bin',
      FICUS_WORKLOAD_SELF_CGROUP: selfCgroup,
      FICUS_WORKLOAD_CGROUP_FS: fs,
      ...env,
    },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe('workload leaf shell helpers', () => {
  it('moves the calling subshell into its own leaf next to the caller', () => {
    const r = bash('( ficus_workload_leaf app-x; echo "$BASHPID" )')
    expect(r.code).toBe(0)
    expect(readFileSync(join(workload, 'app-x', 'cgroup.procs'), 'utf8').trim()).toBe(r.stdout.trim())
  })

  it('moves an explicit pid', () => {
    expect(bash('ficus_workload_leaf tmux-server 4242').code).toBe(0)
    expect(readFileSync(join(workload, 'tmux-server', 'cgroup.procs'), 'utf8').trim()).toBe('4242')
  })

  it('does nothing outside workload cgroups (old units, k8s, Docker, host runtime)', () => {
    writeFileSync(selfCgroup, `0::${UNIT}\n`)
    const r = bash('ficus_workload_leaf app-x; ficus_workload_leaf_dir app-x || echo none')
    expect(r).toMatchObject({ code: 0, stdout: 'none\n' })
    expect(existsSync(join(fs, UNIT, 'workload', 'app-x'))).toBe(false)
  })

  it('names a kernel OOM kill from memory.events', () => {
    mkdirSync(join(workload, 'app-x'))
    writeFileSync(join(workload, 'app-x', 'memory.events'), 'low 0\nhigh 4\nmax 2\noom 1\noom_kill 1\n')
    expect(bash('ficus_workload_kill_reason app-x').stdout).toBe(
      '[ficus] Killed by the kernel OOM killer: this box reached its memory limit.\n'
    )
  })

  it('names a systemd-oomd kill from the leaf memory pressure, and stays quiet on a calm leaf', () => {
    mkdirSync(join(workload, 'app-x'))
    writeFileSync(join(workload, 'app-x', 'memory.events'), 'oom_kill 0\n')
    writeFileSync(
      join(workload, 'app-x', 'memory.pressure'),
      'some avg10=80.00 avg60=0 avg300=0 total=1\nfull avg10=62.50 avg60=0 avg300=0 total=1\n'
    )
    expect(bash('ficus_workload_kill_reason app-x').stdout).toStartWith('[ficus] Killed by systemd-oomd:')
    writeFileSync(
      join(workload, 'app-x', 'memory.pressure'),
      'some avg10=1.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n'
    )
    expect(bash('ficus_workload_kill_reason app-x').stdout).toBe('')
  })
})

describe('tmux server isolation', () => {
  it('moves the tmux server into its own leaf after creating a session', () => {
    const tmux = join(root, 'tmux')
    writeFileSync(tmux, '#!/bin/bash\ncase " $* " in *" display-message "*) echo 4242 ;; esac\nexit 0\n')
    chmodSync(tmux, 0o755)
    setTmuxCandidatesForTesting([tmux])
    const r = bash(`${tmuxShellFunctions()}\nficus_tmux_new app 'sleep 1'`)
    expect(r.code).toBe(0)
    expect(readFileSync(join(workload, TMUX_SERVER_WORKLOAD_LEAF, 'cgroup.procs'), 'utf8').trim()).toBe('4242')
  })

  it('never moves the calling command when tmux does not report a server pid', () => {
    const tmux = join(root, 'tmux')
    writeFileSync(tmux, '#!/bin/bash\nexit 0\n')
    chmodSync(tmux, 0o755)
    setTmuxCandidatesForTesting([tmux])
    expect(bash(`${tmuxShellFunctions()}\nficus_tmux_new app 'sleep 1'`).code).toBe(0)
    expect(existsSync(join(workload, TMUX_SERVER_WORKLOAD_LEAF))).toBe(false)
  })
})

describe('managed app launcher in a workload cgroup', () => {
  // A memory kill takes only the app (in app-<id>): the launcher survives,
  // records the exit, and logs why the app ended.
  it('runs the app in its own leaf and logs a systemd-oomd kill', () => {
    const dir = join(root, 'deployment')
    mkdirSync(dir)
    mkdirSync(join(workload, 'app-abcdef12'))
    writeFileSync(
      join(workload, 'app-abcdef12', 'memory.pressure'),
      'some avg10=90.00 avg60=0 avg300=0 total=1\nfull avg10=71.00 avg60=0 avg300=0 total=1\n'
    )
    writeFileSync(join(dir, 'run.sh'), APP_LAUNCHER_SCRIPT)
    const result = Bun.spawnSync(['/bin/bash', join(dir, 'run.sh')], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        FICUS_WORKLOAD_SELF_CGROUP: selfCgroup,
        FICUS_WORKLOAD_CGROUP_FS: fs,
        FICUS_LOCAL_DEPLOYMENT_ID: 'abcdef12',
        FICUS_LOCAL_DEPLOYMENT_PORT: '5173',
        FICUS_LOCAL_DEPLOYMENT_CWD: root,
        FICUS_LOCAL_DEPLOYMENT_DIR: dir,
        // What systemd-oomd does to the leaf: SIGKILL the app.
        FICUS_LOCAL_DEPLOYMENT_COMMAND: 'echo serving; kill -KILL $$',
      },
    })
    expect(result.exitCode).toBe(137)
    expect(readFileSync(join(dir, 'exitCode'), 'utf8').trim()).toBe('137')
    const log = readFileSync(join(dir, 'logs', 'current.log'), 'utf8')
    expect(log).toContain('serving\n')
    expect(log).toContain('[ficus] Killed by systemd-oomd: this box was under sustained memory pressure')
    // The app's subshell moved itself; the launcher (this script) did not.
    const moved = readFileSync(join(workload, 'app-abcdef12', 'cgroup.procs'), 'utf8').trim()
    expect(moved).not.toBe('')
    expect(moved).not.toBe(String(result.pid))
  })
})

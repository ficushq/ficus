import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GC_LAUNCHD_LABEL,
  LEGACY_GC_LAUNCHD_LABEL,
  installDockerGcLaunchd,
  renderGcLaunchdPlist,
  type LaunchdInstallOptions,
} from './docker-gc-launchd'

const uid = process.getuid!()
const bunPath = '/test/bin/bun'
let root: string
let home: string
let agents: string
let repoRoot: string
let script: string
let legacy: string
let canonical: string

type Job = { path: string; program: string; args: string[] }

class LaunchctlFixture {
  jobs = new Map<string, Job>()
  calls: string[][] = []
  failCanonicalBootstrap = false
  failBootout = false

  run = (args: string[]): { exitCode: number; out: string } => {
    this.calls.push(args)
    if (args[0] !== 'launchctl') return { exitCode: 1, out: '' }
    if (args[1] === 'print') {
      const label = args[2]!.split('/').at(-1)!
      const job = this.jobs.get(label)
      if (!job) return { exitCode: 113, out: `Could not find service "${label}"` }
      return {
        exitCode: 0,
        out: `gui/${uid}/${label} = {\n  path = ${job.path}\n  program = ${job.program}\n  arguments = {\n    ${job.args[0]}\n    ${job.args[1]}\n  }\n}\n`,
      }
    }
    if (args[1] === 'bootout') {
      if (this.failBootout) return { exitCode: 1, out: 'refused' }
      const label = args[3]!.endsWith(`${LEGACY_GC_LAUNCHD_LABEL}.plist`) ? LEGACY_GC_LAUNCHD_LABEL : GC_LAUNCHD_LABEL
      this.jobs.delete(label)
      return { exitCode: 0, out: '' }
    }
    if (args[1] === 'bootstrap') {
      const path = args[3]!
      const label = path.endsWith(`${LEGACY_GC_LAUNCHD_LABEL}.plist`) ? LEGACY_GC_LAUNCHD_LABEL : GC_LAUNCHD_LABEL
      if (label === GC_LAUNCHD_LABEL && this.failCanonicalBootstrap) return { exitCode: 1, out: 'refused' }
      if (!existsSync(path)) return { exitCode: 1, out: 'missing' }
      this.jobs.set(label, { path, program: bunPath, args: [bunPath, script] })
      return { exitCode: 0, out: '' }
    }
    return { exitCode: 1, out: '' }
  }

  loadedLegacy() {
    this.jobs.set(LEGACY_GC_LAUNCHD_LABEL, { path: legacy, program: bunPath, args: [bunPath, script] })
  }
}

function options(fixture: LaunchctlFixture): LaunchdInstallOptions {
  return { home, repoRoot, bunPath, uid, run: fixture.run }
}

function oldPlist(log = '/tmp/tau-docker-gc.log') {
  return renderGcLaunchdPlist(LEGACY_GC_LAUNCHD_LABEL, bunPath, script, log)
}

function writeOld(log?: string) {
  writeFileSync(legacy, oldPlist(log), { mode: 0o600 })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ficus-docker-gc-launchd-'))
  home = join(root, 'home')
  agents = join(home, 'Library/LaunchAgents')
  repoRoot = join(root, 'core')
  script = join(repoRoot, 'scripts/docker-gc.ts')
  legacy = join(agents, `${LEGACY_GC_LAUNCHD_LABEL}.plist`)
  canonical = join(agents, `${GC_LAUNCHD_LABEL}.plist`)
  mkdirSync(agents, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Docker GC launchd migration', () => {
  test('retires the exact old 13:00 job before loading the canonical job', () => {
    writeOld()
    const launchctl = new LaunchctlFixture()
    launchctl.loadedLegacy()

    expect(installDockerGcLaunchd(options(launchctl))).toBe(canonical)
    expect(launchctl.jobs.has(LEGACY_GC_LAUNCHD_LABEL)).toBe(false)
    expect(launchctl.jobs.get(GC_LAUNCHD_LABEL)?.path).toBe(canonical)
    expect(launchctl.calls.findIndex((call) => call[1] === 'bootout')).toBeLessThan(
      launchctl.calls.findIndex((call) => call[1] === 'bootstrap')
    )
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(`${legacy}.migrating`)).toBe(false)
    expect(readFileSync(canonical, 'utf8')).toContain('<integer>13</integer>')
    expect(readFileSync(canonical, 'utf8')).toContain('/tmp/ficus-docker-gc.log')
  })

  test('fresh install and repeated install keep one job and one plist', () => {
    const launchctl = new LaunchctlFixture()
    installDockerGcLaunchd(options(launchctl))
    installDockerGcLaunchd(options(launchctl))
    expect(launchctl.jobs.size).toBe(1)
    expect(launchctl.calls.filter((call) => call[1] === 'bootstrap')).toHaveLength(1)
    expect(lstatSync(canonical).nlink).toBe(1)
  })

  test('resumes a retired inert backup after an interruption', () => {
    writeFileSync(`${legacy}.migrating`, oldPlist('/tmp/ficus-docker-gc.log'), { mode: 0o600 })
    const launchctl = new LaunchctlFixture()
    installDockerGcLaunchd(options(launchctl))
    expect(launchctl.jobs.size).toBe(1)
    expect(launchctl.jobs.has(GC_LAUNCHD_LABEL)).toBe(true)
    expect(existsSync(`${legacy}.migrating`)).toBe(false)
  })

  test('refuses foreign or symlinked plist before touching launchd', () => {
    writeOld()
    writeFileSync(legacy, oldPlist().replace('<integer>13</integer>', '<integer>14</integer>'))
    const launchctl = new LaunchctlFixture()
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('legacy plist differs')
    expect(launchctl.calls).toEqual([])

    rmSync(legacy)
    const target = join(root, 'foreign.plist')
    writeFileSync(target, oldPlist())
    symlinkSync(target, legacy)
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('not an owned')
    expect(launchctl.calls).toEqual([])
  })

  test('refuses a foreign loaded job with the same label', () => {
    writeOld()
    const launchctl = new LaunchctlFixture()
    launchctl.jobs.set(LEGACY_GC_LAUNCHD_LABEL, {
      path: '/other/LaunchAgents/dev.tau.docker-gc.plist',
      program: bunPath,
      args: [bunPath, script],
    })
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('loaded job does not match')
    expect(launchctl.calls.every((call) => call[1] === 'print')).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(canonical)).toBe(false)
  })

  test('refuses concurrent installation before probing or changing launchd', () => {
    writeOld()
    const lock = join(agents, '.dev.ficus.docker-gc.install.lock')
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 })
    const launchctl = new LaunchctlFixture()
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('another Docker GC')
    expect(launchctl.calls).toEqual([])
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(lock)).toBe(true)
  })

  test('recovers a dead installer lock and its inert backup without loading two jobs', () => {
    const lock = join(agents, '.dev.ficus.docker-gc.install.lock')
    writeFileSync(lock, '99999999\n', { mode: 0o600 })
    writeFileSync(`${legacy}.migrating`, oldPlist(), { mode: 0o600 })
    const launchctl = new LaunchctlFixture()
    installDockerGcLaunchd(options(launchctl))
    expect(launchctl.jobs.size).toBe(1)
    expect(launchctl.jobs.has(GC_LAUNCHD_LABEL)).toBe(true)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(`${legacy}.migrating`)).toBe(false)
  })

  test('refuses a malformed or unverifiable installer lock without touching launchd', () => {
    const lock = join(agents, '.dev.ficus.docker-gc.install.lock')
    writeFileSync(lock, '', { mode: 0o600 })
    const launchctl = new LaunchctlFixture()
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('not an owned process lock')
    expect(launchctl.calls).toEqual([])
    expect(existsSync(lock)).toBe(true)
  })

  test('failed canonical bootstrap restores only the previously loaded old job', () => {
    writeOld()
    const launchctl = new LaunchctlFixture()
    launchctl.loadedLegacy()
    launchctl.failCanonicalBootstrap = true
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('canonical bootstrap failed')
    expect(launchctl.jobs.size).toBe(1)
    expect(launchctl.jobs.has(LEGACY_GC_LAUNCHD_LABEL)).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(canonical)).toBe(false)
  })

  test('failed legacy bootout never creates a second schedule', () => {
    writeOld()
    const launchctl = new LaunchctlFixture()
    launchctl.loadedLegacy()
    launchctl.failBootout = true
    expect(() => installDockerGcLaunchd(options(launchctl))).toThrow('could not retire')
    expect(launchctl.jobs.size).toBe(1)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(canonical)).toBe(false)
  })
})

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const GC_LAUNCHD_LABEL = 'dev.ficus.docker-gc'
export const LEGACY_GC_LAUNCHD_LABEL = 'dev.tau.docker-gc'

type CommandResult = { exitCode: number | null; out: string }
export type LaunchdInstallOptions = {
  home: string
  repoRoot: string
  bunPath: string
  uid: number
  run: (args: string[]) => CommandResult
}

function refuse(reason: string): never {
  throw new Error(`launchd install refused: ${reason}`)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function ownedFile(path: string, uid: number): string | null {
  let before
  try {
    before = lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return null
    return refuse('could not inspect a job file')
  }
  if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o022) !== 0)
    refuse('job file is not an owned, single-link, non-writable regular file')
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== uid || opened.nlink !== 1)
      refuse('job file changed during inspection')
    return readFileSync(fd, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('launchd install refused:')) throw error
    return refuse('could not read an owned job file')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function ensureAgentsDir(home: string, uid: number): string {
  const library = join(home, 'Library')
  const agents = join(library, 'LaunchAgents')
  for (const path of [home, library, agents]) {
    if (path !== home) mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o002) !== 0)
      refuse('LaunchAgents path is not an owned directory')
  }
  return agents
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function renderGcLaunchdPlist(label: string, bunPath: string, scriptPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bunPath)}</string>
    <string>${xml(scriptPath)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`
}

function loadedJob(options: LaunchdInstallOptions, label: string, plistPath: string, scriptPath: string): boolean {
  const result = options.run(['launchctl', 'print', `gui/${options.uid}/${label}`])
  if (result.exitCode === 113 && result.out.includes('Could not find service')) return false
  if (result.exitCode !== 0) refuse('could not inspect a launchd job')
  const lines = result.out.split('\n').map((line) => line.trim())
  const argsIndex = lines.indexOf('arguments = {')
  if (
    lines[0] !== `gui/${options.uid}/${label} = {` ||
    !lines.includes(`path = ${plistPath}`) ||
    !lines.includes(`program = ${options.bunPath}`) ||
    argsIndex < 0 ||
    lines[argsIndex + 1] !== options.bunPath ||
    lines[argsIndex + 2] !== scriptPath ||
    lines[argsIndex + 3] !== '}'
  )
    refuse('loaded job does not match the owned plist and command')
  return true
}

function installCanonicalFile(path: string, pending: string, expected: string, uid: number): void {
  const staged = ownedFile(pending, uid)
  if (staged !== null && staged !== expected) refuse('pending canonical plist differs from this checkout')
  if (staged === null) writeFileSync(pending, expected, { flag: 'wx', mode: 0o600 })
  // The pending suffix is inert to launchd. The rename is atomic, so a crash
  // cannot leave a half-written .plist eligible for loading at next login.
  if (ownedFile(path, uid) !== null) refuse('canonical plist appeared during installation')
  renameSync(pending, path)
}

function installLocked(options: LaunchdInstallOptions, agents: string): string {
  const script = join(options.repoRoot, 'scripts/docker-gc.ts')
  const canonical = join(agents, `${GC_LAUNCHD_LABEL}.plist`)
  const legacy = join(agents, `${LEGACY_GC_LAUNCHD_LABEL}.plist`)
  // The inert suffix prevents launchd from loading the retired job at login if
  // installation is interrupted between bootout and canonical bootstrap.
  const backup = `${legacy}.migrating`
  const pending = `${canonical}.pending`
  const newPlist = renderGcLaunchdPlist(GC_LAUNCHD_LABEL, options.bunPath, script, '/tmp/ficus-docker-gc.log')
  const oldPlists = [
    renderGcLaunchdPlist(LEGACY_GC_LAUNCHD_LABEL, options.bunPath, script, '/tmp/tau-docker-gc.log'),
    renderGcLaunchdPlist(LEGACY_GC_LAUNCHD_LABEL, options.bunPath, script, '/tmp/ficus-docker-gc.log'),
  ]
  const old = ownedFile(legacy, options.uid)
  const saved = ownedFile(backup, options.uid)
  const current = ownedFile(canonical, options.uid)
  const staged = ownedFile(pending, options.uid)
  if ((old !== null && !oldPlists.includes(old)) || (saved !== null && !oldPlists.includes(saved)))
    refuse('legacy plist differs from this checkout and its 13:00 schedule')
  if (current !== null && current !== newPlist) refuse('canonical plist differs from this checkout')
  if (staged !== null && staged !== newPlist) refuse('pending canonical plist differs from this checkout')
  if (old !== null && saved !== null) refuse('legacy plist and migration backup both exist')

  const oldLoaded = loadedJob(options, LEGACY_GC_LAUNCHD_LABEL, legacy, script)
  const newLoaded = loadedJob(options, GC_LAUNCHD_LABEL, canonical, script)
  if (oldLoaded && old === null) refuse('loaded legacy job has no owned plist')
  if (newLoaded && current === null) refuse('loaded canonical job has no owned plist')
  if (oldLoaded && newLoaded) refuse('both launchd schedules are already loaded')
  if (saved !== null && oldLoaded) refuse('retired backup exists but legacy job is loaded')

  if (oldLoaded) {
    if (options.run(['launchctl', 'bootout', `gui/${options.uid}`, legacy]).exitCode !== 0)
      refuse('could not retire the legacy launchd job')
    if (loadedJob(options, LEGACY_GC_LAUNCHD_LABEL, legacy, script))
      refuse('legacy launchd job remained loaded after bootout')
  }
  if (old !== null) renameSync(legacy, backup)

  if (current === null) installCanonicalFile(canonical, pending, newPlist, options.uid)
  else if (staged !== null) unlinkSync(pending)

  if (!newLoaded) {
    const result = options.run(['launchctl', 'bootstrap', `gui/${options.uid}`, canonical])
    const confirmed = loadedJob(options, GC_LAUNCHD_LABEL, canonical, script)
    if (!confirmed) {
      // Preserve the old schedule on a definite failure, but never restore it
      // while a canonical service may already be loaded.
      if (current === null) unlinkSync(canonical)
      if (current === null && ownedFile(backup, options.uid) !== null) {
        renameSync(backup, legacy)
        if (oldLoaded) {
          if (
            options.run(['launchctl', 'bootstrap', `gui/${options.uid}`, legacy]).exitCode !== 0 ||
            !loadedJob(options, LEGACY_GC_LAUNCHD_LABEL, legacy, script)
          )
            refuse('canonical bootstrap failed and legacy rollback could not be verified')
        }
      }
      refuse(result.exitCode === 0 ? 'canonical job did not load' : 'canonical bootstrap failed')
    }
  }

  if (ownedFile(backup, options.uid) !== null) unlinkSync(backup)
  if (ownedFile(pending, options.uid) !== null) unlinkSync(pending)
  return canonical
}

/** Migrates only the exact job installed by this checkout. Never leaves two active schedules. */
export function installDockerGcLaunchd(options: LaunchdInstallOptions): string {
  const agents = ensureAgentsDir(options.home, options.uid)
  const lock = join(agents, '.dev.ficus.docker-gc.install.lock')
  let fd: number | undefined
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (!isExisting(error)) refuse('could not create Docker GC installation lock')
    // An interrupted install can leave .migrating/.pending files. Its lock
    // must not permanently prevent the next invocation from finishing them.
    const original = lstatSync(lock)
    const previous = ownedFile(lock, options.uid)
    const match = previous?.match(/^([1-9]\d*)\n$/)
    if (!match) refuse('Docker GC installation lock is not an owned process lock')
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid)) refuse('Docker GC installation lock has an invalid process')
    try {
      process.kill(pid, 0)
      refuse('another Docker GC launchd installation is in progress')
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') {
        if (probeError instanceof Error && probeError.message.startsWith('launchd install refused:')) throw probeError
        refuse('could not prove the previous Docker GC installer exited')
      }
    }
    const before = lstatSync(lock)
    if (
      before.dev !== original.dev ||
      before.ino !== original.ino ||
      before.uid !== options.uid ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0
    )
      refuse('Docker GC installation lock changed during inspection')
    // This is still fail-closed if another installer wins the exclusive create.
    unlinkSync(lock)
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    } catch {
      refuse('another Docker GC launchd installation is in progress')
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n`)
    fsyncSync(fd)
    return installLocked(options, agents)
  } finally {
    const opened = fstatSync(fd)
    closeSync(fd)
    try {
      const current = lstatSync(lock)
      if (current.dev === opened.dev && current.ino === opened.ino) unlinkSync(lock)
    } catch (error) {
      if (!isMissing(error)) refuse('could not remove Docker GC installation lock')
    }
  }
}

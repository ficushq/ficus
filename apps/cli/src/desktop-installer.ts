import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { homedir, platform as hostPlatform, arch as hostArch } from 'node:os'
import { join } from 'node:path'
import { defaultRunner, type Runner } from './local-server/runner'
import { verifyDesktopArchive } from './desktop-archive'

export const desktopReleaseRepository = 'ficushq/tau-desktop-releases' // ficus-p5-apple: public release artifact repository pending repo rename
export const desktopFeed = `https://raw.githubusercontent.com/${desktopReleaseRepository}/main/updates/ficus-darwin-arm64.json`
const releaseBase = `https://github.com/${desktopReleaseRepository}/releases/download/`
const teamId = '5S6HE7KE49'
const bundleId = 'sh.ficus.desktop'
const maxArchiveSize = 2 * 1024 * 1024 * 1024

export interface DesktopRelease {
  version: string
  url: string
  sha256: string
  size: number
}
export interface DesktopDeps {
  platform: string
  arch: string
  home: string
  applications: string
  fetch: typeof fetch
  runner: Runner
  sleep(ms: number): Promise<void>
  verifyArchive(path: string): Promise<void>
}
export const defaultDesktopDeps = (): DesktopDeps => ({
  platform: hostPlatform(),
  arch: hostArch(),
  home: homedir(),
  applications: '/Applications',
  fetch,
  runner: defaultRunner,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyArchive: verifyDesktopArchive,
})

function macOnly(deps: DesktopDeps): void {
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64')
    throw new Error('Ficus Desktop is macOS-only for now (Apple silicon).')
}
function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid Desktop release version')
  return version.split('.').map(Number)
}
function compareVersions(a: string, b: string): number {
  const left = versionParts(a),
    right = versionParts(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return 0
}
export function parseDesktopFeed(value: unknown): DesktopRelease {
  if (!value || typeof value !== 'object') throw new Error('Invalid Desktop release feed')
  const feed = value as { currentRelease?: unknown; releases?: unknown }
  const version = feed.currentRelease
  if (typeof version !== 'string') throw new Error('Invalid Desktop release feed')
  versionParts(version)
  const releases = feed.releases
  if (!Array.isArray(releases) || releases.length !== 1) throw new Error('Invalid Desktop release feed')
  const entry = releases[0] as { version?: unknown; updateTo?: Record<string, unknown> }
  const update = entry?.updateTo
  const expected = `${releaseBase}v${version}/Ficus-${version}-darwin-arm64.zip`
  if (
    entry?.version !== version ||
    update?.version !== version ||
    update?.url !== expected ||
    typeof update.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(update.sha256) ||
    typeof update.size !== 'number' ||
    !Number.isSafeInteger(update.size) ||
    update.size < 1 ||
    update.size > maxArchiveSize
  )
    throw new Error('Invalid Desktop release feed')
  return { version, url: expected, sha256: update.sha256, size: update.size }
}
export async function latestDesktop(deps: DesktopDeps): Promise<DesktopRelease> {
  macOnly(deps)
  const response = await deps.fetch(desktopFeed, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Desktop release feed failed (${response.status})`)
  const text = await response.text()
  if (text.length > 64 * 1024) throw new Error('Desktop release feed is too large')
  return parseDesktopFeed(JSON.parse(text))
}
async function existing(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Desktop install path is not a real application directory: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}
async function destination(deps: DesktopDeps, create: boolean): Promise<string> {
  const globalInfo = await lstat(deps.applications)
  if (!globalInfo.isDirectory() || globalInfo.isSymbolicLink())
    throw new Error('System Applications path must be a real directory')
  const global = join(deps.applications, 'Ficus.app')
  const personalRoot = join(deps.home, 'Applications')
  const personal = join(personalRoot, 'Ficus.app')
  if (await existing(global)) return global
  if (await existing(personal)) return personal
  if (await writable(deps.applications)) return global
  if (create) {
    const parent = await lstat(personalRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
      throw new Error('Personal Applications path must be a real directory')
    if (!parent) await mkdir(personalRoot, { mode: 0o700 })
  }
  return personal
}
async function run(deps: DesktopDeps, command: string[], timeoutMs = 120_000): Promise<string> {
  const result = await deps.runner(command, { timeoutMs })
  if (result.code !== 0) throw new Error(`${command[0]} failed (${result.code})`)
  return result.stdout + result.stderr
}
async function appVersion(deps: DesktopDeps, application: string): Promise<string> {
  const version = (
    await run(deps, [
      '/usr/libexec/PlistBuddy',
      '-c',
      'Print :CFBundleShortVersionString',
      join(application, 'Contents/Info.plist'),
    ])
  ).trim()
  versionParts(version)
  return version
}
async function verifyApplication(deps: DesktopDeps, application: string, version: string): Promise<void> {
  if (!(await existing(application))) throw new Error('Desktop ZIP did not contain Ficus.app')
  if ((await appVersion(deps, application)) !== version)
    throw new Error('Desktop app version does not match the release feed')
  const identity = (
    await run(deps, [
      '/usr/libexec/PlistBuddy',
      '-c',
      'Print :CFBundleIdentifier',
      join(application, 'Contents/Info.plist'),
    ])
  ).trim()
  if (identity !== bundleId) throw new Error('Desktop app bundle identity is not Ficus')
  await run(deps, ['/usr/bin/codesign', '--verify', '--deep', '--strict', application])
  const details = await run(deps, ['/usr/bin/codesign', '--display', '--verbose=4', application])
  if (
    !new RegExp(`^TeamIdentifier=${teamId}$`, 'm').test(details) ||
    !/^Authority=Developer ID Application:/m.test(details)
  )
    throw new Error('Desktop app is not signed by the expected Developer ID team')
  await run(deps, ['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=2', application])
}
async function download(deps: DesktopDeps, release: DesktopRelease, path: string): Promise<void> {
  const response = await deps.fetch(release.url, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Desktop download failed (${response.status})`)
  const handle = await open(path, 'wx', 0o600)
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > release.size) throw new Error('Desktop download exceeds declared size')
      hash.update(chunk)
      await handle.writeFile(chunk)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (size !== release.size || hash.digest('hex') !== release.sha256)
    throw new Error('Desktop download does not match the release feed')
}
async function running(deps: DesktopDeps, target: string): Promise<boolean> {
  const result = await deps.runner(['/usr/bin/pgrep', '-x', 'Ficus'], { timeoutMs: 10_000 })
  if (result.code === 1) return false
  if (result.code !== 0) throw new Error('Could not inspect running Ficus Desktop processes')
  const pids = result.stdout.trim().split(/\s+/)
  if (!pids.length || pids.some((pid) => !/^\d+$/.test(pid)))
    throw new Error('Could not identify running Ficus Desktop processes')
  const executable = join(target, 'Contents/MacOS/Ficus')
  let matched = false
  for (const pid of pids) {
    const process = await deps.runner(['/bin/ps', '-p', pid!, '-o', 'command='], { timeoutMs: 10_000 })
    if (process.code !== 0) continue // It quit between pgrep and ps.
    const command = process.stdout.trim()
    if (command !== executable && !command.startsWith(executable + ' '))
      throw new Error('Another Ficus process is running; quit it before replacing this Desktop app')
    matched = true
  }
  return matched
}
async function quitRunning(deps: DesktopDeps, target: string): Promise<void> {
  if (!(await running(deps, target))) return
  await run(
    deps,
    [
      '/usr/bin/osascript',
      '-e',
      'on run argv',
      '-e',
      'tell application (item 1 of argv) to quit',
      '-e',
      'end run',
      target,
    ],
    30_000
  )
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!(await running(deps, target))) return
    await deps.sleep(250)
  }
  throw new Error('Ficus Desktop did not quit; the installed app was not changed')
}
async function openInstalled(deps: DesktopDeps, path: string, openAfter: boolean): Promise<string | undefined> {
  if (!openAfter) return undefined
  try {
    await run(deps, ['/usr/bin/open', '-a', path])
  } catch {
    return 'Desktop could not be opened automatically'
  }
}
async function refuseInterruptedReplacement(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.name.startsWith('.ficus-desktop-install-')) continue
    const path = join(parent, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Unrecognized Desktop installer staging path: ${path}`)
    const backup = join(path, 'previous.app')
    try {
      const info = await lstat(backup)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unrecognized retained Desktop app: ${backup}`)
      throw new Error(
        `An interrupted Desktop replacement retained the previous app at ${backup}; resolve it before retrying`
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
export async function desktopStatus(deps: DesktopDeps): Promise<{
  installed: string | null
  latest: string
  path: string | null
}> {
  const release = await latestDesktop(deps)
  const path = await destination(deps, false)
  await refuseInterruptedReplacement(path.slice(0, -'/Ficus.app'.length))
  const installed = (await existing(path)) ? await appVersion(deps, path) : null
  return { installed, latest: release.version, path: installed ? path : null }
}
export async function installDesktop(
  deps: DesktopDeps,
  openAfter = true
): Promise<{
  version: string
  path: string
  upToDate: boolean
  openError?: string
}> {
  const release = await latestDesktop(deps)
  const target = await destination(deps, true)
  const parent = target.slice(0, -'/Ficus.app'.length)
  await refuseInterruptedReplacement(parent)
  if (await existing(target)) {
    const current = await appVersion(deps, target)
    if (compareVersions(current, release.version) >= 0) {
      try {
        await verifyApplication(deps, target, current)
        const openError = await openInstalled(deps, target, openAfter)
        return { version: current, path: target, upToDate: true, ...(openError ? { openError } : {}) }
      } catch {
        // Reinstall an unsigned, damaged, or wrong-team bundle from the trusted release.
      }
    }
  }
  if (!(await writable(parent))) throw new Error(`Existing ${target} cannot be replaced without write access`)
  const staging = await mkdtemp(join(parent, '.ficus-desktop-install-'))
  const archive = join(staging, 'release.zip')
  const extracted = join(staging, 'extracted')
  const candidate = join(extracted, 'Ficus.app')
  const backup = join(staging, 'previous.app')
  let previousMoved = false
  let retainForRecovery = false
  try {
    await download(deps, release, archive)
    await deps.verifyArchive(archive)
    await mkdir(extracted, { mode: 0o700 })
    await run(deps, ['/usr/bin/ditto', '-x', '-k', archive, extracted])
    const members = await readdir(extracted)
    if (members.some((name) => name !== 'Ficus.app' && name !== '__MACOSX'))
      throw new Error('Desktop ZIP has unexpected extracted content')
    await verifyApplication(deps, candidate, release.version)
    await quitRunning(deps, target)
    if (await existing(target)) {
      await rename(target, backup)
      previousMoved = true
    }
    try {
      await rename(candidate, target)
    } catch (error) {
      if (previousMoved) {
        try {
          await rename(backup, target)
          previousMoved = false
        } catch {
          retainForRecovery = true
          throw new Error(`Desktop replacement failed; previous app is retained at ${backup}`)
        }
      }
      throw error
    }
    const openError = await openInstalled(deps, target, openAfter)
    return { version: release.version, path: target, upToDate: false, ...(openError ? { openError } : {}) }
  } finally {
    if (!retainForRecovery) await rm(staging, { recursive: true, force: true })
  }
}

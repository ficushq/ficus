import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopFeed,
  desktopReleaseRepository,
  desktopStatus,
  installDesktop,
  parseDesktopFeed,
  type DesktopDeps,
} from './desktop-installer'

const version = '0.5.5'
const archive = Buffer.from('fake ZIP held entirely by test')
const digest = createHash('sha256').update(archive).digest('hex')
const url = `https://github.com/${desktopReleaseRepository}/releases/download/v${version}/Ficus-${version}-darwin-arm64.zip`
const feed = {
  currentRelease: version,
  releases: [{ version, updateTo: { version, name: version, url, sha256: digest, size: archive.length } }],
}
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ficus-desktop-cli-test-'))
  dirs.push(root)
  const applications = join(root, 'Applications')
  await mkdir(applications)
  const calls: string[][] = []
  const deps: DesktopDeps = {
    platform: 'darwin',
    arch: 'arm64',
    home: root,
    applications,
    fetch: async (input) => {
      if (String(input) === desktopFeed) return Response.json(feed)
      if (String(input) === url) return new Response(archive)
      throw new Error('Unexpected URL')
    },
    runner: async (command) => {
      calls.push(command)
      if (command[0] === '/usr/bin/ditto') {
        await mkdir(join(command[4]!, 'Ficus.app', 'Contents'), { recursive: true })
        await writeFile(join(command[4]!, 'Ficus.app', 'Contents', 'proof'), 'new')
      }
      if (command[0] === '/usr/bin/pgrep') return { code: 1, stdout: '', stderr: '' }
      if (command[0] === '/usr/libexec/PlistBuddy') {
        const previous =
          command[3]?.startsWith(join(applications, 'Ficus.app') + '/') &&
          (await access(join(applications, 'Ficus.app', 'old')).then(
            () => true,
            () => false
          ))
        return {
          code: 0,
          stdout: command[2]?.includes('CFBundleIdentifier')
            ? 'sh.ficus.desktop\n'
            : `${previous ? '0.5.4' : version}\n`,
          stderr: '',
        }
      }
      if (command[0] === '/usr/bin/codesign' && command[1] === '--display')
        return {
          code: 0,
          stdout: '',
          stderr: 'TeamIdentifier=5S6HE7KE49\nAuthority=Developer ID Application: Ficus\n',
        }
      return { code: 0, stdout: '', stderr: '' }
    },
    sleep: async () => {},
    verifyArchive: async (path) => {
      calls.push(['verifyArchive', path])
    },
  }
  return { root, applications, deps, calls }
}

test('feed accepts only the public version-matched release URL and digest', () => {
  expect(parseDesktopFeed(feed)).toEqual({ version, url, sha256: digest, size: archive.length })
  const previouslyPublishedUrl = url.replace('ficushq/ficus-desktop-releases', 'ficushq/tau-desktop-releases')
  expect(
    parseDesktopFeed({
      ...feed,
      releases: [{ version, updateTo: { ...feed.releases[0]!.updateTo, url: previouslyPublishedUrl } }],
    })
  ).toEqual({ version, url: previouslyPublishedUrl, sha256: digest, size: archive.length })
  expect(() =>
    parseDesktopFeed({
      ...feed,
      releases: [{ version, updateTo: { ...feed.releases[0]!.updateTo, url: 'https://example.com/release.zip' } }],
    })
  ).toThrow('Invalid')
  expect(() =>
    parseDesktopFeed({ ...feed, releases: [{ version, updateTo: { ...feed.releases[0]!.updateTo, sha256: 'bad' } }] })
  ).toThrow('Invalid')
})

test('non-macOS refuses before requesting any feed or touching applications', async () => {
  const f = await fixture()
  f.deps.platform = 'linux'
  await expect(installDesktop(f.deps)).rejects.toThrow('macOS-only')
  expect(f.calls).toEqual([])
})

test('verifies downloaded bytes, archive, app version, bundle identity, codesign team and spctl before replacing old app', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'preserved until verification')
  const result = await installDesktop(f.deps, false)
  expect(result).toEqual({ version, path: old, upToDate: false })
  expect(await readFile(join(old, 'Contents', 'proof'), 'utf8')).toBe('new')
  const names = f.calls.map((call) => call[0] + ' ' + call[1])
  expect(names.indexOf('verifyArchive ' + f.calls.find((call) => call[0] === 'verifyArchive')?.[1])).toBeLessThan(
    names.indexOf('/usr/bin/ditto -x')
  )
  expect(names.indexOf('/usr/bin/codesign --verify')).toBeLessThan(names.indexOf('/usr/bin/pgrep -x'))
  expect(names.indexOf('/usr/sbin/spctl --assess')).toBeLessThan(names.indexOf('/usr/bin/pgrep -x'))
  expect(names.some((name) => name.startsWith('/usr/bin/open '))).toBe(false)
  expect((await readdir(f.applications)).sort()).toEqual(['Ficus.app'])
})

test('bad Developer ID team leaves existing app untouched and cleans owned staging', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'old')
  const runner = f.deps.runner
  f.deps.runner = async (command, options) =>
    command[0] === '/usr/bin/codesign' && command[1] === '--display'
      ? { code: 0, stdout: 'TeamIdentifier=WRONGTEAM\n', stderr: '' }
      : runner(command, options)
  await expect(installDesktop(f.deps)).rejects.toThrow('expected Developer ID team')
  expect(await readFile(join(old, 'old'), 'utf8')).toBe('old')
  expect((await readdir(f.applications)).sort()).toEqual(['Ficus.app'])
})

test('status and current install are read-only for the installed app', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  expect(await desktopStatus(f.deps)).toEqual({ installed: version, latest: version, path: old })
  expect(await installDesktop(f.deps)).toEqual({ version, path: old, upToDate: true })
  expect(f.calls.some((call) => call[0] === '/usr/bin/codesign')).toBe(true)
  expect(f.calls.every((call) => call[0] !== '/usr/bin/ditto')).toBe(true)
  expect(f.calls.some((call) => call[0] === '/usr/bin/open')).toBe(true)
  f.calls.length = 0
  expect(await installDesktop(f.deps, false)).toEqual({ version, path: old, upToDate: true })
  expect(f.calls.some((call) => call[0] === '/usr/bin/open')).toBe(false)
})

test('archive checksum failure never extracts or replaces the installed app', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'old')
  const fetcher = f.deps.fetch
  f.deps.fetch = async (input, init) =>
    String(input) === url
      ? new Response(Buffer.from('different bytes, same length').subarray(0, archive.length))
      : fetcher(input, init)
  await expect(installDesktop(f.deps)).rejects.toThrow('does not match')
  expect(f.calls.some((call) => call[0] === '/usr/bin/ditto')).toBe(false)
  expect(await readFile(join(old, 'old'), 'utf8')).toBe('old')
})

test('Gatekeeper refusal leaves the installed app intact', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'old')
  const runner = f.deps.runner
  f.deps.runner = async (command, options) =>
    command[0] === '/usr/sbin/spctl' ? { code: 1, stdout: '', stderr: 'rejected' } : runner(command, options)
  await expect(installDesktop(f.deps)).rejects.toThrow('spctl failed')
  expect(await readFile(join(old, 'old'), 'utf8')).toBe('old')
  expect((await readdir(f.applications)).sort()).toEqual(['Ficus.app'])
})

test('refuses a retained previous app from an interrupted replacement without deleting it', async () => {
  const f = await fixture()
  const retained = join(f.applications, '.ficus-desktop-install-interrupted', 'previous.app')
  await mkdir(retained, { recursive: true })
  await writeFile(join(retained, 'proof'), 'preserved')
  await expect(installDesktop(f.deps)).rejects.toThrow('interrupted Desktop replacement')
  expect(await readFile(join(retained, 'proof'), 'utf8')).toBe('preserved')
  expect(f.calls).toEqual([])
})

test('never quits a Ficus process whose executable is outside the selected target bundle', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'old')
  const runner = f.deps.runner
  f.deps.runner = async (command, options) => {
    if (command[0] === '/usr/bin/pgrep') return { code: 0, stdout: '123\n', stderr: '' }
    if (command[0] === '/bin/ps') return { code: 0, stdout: '/Other/Ficus.app/Contents/MacOS/Ficus\n', stderr: '' }
    return runner(command, options)
  }
  await expect(installDesktop(f.deps)).rejects.toThrow('Another Ficus process')
  expect(f.calls.some((call) => call[0] === '/usr/bin/osascript')).toBe(false)
  expect(await readFile(join(old, 'old'), 'utf8')).toBe('old')
})

test('quits only the selected app path before replacement', async () => {
  const f = await fixture()
  const old = join(f.applications, 'Ficus.app')
  await mkdir(old)
  await writeFile(join(old, 'old'), 'old')
  const runner = f.deps.runner
  let checks = 0
  f.deps.runner = async (command, options) => {
    if (command[0] === '/usr/bin/pgrep')
      return ++checks === 1 ? { code: 0, stdout: '123\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    if (command[0] === '/bin/ps') return { code: 0, stdout: `${old}/Contents/MacOS/Ficus\n`, stderr: '' }
    return runner(command, options)
  }
  await installDesktop(f.deps, false)
  const quit = f.calls.find((call) => call[0] === '/usr/bin/osascript')
  expect(quit?.at(-1)).toBe(old)
  expect(checks).toBe(2)
})

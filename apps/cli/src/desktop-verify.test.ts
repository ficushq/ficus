import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopDeps } from './desktop-installer'
import { coreWorkflow, formatVerification, hasCodeSignature, sameNativeCode, verifyDesktop } from './desktop-verify'
import { defaultRunner, type Runner } from './local-server/runner'

const commit = 'a'.repeat(40)
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const sha = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** A minimal thin arm64 Mach-O: a header, a __LINKEDIT segment (and optionally a code signature command), then `body`. */
function machO(options: { vmsize: number; body: string; signed?: boolean }): Uint8Array {
  const commands = options.signed ? 2 : 1
  const bytes = new Uint8Array(32 + 72 + (options.signed ? 16 : 0) + options.body.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xfeedfacf, true)
  view.setUint32(16, commands, true)
  view.setUint32(32, 0x19, true)
  view.setUint32(36, 72, true)
  bytes.set(new TextEncoder().encode('__LINKEDIT'), 40)
  view.setBigUint64(64, BigInt(options.vmsize), true)
  if (options.signed) {
    view.setUint32(104, 0x1d, true)
    view.setUint32(108, 16, true)
  }
  bytes.set(new TextEncoder().encode(options.body), bytes.length - options.body.length)
  return bytes
}

test('native binaries match when only the signature-grown __LINKEDIT vmsize differs', () => {
  const original = machO({ vmsize: 0x3000, body: 'code and data' })
  expect(sameNativeCode(machO({ vmsize: 0x8000, body: 'code and data' }), original)).toBe(true)
  expect(sameNativeCode(machO({ vmsize: 0x8000, body: 'code and DATA' }), original)).toBe(false)
  expect(sameNativeCode(machO({ vmsize: 0x3000, body: 'longer code and data' }), original)).toBe(false)
  expect(sameNativeCode(new TextEncoder().encode('not a binary at all, but long enough'), original)).toBe(false)
  expect(hasCodeSignature(machO({ vmsize: 0x3000, body: 'x', signed: true }))).toBe(true)
  expect(hasCodeSignature(original)).toBe(false)
})

/** An app whose Core and Bun come from a public build, and the archive, release and tools around it. */
async function fixture(change: (app: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'ficus-verify-test-'))
  dirs.push(root)
  // The public build.
  const build = join(root, 'build', `ficus-core-${commit}`)
  await mkdir(join(build, 'apps/core/dist'), { recursive: true })
  const coreFiles: Record<string, string> = {
    'apps/core/dist/index.js': 'console.log("core")',
    'apps/core/dist/worker.js': 'console.log("worker")',
    'docs/unused.md': 'left out by Desktop',
  }
  for (const [path, content] of Object.entries(coreFiles)) {
    await mkdir(join(build, path, '..'), { recursive: true })
    await writeFile(join(build, path), content)
  }
  const artifact = {
    commit,
    files: Object.fromEntries(Object.entries(coreFiles).map(([path, content]) => [path, sha(content)])),
  }
  await writeFile(join(build, 'artifact.json'), JSON.stringify(artifact))
  const archive = join(root, `ficus-core-${commit}-darwin-arm64.tar.gz`)
  await defaultRunner(['/usr/bin/tar', '-czf', archive, '-C', join(root, 'build'), `ficus-core-${commit}`])

  // The app: Core without the file Desktop leaves out, plus its own manifest, and Bun.
  const app = join(root, 'Ficus.app')
  const core = join(app, 'Contents/Resources/core')
  for (const path of ['apps/core/dist/index.js', 'apps/core/dist/worker.js']) {
    await mkdir(join(core, path, '..'), { recursive: true })
    await writeFile(join(core, path), coreFiles[path]!)
  }
  await writeFile(join(core, 'artifact.json'), JSON.stringify(artifact))
  await writeFile(join(core, 'runtime.json'), JSON.stringify({ version: commit, files: {} }))
  const bun = join(app, 'Contents/Resources/bun')
  await mkdir(join(bun, 'bin'), { recursive: true })
  await writeFile(join(bun, 'bin/bun'), 'bun binary')
  await writeFile(join(bun, 'runtime.json'), JSON.stringify({ version: '1.4.2' }))
  await change(app)

  // Bun's release.
  const bunBuild = join(root, 'bun-release', 'bun-darwin-aarch64')
  await mkdir(bunBuild, { recursive: true })
  await writeFile(join(bunBuild, 'bun'), 'bun binary')
  const bunZip = join(root, 'bun-darwin-aarch64.zip')
  await defaultRunner(['/usr/bin/ditto', '-c', '-k', '--keepParent', bunBuild, bunZip])
  const bunZipBytes = await readFile(bunZip)
  let bunSums = `${sha(bunZipBytes).slice(7)}  bun-darwin-aarch64.zip\n`

  const calls: string[][] = []
  let attestation: { code: number; stdout: string; stderr: string } = {
    code: 0,
    stdout: JSON.stringify([
      { verificationResult: { signature: { certificate: { runInvocationURI: 'https://github.com/run/1' } } } },
    ]),
    stderr: '',
  }
  const runner: Runner = async (command, options) => {
    calls.push(command)
    if (command[0] === 'gh') return attestation
    if (command[0] === '/usr/libexec/PlistBuddy') return { code: 0, stdout: '0.5.13\n', stderr: '' }
    if (command[0] === '/usr/bin/codesign')
      return { code: 0, stdout: '', stderr: 'Authority=Developer ID Application: Ficus\nTeamIdentifier=5S6HE7KE49\n' }
    return defaultRunner(command, options)
  }
  const deps: DesktopDeps = {
    platform: 'darwin',
    arch: 'arm64',
    home: root,
    applications: root,
    runner,
    sleep: async () => {},
    verifyArchive: async () => {},
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/bun-darwin-aarch64.zip')) return new Response(bunZipBytes)
      if (url.endsWith('/SHASUMS256.txt')) return new Response(bunSums)
      return new Response('not found', { status: 404 })
    }) as typeof fetch,
  }
  return {
    deps,
    app,
    archive,
    calls,
    setAttestation: (value: typeof attestation) => {
      attestation = value
    },
    setBunSums: (value: string) => {
      bunSums = value
    },
  }
}

test('an app whose Core and Bun match the attested public builds verifies, and says what it did not check', async () => {
  const f = await fixture()
  const result = await verifyDesktop(f.deps, { application: f.app, archive: f.archive })
  expect(result).toMatchObject({
    version: '0.5.13',
    core: { commit, attestation: 'https://github.com/run/1' },
    files: { identical: 3, resigned: [], notShipped: 1 },
    bun: { version: '1.4.2', resigned: false },
  })
  const gh = f.calls.find((command) => command[0] === 'gh')!
  expect(gh).toEqual(
    expect.arrayContaining([
      '--repo',
      'ficushq/ficus',
      '--signer-workflow',
      coreWorkflow,
      '--source-ref',
      'refs/heads/main',
      '--source-digest',
      commit,
      '--deny-self-hosted-runners',
    ])
  )
  const report = formatVerification(result)
  expect(report).toContain(`Core ${commit} matches the public build`)
  expect(report).toContain('PostgreSQL')
  expect(report).toContain('The Desktop shell (closed source)')
})

test('a Core file that differs, or one the public build does not have, fails verification', async () => {
  const changed = await fixture((app) =>
    writeFile(join(app, 'Contents/Resources/core/apps/core/dist/index.js'), 'console.log("something else")')
  )
  await expect(verifyDesktop(changed.deps, { application: changed.app, archive: changed.archive })).rejects.toThrow(
    'differs from the public build of'
  )
  const extra = await fixture((app) => writeFile(join(app, 'Contents/Resources/core/apps/core/dist/extra.js'), 'x'))
  await expect(verifyDesktop(extra.deps, { application: extra.app, archive: extra.archive })).rejects.toThrow(
    'apps/core/dist/extra.js (not in the public build)'
  )
})

test('without a valid attestation, or without the GitHub CLI, nothing is verified', async () => {
  const f = await fixture()
  f.setAttestation({ code: 1, stdout: '', stderr: 'no matching attestations' })
  await expect(verifyDesktop(f.deps, { application: f.app, archive: f.archive })).rejects.toThrow(
    'no valid attestation'
  )
  f.setAttestation({ code: 127, stdout: '', stderr: 'gh: command not found' })
  await expect(verifyDesktop(f.deps, { application: f.app, archive: f.archive })).rejects.toThrow(
    'install it (https://cli.github.com)'
  )
})

test("a Bun download that does not match Bun's published checksum fails verification", async () => {
  const f = await fixture()
  f.setBunSums(`${'0'.repeat(64)}  bun-darwin-aarch64.zip\n`)
  await expect(verifyDesktop(f.deps, { application: f.app, archive: f.archive })).rejects.toThrow(
    "does not match Bun's published checksum"
  )
})

test('a release without the attested archive says it predates verifiable builds', async () => {
  const f = await fixture()
  await expect(verifyDesktop(f.deps, { application: f.app })).rejects.toThrow('predates verifiable Core builds')
})

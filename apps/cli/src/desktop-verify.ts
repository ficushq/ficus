import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopReleaseRepository, findInstalledDesktop, type DesktopDeps } from './desktop-installer'

/*
 * `ficus desktop verify`: checks that the Core inside an installed Ficus Desktop is the public
 * Core, file for file, without trusting anything the (closed-source) app says about itself.
 *
 *   1. The app is signed by the Ficus team and unmodified since (codesign).
 *   2. The Core archive for the app's bundled commit carries a build provenance attestation from
 *      this repository's public desktop-core workflow, on main, for that exact commit (gh).
 *   3. Every Core file in the app is byte-identical to that archive, except native binaries,
 *      which packaging re-signs: those must match once the signature is removed (see
 *      `sameNativeCode`). Files the app leaves out are fine; files the archive lacks are not.
 *   4. Bun, which runs Core, is checked the same way against Bun's own release.
 *
 * PostgreSQL (from Postgres.app) and the Desktop shell itself are not covered, and the report
 * says so.
 */

export const coreRepository = 'ficushq/ficus'
export const coreWorkflow = `${coreRepository}/.github/workflows/desktop-core.yml`
const teamId = '5S6HE7KE49'
const maxDownload = 1024 * 1024 * 1024

export interface DesktopVerification {
  application: string
  version: string
  core: { commit: string; archive: string; attestation: string | null }
  files: { identical: number; resigned: string[]; notShipped: number }
  bun: { version: string; resigned: boolean }
  notCovered: string[]
}

const sha256 = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return 'sha256:' + hash.digest('hex')
}

async function run(deps: DesktopDeps, command: string[], timeoutMs = 120_000) {
  const result = await deps.runner(command, { timeoutMs })
  if (result.code === 127) throw new Error(`${command[0]} is not installed`)
  return result
}
async function must(deps: DesktopDeps, command: string[], timeoutMs?: number): Promise<string> {
  const result = await run(deps, command, timeoutMs)
  if (result.code !== 0) throw new Error(`${command[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`)
  return result.stdout
}

const MH_MAGIC_64 = 0xfeedfacf
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

/** A thin 64-bit Mach-O (little-endian, as on Apple silicon). Universal binaries are not expected here. */
export function isMachO(bytes: Uint8Array): boolean {
  return bytes.length >= 32 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === MH_MAGIC_64
}

/** Walks a thin Mach-O's load commands. */
function loadCommands(bytes: Uint8Array, visit: (cmd: number, offset: number) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(16, true)
  let offset = 32
  for (let i = 0; i < count; i++) {
    if (offset + 8 > bytes.length) throw new Error('Truncated Mach-O load commands')
    const cmd = view.getUint32(offset, true)
    const size = view.getUint32(offset + 4, true)
    if (size < 8) throw new Error('Invalid Mach-O load command')
    visit(cmd, offset)
    offset += size
  }
}

export function hasCodeSignature(bytes: Uint8Array): boolean {
  let found = false
  loadCommands(bytes, (cmd) => {
    if (cmd === LC_CODE_SIGNATURE) found = true
  })
  return found
}

/** The __LINKEDIT segment's vmsize field offset, or -1. */
function linkeditVmsizeOffset(bytes: Uint8Array): number {
  let at = -1
  loadCommands(bytes, (cmd, offset) => {
    if (cmd !== LC_SEGMENT_64) return
    const name = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 24)).replace(/\0+$/, '')
    if (name === '__LINKEDIT') at = offset + 32
  })
  return at
}

/**
 * Whether two unsigned thin Mach-O binaries are the same code. Signing grows __LINKEDIT's vmsize to
 * fit the signature, and removing the signature leaves it grown: that one field (memory layout, not
 * code or data) is taken from `expected`; every other byte must match.
 */
export function sameNativeCode(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length || !isMachO(actual) || !isMachO(expected)) return false
  const at = linkeditVmsizeOffset(actual)
  if (at < 0 || at !== linkeditVmsizeOffset(expected)) return false
  const normalized = Uint8Array.from(actual)
  normalized.set(expected.subarray(at, at + 8), at)
  return Buffer.from(normalized).equals(Buffer.from(expected))
}

/** `path`'s bytes without a code signature (a stripped copy when it has one). */
async function unsigned(deps: DesktopDeps, path: string, scratch: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(path))
  if (!hasCodeSignature(bytes)) return bytes
  const copy = join(scratch, `strip-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`)
  await copyFile(path, copy)
  await must(deps, ['/usr/bin/codesign', '--remove-signature', copy])
  return new Uint8Array(await readFile(copy))
}

/** Every regular file under `root`, relative; links and special files are refused. */
async function files(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const info = await lstat(join(root, relative))
    if (info.isSymbolicLink()) throw new Error(`The app's Core contains a symbolic link: ${relative}`)
    if (info.isDirectory()) found.push(...(await files(root, relative)))
    else if (info.isFile()) found.push(relative)
    else throw new Error(`The app's Core contains a special file: ${relative}`)
  }
  return found
}

async function download(deps: DesktopDeps, url: string, path: string, missing: string): Promise<void> {
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (response.status === 404) throw new Error(missing)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxDownload) throw new Error(`Download is too large: ${url}`)
  await writeFile(path, new Uint8Array(await response.arrayBuffer()))
}

async function plist(deps: DesktopDeps, application: string, key: string): Promise<string> {
  return (
    await must(deps, ['/usr/libexec/PlistBuddy', '-c', `Print :${key}`, join(application, 'Contents/Info.plist')])
  ).trim()
}

/** The attestation check: this exact archive, from the public workflow, on main, at `commit`. */
async function verifyAttestation(
  deps: DesktopDeps,
  archive: string,
  commit: string,
  bundle: string | undefined
): Promise<string | null> {
  const result = await run(
    deps,
    [
      'gh',
      'attestation',
      'verify',
      archive,
      '--repo',
      coreRepository,
      '--signer-workflow',
      coreWorkflow,
      '--source-ref',
      'refs/heads/main',
      '--source-digest',
      commit,
      '--deny-self-hosted-runners',
      '--format',
      'json',
      ...(bundle ? ['--bundle', bundle] : []),
    ],
    300_000
  ).catch((error: Error) => {
    if (/not installed/.test(error.message))
      throw new Error(
        'The build attestation is checked with the GitHub CLI: install it (https://cli.github.com) and run this again.'
      )
    throw error
  })
  if (result.code !== 0)
    throw new Error(
      `The Core archive has no valid attestation from ${coreWorkflow} for ${commit}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`
    )
  try {
    const parsed = JSON.parse(result.stdout) as {
      verificationResult?: { signature?: { certificate?: { runInvocationURI?: string } } }
    }[]
    return parsed[0]?.verificationResult?.signature?.certificate?.runInvocationURI ?? null
  } catch {
    return null
  }
}

export async function verifyDesktop(
  deps: DesktopDeps,
  options: { application?: string; archive?: string } = {}
): Promise<DesktopVerification> {
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64')
    throw new Error('Ficus Desktop is macOS-only for now (Apple silicon).')
  const application = options.application ?? (await findInstalledDesktop(deps))
  if (!application) throw new Error('Ficus Desktop is not installed. Pass the app’s path to check another copy.')

  // 1. Signed by the Ficus team, and unmodified since.
  await must(deps, ['/usr/bin/codesign', '--verify', '--deep', '--strict', application])
  const signature = await run(deps, ['/usr/bin/codesign', '--display', '--verbose=4', application])
  if (!new RegExp(`^TeamIdentifier=${teamId}$`, 'm').test(signature.stdout + signature.stderr))
    throw new Error('This app is not signed by the Ficus Developer ID team')
  const version = await plist(deps, application, 'CFBundleShortVersionString')

  const resources = join(application, 'Contents/Resources')
  const coreRoot = join(resources, 'core')
  const runtime = JSON.parse(await readFile(join(coreRoot, 'runtime.json'), 'utf8')) as { version?: unknown }
  const commit = String(runtime.version ?? '')
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The app does not say which Core commit it bundles')

  const scratch = await mkdtemp(join(tmpdir(), 'ficus-desktop-verify-'))
  try {
    // 2. The public, attested archive for that commit.
    const name = `ficus-core-${commit}-darwin-arm64.tar.gz`
    let archive = options.archive
    let bundle: string | undefined
    if (!archive) {
      archive = join(scratch, name)
      const base = `https://github.com/${desktopReleaseRepository}/releases/download/v${version}`
      const missing = `Ficus Desktop ${version} predates verifiable Core builds; this check covers releases that ship the attested Core archive.`
      await download(deps, `${base}/${name}`, archive, missing)
      bundle = join(scratch, `${name}.sigstore.json`)
      await download(deps, `${base}/${name}.sigstore.json`, bundle, missing)
    }
    const attestation = await verifyAttestation(deps, archive, commit, bundle)
    const extracted = join(scratch, 'archive')
    await mkdir(extracted)
    await must(deps, ['/usr/bin/tar', '-xzf', archive, '--no-same-owner', '-C', extracted], 300_000)
    const archiveRoot = join(extracted, `ficus-core-${commit}`)
    const artifact = JSON.parse(await readFile(join(archiveRoot, 'artifact.json'), 'utf8')) as {
      commit?: string
      files?: Record<string, string>
    }
    if (artifact.commit !== commit || !artifact.files) throw new Error('The archive is for a different Core commit')

    // 3. File for file.
    const different: string[] = []
    const resigned: string[] = []
    let identical = 0
    let fromBuild = 0
    for (const path of await files(coreRoot)) {
      // Desktop's own list of the files it ships (with their re-signed hashes), not Core code.
      if (path === 'runtime.json') continue
      const actual = join(coreRoot, path)
      const expected =
        path === 'artifact.json' ? await sha256(join(archiveRoot, 'artifact.json')) : artifact.files[path]
      if (!expected) {
        different.push(`${path} (not in the public build)`)
        continue
      }
      if (path !== 'artifact.json') fromBuild++
      if ((await sha256(actual)) === expected) {
        identical++
        continue
      }
      const original = join(archiveRoot, path)
      const ok =
        isMachO(new Uint8Array((await readFile(actual)).subarray(0, 32))) &&
        sameNativeCode(await unsigned(deps, actual, scratch), await unsigned(deps, original, scratch))
      if (ok) resigned.push(path)
      else different.push(path)
    }
    if (different.length)
      throw new Error(
        `The app's Core differs from the public build of ${commit} in ${different.length} file(s): ${different.slice(0, 10).join(', ')}`
      )
    const notShipped = Object.keys(artifact.files).length - fromBuild

    // 4. Bun, from Bun's own release.
    const bunRoot = join(resources, 'bun')
    const bunVersion = String(
      (JSON.parse(await readFile(join(bunRoot, 'runtime.json'), 'utf8')) as { version?: unknown }).version ?? ''
    )
    if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) throw new Error('The app does not say which Bun it bundles')
    const bunRelease = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}`
    const bunZip = join(scratch, 'bun-darwin-aarch64.zip')
    await download(deps, `${bunRelease}/bun-darwin-aarch64.zip`, bunZip, `Bun ${bunVersion} has no macOS release`)
    const sums = await deps.fetch(`${bunRelease}/SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) })
    if (!sums.ok) throw new Error(`Bun's release checksums are unavailable (${sums.status})`)
    const listed = (await sums.text()).match(/^([a-f0-9]{64})\s+\*?bun-darwin-aarch64\.zip$/m)?.[1]
    if (!listed || (await sha256(bunZip)) !== `sha256:${listed}`)
      throw new Error("Bun's download does not match Bun's published checksum")
    const bunExtracted = join(scratch, 'bun')
    await must(deps, ['/usr/bin/ditto', '-x', '-k', bunZip, bunExtracted])
    const appBun = join(bunRoot, 'bin/bun')
    const upstreamBun = join(bunExtracted, 'bun-darwin-aarch64/bun')
    const bunIdentical = (await sha256(appBun)) === (await sha256(upstreamBun))
    if (
      !bunIdentical &&
      !sameNativeCode(await unsigned(deps, appBun, scratch), await unsigned(deps, upstreamBun, scratch))
    )
      throw new Error(`The app's Bun differs from Bun ${bunVersion}'s official release`)

    return {
      application,
      version,
      core: { commit, archive: options.archive ?? `${desktopReleaseRepository} v${version}/${name}`, attestation },
      files: { identical, resigned, notShipped },
      bun: { version: bunVersion, resigned: !bunIdentical },
      notCovered: [
        'PostgreSQL (from Postgres.app): compare it with its upstream release yourself',
        'The Desktop shell (closed source): it starts Core and holds your sign-ins',
      ],
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The report, for people. */
export function formatVerification(result: DesktopVerification): string {
  const lines = [
    `Ficus Desktop ${result.version} at ${result.application}: signed by the Ficus team (${teamId}).`,
    ``,
    `Core ${result.core.commit} matches the public build`,
    `  https://github.com/${coreRepository}/commit/${result.core.commit}`,
    `  Built and attested by ${coreWorkflow}${result.core.attestation ? `: ${result.core.attestation}` : ''}`,
    `  ${result.files.identical} files identical; ${result.files.resigned.length} native binaries identical apart from their code signature (${result.files.resigned.join(', ') || 'none'}); ${result.files.notShipped} files of the build left out (not used by Desktop).`,
    `Bun ${result.bun.version} matches Bun's official release${result.bun.resigned ? ', apart from its code signature' : ''}.`,
    ``,
    `Not covered:`,
    ...result.notCovered.map((line) => `  - ${line}`),
  ]
  return lines.join('\n')
}

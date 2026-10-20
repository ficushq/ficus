import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '../../packages/shared/src/managed-bigbrain'
import { computeDigest } from '../artifact/lib/manifest'

const REPOSITORY = 'https://github.com/elsehow/bigbrain.git'
const fileNames = [
  'LICENSE',
  'bigbrain-shared',
  'bigbrain-shared-invite',
  'bigbrain-owner-link',
  'install',
  'gateway',
  'preflight',
  'source.tar',
  'ficus-source.tar',
  'upstream-bun.lock',
] as const
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const fileFields = Object.fromEntries(fileNames.map((name) => [name, digestSchema])) as Record<
  (typeof fileNames)[number],
  typeof digestSchema
>
const provenanceSchema = z
  .object({
    schema: z.literal(1),
    repository: z.literal(REPOSITORY),
    upstreamCommit: z.literal(MANAGED_BIGBRAIN_UPSTREAM_COMMIT),
    ficusRepository: z.literal('https://github.com/ficushq/ficus.git'),
    ficusCommit: z.string().regex(/^[a-f0-9]{40}$/),
    target: z.literal('bun-linux-x64'),
    bunVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    license: z.literal('AGPL-3.0-only'),
    files: z.object(fileFields).strict(),
    digest: digestSchema,
  })
  .strict()
export type BigbrainArtifactProvenance = z.infer<typeof provenanceSchema>
export type BuildRunner = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string }>

/** Builder-only subprocesses. No tenant install/download path. Output/error content is never propagated. */
const runBuild: BuildRunner = async (argv, cwd) => {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let overflow = false
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 300_000)
  const read = async (stream: ReadableStream<Uint8Array>, capture: boolean) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 1024 * 1024) {
          overflow = true
          child.kill('SIGKILL')
        } else if (capture) chunks.push(result.value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    const [stdout] = await Promise.all([read(child.stdout, true), read(child.stderr, false)])
    const code = await child.exited
    if (overflow || timedOut) throw new Error('artifact_build_failed')
    return { code, stdout }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return `sha256:${digest.digest('hex')}`
}

/** Fixed-pin checkout -> frozen deps -> compiled runtime + corresponding source and integrity metadata.
 * The outer signed Core manifest supplies authenticity; this local manifest supplies component integrity.
 * A supplied source repo is read via git archive at the exact commit, never by copying its working tree.
 */
export async function buildBigbrainArtifact(options: {
  outDir: string
  bunVersion: string
  target?: string
  sourceRepository?: string
  run?: BuildRunner
}): Promise<BigbrainArtifactProvenance> {
  if ((options.target ?? 'bun-linux-x64') !== 'bun-linux-x64') throw new Error('unsupported_host')
  if (!/^\d+\.\d+\.\d+$/.test(options.bunVersion)) throw new Error('artifact_build_failed')
  const run = options.run ?? runBuild
  await mkdir(dirname(resolve(options.outDir)), { recursive: true })
  // Stage on the output filesystem so publication is an atomic rename, not an EXDEV copy.
  const scratch = await mkdtemp(join(dirname(resolve(options.outDir)), '.ficus-bigbrain-build-'))
  const source = join(scratch, 'source')
  const staging = join(scratch, 'artifact')
  const checked = async (argv: string[], cwd = scratch) => {
    const result = await run(argv, cwd)
    if (result.code !== 0) throw new Error('artifact_build_failed')
    return result.stdout.trim()
  }
  try {
    await mkdir(source)
    await mkdir(staging)
    let repository = options.sourceRepository
    if (!repository) {
      repository = join(scratch, 'repository')
      await checked(['git', 'init', '--bare', repository])
      await checked(['git', '-C', repository, 'fetch', '--depth=1', REPOSITORY, MANAGED_BIGBRAIN_UPSTREAM_COMMIT])
    }
    const resolved = await checked([
      'git',
      '-C',
      repository,
      'rev-parse',
      `${MANAGED_BIGBRAIN_UPSTREAM_COMMIT}^{commit}`,
    ])
    if (resolved !== MANAGED_BIGBRAIN_UPSTREAM_COMMIT) throw new Error('upstream_revision_mismatch')
    const archive = join(staging, 'source.tar')
    await checked([
      'git',
      '-C',
      repository,
      'archive',
      '--format=tar',
      '--output',
      archive,
      MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    ])
    await checked(['tar', '-xf', archive], source)
    // These are from the archived pin, never an untracked/local working tree.
    await copyFile(join(source, 'LICENSE'), join(staging, 'LICENSE'))
    await copyFile(join(source, 'bun.lock'), join(staging, 'upstream-bun.lock'))
    if ((await checked(['bun', '--version'], source)) !== options.bunVersion) throw new Error('artifact_build_failed')
    await checked(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], source)
    const ficusRoot = fileURLToPath(new URL('../../', import.meta.url))
    const ficusCommit = await checked(['git', '-C', ficusRoot, 'rev-parse', 'HEAD^{commit}'])
    if (!/^[a-f0-9]{40}$/.test(ficusCommit)) throw new Error('artifact_build_failed')
    // Corresponding Ficus source must actually match the policy compiled into this component.
    await checked([
      'git',
      '-C',
      ficusRoot,
      'diff',
      '--quiet',
      'HEAD',
      '--',
      'scripts/bigbrain',
      'scripts/artifact/lib/manifest.ts',
      'packages/shared/src/managed-bigbrain.ts',
    ])
    await checked([
      'git',
      '-C',
      ficusRoot,
      'archive',
      '--format=tar',
      '--output',
      join(staging, 'ficus-source.tar'),
      ficusCommit,
    ])
    const shimEntry = '.ficus-owner-link-entry.ts'
    await writeFile(
      join(source, shimEntry),
      `import { ownerLinkMain } from ${JSON.stringify(join(ficusRoot, 'scripts/bigbrain/owner-link.ts'))};\nimport { createAppLink } from './lib/sharedInvites.ts';\nawait ownerLinkMain(createAppLink);\n`
    )
    for (const [entry, binary] of [
      ['bin/shared.ts', 'bigbrain-shared'],
      ['bin/shared-invite.ts', 'bigbrain-shared-invite'],
      [shimEntry, 'bigbrain-owner-link'],
    ] as const) {
      await checked(
        ['bun', 'build', entry, '--compile', '--target=bun-linux-x64', '--outfile', join(staging, binary)],
        source
      )
      await chmod(join(staging, binary), 0o755)
    }
    // Ficus host entrypoints from the committed tree checked above (clean diff for these paths).
    for (const [entry, binary] of [
      ['scripts/bigbrain/install.ts', 'install'],
      ['scripts/bigbrain/gateway.ts', 'gateway'],
      ['scripts/bigbrain/preflight.ts', 'preflight'],
    ] as const) {
      await checked(
        ['bun', 'build', entry, '--compile', '--target=bun-linux-x64', '--outfile', join(staging, binary)],
        ficusRoot
      )
      await chmod(join(staging, binary), 0o755)
    }
    const files = Object.fromEntries(
      await Promise.all(fileNames.map(async (name) => [name, await hashFile(join(staging, name))]))
    ) as BigbrainArtifactProvenance['files']
    const manifest = provenanceSchema.parse({
      schema: 1,
      repository: REPOSITORY,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      ficusRepository: 'https://github.com/ficushq/ficus.git',
      ficusCommit,
      target: 'bun-linux-x64',
      bunVersion: options.bunVersion,
      license: 'AGPL-3.0-only',
      files,
      digest: computeDigest(files),
    })
    await writeFile(join(staging, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n')
    await verifyBigbrainArtifact(staging)
    await mkdir(dirname(options.outDir), { recursive: true })
    // Refuse existing output (including symlinks), never merge a prior artifact.
    try {
      await lstat(options.outDir)
      throw new Error('artifact_output_exists')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await rename(staging, options.outDir)
    return manifest
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function verifyBigbrainArtifact(root: string): Promise<BigbrainArtifactProvenance> {
  try {
    const names = [...fileNames, 'provenance.json']
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error()
    const entries = await readdir(root)
    if (entries.length !== names.length || entries.some((name) => !names.includes(name as (typeof names)[number])))
      throw new Error()
    for (const name of names) {
      const info = await lstat(join(root, name))
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error()
    }
    if ((await lstat(join(root, 'provenance.json'))).size > 16384) throw new Error()
    const manifest = provenanceSchema.parse(JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8')))
    for (const name of fileNames) if ((await hashFile(join(root, name))) !== manifest.files[name]) throw new Error()
    if (computeDigest(manifest.files) !== manifest.digest) throw new Error()
    return manifest
  } catch {
    throw new Error('artifact_invalid')
  }
}

/** CI/development preparation only, before the smoke test starts. No implicit test/runtime installs. */
export async function prepareBigbrainNativeSmoke(options: {
  artifactDir: string
  outDir: string
  run?: BuildRunner
}): Promise<void> {
  const manifest = await verifyBigbrainArtifact(options.artifactDir)
  const run = options.run ?? runBuild
  await mkdir(options.outDir, { mode: 0o700 })
  try {
    for (const argv of [
      ['tar', '-xf', join(options.artifactDir, 'source.tar')],
      ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
    ]) {
      if ((await run(argv, options.outDir)).code !== 0) throw new Error('artifact_build_failed')
    }
    if (hash(await readFile(join(options.outDir, 'bun.lock'))) !== manifest.files['upstream-bun.lock'])
      throw new Error('artifact_invalid')
  } catch {
    await rm(options.outDir, { recursive: true, force: true })
    throw new Error('artifact_build_failed')
  }
}

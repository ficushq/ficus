import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBigbrainArtifact, prepareBigbrainNativeSmoke, verifyBigbrainArtifact, type BuildRunner } from './artifact'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin } from '../../packages/shared/src/managed-bigbrain'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-artifact-'))
  roots.push(root)
  const calls: string[][] = []
  const run: BuildRunner = async (argv, cwd) => {
    calls.push(argv)
    if (argv[0] === 'bun' && argv.includes('--version')) return { code: 0, stdout: '1.4.2' }
    if (argv[0] === 'git' && argv.includes('rev-parse')) return { code: 0, stdout: pin + '\n' }
    if (argv[0] === 'git' && argv.includes('archive'))
      await writeFile(argv[argv.indexOf('--output') + 1]!, 'committed-source')
    if (argv[0] === 'tar') {
      await mkdir(join(cwd, 'bin'), { recursive: true })
      await writeFile(join(cwd, 'LICENSE'), 'AGPL-3.0-only synthetic fixture')
      await writeFile(join(cwd, 'bun.lock'), 'locked-dependencies')
    }
    if (argv.includes('--compile')) await writeFile(argv[argv.indexOf('--outfile') + 1]!, 'compiled:' + argv[2])
    return { code: 0, stdout: '' }
  }
  return { root, calls, run, output: join(root, 'artifact') }
}

test('packages only committed pinned sources, frozen dependencies, two binaries and source/license provenance', async () => {
  const f = await fixture()
  const manifest = await buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })
  expect(manifest.upstreamCommit).toBe(pin)
  expect(Object.keys(manifest.files).sort()).toEqual([
    'LICENSE',
    'bigbrain-shared',
    'bigbrain-shared-invite',
    'source.tar',
    'upstream-bun.lock',
  ])
  expect(f.calls).toContainEqual(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'])
  const compiles = f.calls.filter((argv) => argv.includes('--compile'))
  expect(compiles).toHaveLength(2)
  expect(compiles.every((argv) => argv.includes('--target=bun-linux-x64'))).toBe(true)
  expect(f.calls.flat().some((arg) => arg.includes('systemctl') || arg.includes('curl'))).toBe(false)
  expect(await verifyBigbrainArtifact(f.output)).toEqual(manifest)
})
test('prepares frozen native dependencies from the verified artifact source before tests, never a moving checkout', async () => {
  const f = await fixture()
  await buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })
  const prepared = join(f.root, 'native')
  await prepareBigbrainNativeSmoke({ artifactDir: f.output, outDir: prepared, run: f.run })
  expect(await readFile(join(prepared, 'bun.lock'), 'utf8')).toBe('locked-dependencies')
  expect(f.calls.filter((argv) => argv[0] === 'bun' && argv[1] === 'install')).toHaveLength(2)
})

test('refuses a changed upstream revision before installation/build', async () => {
  const f = await fixture()
  const run: BuildRunner = async (argv, cwd) =>
    argv.includes('rev-parse') ? { code: 0, stdout: 'a'.repeat(40) } : f.run(argv, cwd)
  await expect(buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run })).rejects.toThrow(
    'upstream_revision_mismatch'
  )
  expect(f.calls.some((argv) => argv.includes('install'))).toBe(false)
})
test('refuses tampered binaries and missing corresponding source/license', async () => {
  for (const target of ['bigbrain-shared', 'source.tar', 'LICENSE']) {
    const f = await fixture()
    await buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })
    await writeFile(join(f.output, target), 'tampered')
    await expect(verifyBigbrainArtifact(f.output)).rejects.toThrow('artifact_invalid')
  }
})
test('refuses symlinked files and preserves existing output rather than merging it', async () => {
  const f = await fixture()
  await buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })
  await expect(buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })).rejects.toThrow(
    'artifact_output_exists'
  )
  await rm(join(f.output, 'LICENSE'))
  await symlink(join(f.output, 'source.tar'), join(f.output, 'LICENSE'))
  await expect(verifyBigbrainArtifact(f.output)).rejects.toThrow('artifact_invalid')
})
test('refuses unsupported target and malformed provenance', async () => {
  const f = await fixture()
  await expect(
    buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', target: 'darwin-arm64', run: f.run })
  ).rejects.toThrow('unsupported_host')
  expect(f.calls).toHaveLength(0)
  await buildBigbrainArtifact({ outDir: f.output, bunVersion: '1.4.2', run: f.run })
  const manifest = JSON.parse(await readFile(join(f.output, 'provenance.json'), 'utf8'))
  manifest.upstreamCommit = 'main'
  await writeFile(join(f.output, 'provenance.json'), JSON.stringify(manifest))
  await expect(verifyBigbrainArtifact(f.output)).rejects.toThrow('artifact_invalid')
})

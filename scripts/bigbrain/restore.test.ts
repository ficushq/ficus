import { afterEach, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { backupManifestSchema } from './backup'
import { installedHostSchema } from './control-input'
import { inspectVaultArchive, planArchiveRestore, readStagedArchive, recordRestorePlan } from './restore'
import { writePrivateJson } from './secure-files'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const TENANT = '11111111-1111-4111-8111-111111111111'
const BINDING = '33333333-3333-4333-8333-333333333333'
const A = '22222222-2222-4222-8222-222222222222'
const UPSTREAM = '66666666-6666-4666-8666-666666666666'
const limits = { maxEntries: 100, maxBytes: 1024 * 1024 }

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'bigbrain-restore-'))
  roots.push(dir)
  return dir
}
async function tar(cwd: string, out: string, args: string[]) {
  const proc = Bun.spawn(['tar', '--format=gnu', '-cf', out, ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  expect(await proc.exited).toBe(0)
}
async function vaultTree() {
  const dir = await scratch()
  const src = join(dir, 'src')
  await mkdir(join(src, 'auth'), { recursive: true })
  await mkdir(join(src, 'vault', 'feed'), { recursive: true })
  await writeFile(join(src, 'auth', 'members.json'), '{}')
  await writeFile(join(src, 'vault', 'feed', `${'n'.repeat(140)}.md`), 'long name entry')
  return { dir, src }
}

test('accepts only regular files/directories under auth/ and vault/, including GNU long names', async () => {
  const { dir, src } = await vaultTree()
  await tar(src, join(dir, 'ok.tar'), ['auth', 'vault'])
  expect(await inspectVaultArchive(join(dir, 'ok.tar'), limits)).toMatchObject({ entries: 5 })
})

test('links, devices/FIFOs, foreign roots, absolute and parent paths are refused before extraction', async () => {
  const cases: [string, (src: string) => Promise<string[]>][] = [
    ['symlink', async (src) => (await symlink('/etc/passwd', join(src, 'vault', 'evil')), ['auth', 'vault'])],
    [
      'hardlink',
      async (src) => (await link(join(src, 'auth', 'members.json'), join(src, 'vault', 'hard')), ['auth', 'vault']),
    ],
    ['fifo', async (src) => (Bun.spawnSync(['mkfifo', join(src, 'vault', 'pipe')]), ['auth', 'vault'])],
    ['foreign root', async (src) => (await mkdir(join(src, 'other')), ['auth', 'vault', 'other'])],
    ['parent path', async () => ['--transform=s,^vault,vault/../../escape,', 'auth', 'vault']],
    ['absolute path', async () => ['-P', '--transform=s,^vault,/tmp/escape,', 'auth', 'vault']],
  ]
  for (const [name, build] of cases) {
    const { dir, src } = await vaultTree()
    await tar(src, join(dir, 'bad.tar'), await build(src))
    await expect(inspectVaultArchive(join(dir, 'bad.tar'), limits), name).rejects.toThrow('invalid_request')
  }
})

test('entry/size limits and truncated or corrupted headers fail closed', async () => {
  const { dir, src } = await vaultTree()
  await tar(src, join(dir, 'ok.tar'), ['auth', 'vault'])
  await expect(inspectVaultArchive(join(dir, 'ok.tar'), { maxEntries: 2, maxBytes: 1 << 20 })).rejects.toThrow(
    'invalid_request'
  )
  await expect(inspectVaultArchive(join(dir, 'ok.tar'), { maxEntries: 100, maxBytes: 4 })).rejects.toThrow(
    'invalid_request'
  )
  const bytes = await Bun.file(join(dir, 'ok.tar')).bytes()
  await writeFile(join(dir, 'short.tar'), bytes.subarray(0, 700))
  await expect(inspectVaultArchive(join(dir, 'short.tar'), limits)).rejects.toThrow('invalid_request')
  const corrupt = Buffer.from(bytes)
  corrupt[10] = corrupt[10]! ^ 0xff
  await writeFile(join(dir, 'corrupt.tar'), corrupt)
  await expect(inspectVaultArchive(join(dir, 'corrupt.tar'), limits)).rejects.toThrow('invalid_request')
})

async function staged(manifestTenant = TENANT, archivedOrigin?: string) {
  const root = await scratch()
  const etc = join(root, 'etc')
  const dir = join(root, 'state', 'restore', 'managed-bigbrain')
  await mkdir(etc, { mode: 0o700 })
  await mkdir(join(dir, 'vaults'), { recursive: true, mode: 0o700 })
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: TENANT,
      physicalHostBinding: '44444444-4444-4444-8444-444444444444',
      hostEpoch: 5,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      zone: 'example.com',
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  const data = Buffer.from('vault archive bytes')
  await writeFile(join(dir, 'vaults', `${A}.tar`), data, { mode: 0o600 })
  await writePrivateJson(
    dir,
    'manifest.json',
    {
      schema: 1,
      tenantId: manifestTenant,
      sourcePhysicalHostBinding: BINDING,
      vaults: [
        {
          vaultId: A,
          upstreamVaultId: UPSTREAM,
          generation: 3,
          displayName: 'Research',
          owner: { userId: TENANT, handle: 'ada', display: 'Ada' },
          archive: `vaults/${A}.tar`,
          sha256: `sha256:${createHash('sha256').update(data).digest('hex')}`,
          bytes: data.length,
          ...(archivedOrigin === undefined ? {} : { origin: archivedOrigin }),
        },
      ],
    },
    backupManifestSchema,
    { uid }
  )
  return { root: join(root, 'state'), etc, dir }
}

test('fence inventory re-verifies every staged hash and reports archive lineage, never authority', async () => {
  const s = await staged()
  const { inventory } = await readStagedArchive({ root: s.root, etc: s.etc, uid })
  expect(inventory).toMatchObject({
    tenantId: TENANT,
    sourcePhysicalHostBinding: BINDING,
    vaults: [{ vaultId: A, upstreamVaultId: UPSTREAM, generation: 3 }],
  })
  await writeFile(join(s.dir, 'vaults', `${A}.tar`), 'tampered', { mode: 0o600 })
  await expect(readStagedArchive({ root: s.root, etc: s.etc, uid })).rejects.toThrow('invalid_request')
})

test('a foreign-tenant or extra-file staging is refused', async () => {
  const foreign = await staged('55555555-5555-4555-8555-555555555555')
  await expect(readStagedArchive({ root: foreign.root, etc: foreign.etc, uid })).rejects.toThrow('identity_mismatch')
  const extra = await staged()
  await writeFile(join(extra.dir, 'vaults', 'extra.tar'), 'x', { mode: 0o600 })
  await expect(readStagedArchive({ root: extra.root, etc: extra.etc, uid })).rejects.toThrow('invalid_request')
})

test('every archived vault is planned from the archive: newer generation, installed-zone origin, read revoked', async () => {
  const s = await staged()
  const { manifest, inventory } = await readStagedArchive({ root: s.root, etc: s.etc, uid })
  const plan = planArchiveRestore(manifest, inventory, inventory.manifestDigest, 'example.com')
  expect(plan).toEqual([
    {
      vaultId: A,
      upstreamVaultId: UPSTREAM,
      generation: manifest.vaults[0]!.generation + 1,
      displayName: manifest.vaults[0]!.displayName,
      owner: manifest.vaults[0]!.owner,
      origin: `https://bb-${A.replaceAll('-', '')}.example.com`,
    },
  ])
  // The origin follows THIS host's installed zone, never the archive's.
  expect(planArchiveRestore(manifest, inventory, inventory.manifestDigest, 'other.example.org')[0]!.origin).toBe(
    `https://bb-${A.replaceAll('-', '')}.other.example.org`
  )
  expect(() => planArchiveRestore(manifest, inventory, `sha256:${'0'.repeat(64)}`, 'example.com')).toThrow(
    'identity_mismatch'
  )
  // An archive that recorded a tenant-prefixed origin keeps its label (never the current one).
  const short = A.replaceAll('-', '').slice(0, 12)
  const labelled = await staged(TENANT, `https://acme-bb-${short}.example.com`)
  const archived = await readStagedArchive({ root: labelled.root, etc: labelled.etc, uid })
  expect(
    planArchiveRestore(archived.manifest, archived.inventory, archived.inventory.manifestDigest, 'example.com')[0]!
      .origin
  ).toBe(`https://acme-bb-${short}.example.com`)
  expect(
    planArchiveRestore(
      archived.manifest,
      archived.inventory,
      archived.inventory.manifestDigest,
      'other.example.org'
    )[0]!.origin
  ).toBe(`https://acme-bb-${short}.other.example.org`)
  // A recorded origin of another vault is not a valid archive.
  await expect(staged(TENANT, `https://acme-bb-${'0'.repeat(12)}.example.com`)).rejects.toThrow()
  // Persisted outside the archive; exact replay is accepted, a different plan conflicts.
  await recordRestorePlan(plan, inventory.manifestDigest, { root: s.root, uid })
  await recordRestorePlan(plan, inventory.manifestDigest, { root: s.root, uid })
  await expect(
    recordRestorePlan([{ ...plan[0]!, generation: 99 }], inventory.manifestDigest, { root: s.root, uid })
  ).rejects.toThrow('request_conflict')
})

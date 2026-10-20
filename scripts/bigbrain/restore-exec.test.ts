import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { backupManifestSchema } from './backup'
import { installedHostSchema } from './control-input'
import { simulatedHost } from './host-test-fixtures'
import type { NativeMember } from './native-admin'
import { managedPaths } from './paths'
import { readStoreIdentity } from './provision'
import { readStagedArchive } from './restore'
import { executeRestore } from './restore-exec'
import { writePrivateJson } from './secure-files'
import { linuxDeviceId } from './storage'
import { initializeStorageNamespace } from './volume-image'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const TENANT = '11111111-1111-4111-8111-111111111111'
const OLD_BINDING = '33333333-3333-4333-8333-333333333333'
const NEW_BINDING = '44444444-4444-4444-8444-444444444444'
const A = '22222222-2222-4222-8222-222222222222'
const B = '55555555-5555-4555-8555-555555555555'
const UPSTREAM_A = '66666666-6666-4666-8666-666666666666'
const UPSTREAM_B = '77777777-7777-4777-8777-777777777777'
const owner = { userId: TENANT, handle: 'ada', display: 'Ada' }
const hex = (id: string) => id.replaceAll('-', '')

async function vaultTar(dir: string, upstream: string, extra?: (src: string) => Promise<void>) {
  const src = join(dir, `src-${upstream}`)
  await mkdir(join(src, 'auth'), { recursive: true })
  await mkdir(join(src, 'vault'), { recursive: true })
  await writeFile(join(src, 'auth', 'members.json'), '{"members":[]}')
  await writeFile(join(src, 'auth', 'members.json.invites.json'), '[{"secret":"old-invite"}]')
  await writeFile(
    join(src, 'vault', '.shared-identity.json'),
    JSON.stringify({ id: upstream, name: 'Shared BigBrain' })
  )
  await writeFile(join(src, 'vault', 'evidence.md'), `human contribution ${upstream}`)
  await extra?.(src)
  const out = join(dir, `${upstream}.tar`)
  const proc = Bun.spawn(['tar', '--format=gnu', '-cf', out, 'auth', 'vault'], { cwd: src })
  expect(await proc.exited).toBe(0)
  return out
}

async function fixture(options: { storedIdentityForA?: string } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-restore-exec-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const etc = join(outer, 'etc')
  const unitDirectory = join(outer, 'units')
  await initializeStorageNamespace({ root, uid })
  await mkdir(etc, { mode: 0o700 })
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: TENANT,
      physicalHostBinding: NEW_BINDING,
      hostEpoch: 7,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      zone: 'example.com',
      limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS, perVaultDiskBytes: 16 * 1024 ** 2 },
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  // Staged by setup's restore guard: root-private manifest + per-vault tarballs.
  const staging = join(root, 'restore', 'managed-bigbrain')
  await mkdir(join(staging, 'vaults'), { recursive: true, mode: 0o700 })
  const vaults = []
  for (const [vaultId, upstream] of [
    [A, UPSTREAM_A],
    [B, UPSTREAM_B],
  ] as const) {
    const tar = await vaultTar(outer, vaultId === A ? (options.storedIdentityForA ?? upstream) : upstream)
    const bytes = await readFile(tar)
    await writeFile(join(staging, 'vaults', `${vaultId}.tar`), bytes, { mode: 0o600 })
    vaults.push({
      vaultId,
      upstreamVaultId: upstream,
      generation: 3,
      displayName: `Vault ${vaultId.slice(0, 2)}`,
      owner,
      archive: `vaults/${vaultId}.tar`,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.length,
    })
  }
  await writePrivateJson(
    staging,
    'manifest.json',
    { schema: 1, tenantId: TENANT, sourcePhysicalHostBinding: OLD_BINDING, vaults },
    backupManifestSchema,
    { uid }
  )
  const host = simulatedHost({ root, unitDirectory, tenantId: TENANT, physicalHostBinding: NEW_BINDING })
  const revoked: string[] = []
  const members: NativeMember[] = [
    { id: 'mem_00000001', handle: 'ada', role: 'owner', permissions: ['read', 'write'], revoked: null },
  ]
  const credentials = [
    {
      id: 'aaaaaaaa',
      member_id: 'mem_00000001',
      name: 'owner',
      kind: 'person' as const,
      scopes: ['read', 'write'] as ('read' | 'write')[],
      followsMember: false,
      sha256: 'a'.repeat(64),
      revoked: null,
    },
    {
      id: 'bbbbbbbb',
      member_id: 'mem_00000002',
      name: 'Ficus read',
      kind: 'agent' as const,
      scopes: ['read'] as ('read' | 'write')[],
      followsMember: false,
      sha256: 'b'.repeat(64),
      revoked: null,
    },
  ]
  let ingress = 0
  const deps = {
    root,
    etc,
    uid,
    unitDirectory,
    run: host.run,
    mountinfo: host.mountinfo,
    prepareLayout: host.prepareLayout,
    freeBytes: async () => 100 * 1024 ** 3,
    probeReady: async () => true,
    sleep: async () => {},
    // The tmp "mount" is not a loop device: read identity through the same no-follow walk on its real device.
    readUpstreamIdentity: async (record: { receipt: { vaultId: string } }) => {
      const mount = managedPaths({ root, vaultId: record.receipt.vaultId }).mount
      return readStoreIdentity(mount, linuxDeviceId((await stat(mount)).dev))
    },
    admin: () => ({
      listMembers: async () => members,
      listCredentials: async () => credentials,
      revokeCredential: async (id: string) => void revoked.push(id),
    }),
    ingress: async () => void ingress++,
  }
  const inventory = (await readStagedArchive({ root, etc, uid })).inventory
  const grant = (vaultId: string, upstreamVaultId: string) => ({
    vaultId,
    disposition: 'restore',
    upstreamVaultId,
    generation: 4,
    owner,
    origin: `https://bb-${hex(vaultId)}.example.com`,
    readAccess: 'revoked',
  })
  const request = {
    requestId: '88888888-8888-4888-8888-888888888888',
    effectId: '99999999-9999-4999-8999-999999999999',
    archiveManifestDigest: inventory.manifestDigest,
    currentVaults: [grant(A, UPSTREAM_A), { vaultId: B, disposition: 'exclude', code: 'not_found' }],
  }
  return { root, host, deps, request, revoked, ingress: () => ingress, grant }
}

test('restores only granted vaults on fresh local storage, keeps upstream identity, revokes every imported credential and invite', async () => {
  const f = await fixture()
  const [restored] = await executeRestore(f.request, f.deps)
  expect(restored).toMatchObject({
    phase: 'ready',
    receipt: {
      vaultId: A,
      physicalHostBinding: NEW_BINDING,
      hostEpoch: 7,
      generation: 4,
      upstreamVaultId: UPSTREAM_A,
      state: 'ready',
      readAccess: 'revoked',
    },
  })
  const paths = managedPaths({ root: f.root, vaultId: A })
  expect(await readFile(join(paths.vault, 'evidence.md'), 'utf8')).toBe(`human contribution ${UPSTREAM_A}`)
  // Imported invitations are void; every imported credential (owner and Ficus reader) is revoked.
  await expect(stat(`${paths.memberStore}.invites.json`)).rejects.toThrow()
  expect(f.revoked).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  // Ownership goes to the NEW account (archived numeric owners are ignored).
  const account = [...f.host.accounts.values()][0]!
  expect(f.host.calls).toContainEqual([
    '/usr/bin/chown',
    '-R',
    '--no-dereference',
    `${account.uid}:${account.gid}`,
    '--',
    paths.vault,
  ])
  expect(f.host.calls.find((c) => c[0] === '/usr/bin/tar')).toContain('--no-same-owner')
  // The excluded vault is never mounted, accounted or routed.
  await expect(stat(managedPaths({ root: f.root, vaultId: B }).control)).rejects.toThrow()
  expect(f.host.calls.some((c) => c.join(' ').includes(B))).toBe(false)
  // Plaintext staging is discarded once complete; an exact replay still answers from the plan.
  await expect(stat(join(f.root, 'restore', 'managed-bigbrain'))).rejects.toThrow()
  expect((await executeRestore(f.request, f.deps)).map((r) => r.receipt.vaultId)).toEqual([A])
  expect(f.revoked).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  await expect(
    executeRestore({ ...f.request, currentVaults: [f.grant(A, UPSTREAM_A), f.grant(B, UPSTREAM_B)] }, f.deps)
  ).rejects.toThrow('request_conflict')
})

test('a store whose identity does not match the grant is never started or routed', async () => {
  const f = await fixture({ storedIdentityForA: UPSTREAM_B })
  await expect(executeRestore(f.request, f.deps)).rejects.toThrow('identity_mismatch')
  expect(f.host.calls.some((c) => c[1] === 'enable' && c.at(-1) === `ficus-bigbrain@${A}.service`)).toBe(false)
  expect(f.revoked).toEqual([])
  expect(f.ingress()).toBe(0)
})

test('a grant for another upstream identity is refused before any storage exists', async () => {
  const f = await fixture()
  await expect(
    executeRestore({ ...f.request, currentVaults: [f.grant(A, UPSTREAM_B), f.grant(B, UPSTREAM_B)] }, f.deps)
  ).rejects.toThrow('generation_conflict')
  await expect(stat(managedPaths({ root: f.root, vaultId: A }).control)).rejects.toThrow()
})

import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
} from '../../packages/shared/src/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { initializeStorageNamespace } from './volume-image'
import { backupManifestSchema, reconcileMaintenance, releaseManagedBackup, stageManagedBackup } from './backup'
import type { PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const A = '22222222-2222-4222-8222-222222222222'
const B = '44444444-4444-4444-8444-444444444444'
const LEASE = '55555555-5555-4555-8555-555555555555'

function serving(root: string, vaultId: string, upstreamVaultId: string): ControlReceipt {
  const base = reservedVaultFixture(root)
  const paths = managedPaths({ root, vaultId })
  return controlReceiptSchema.parse({
    ...base,
    phase: 'ready',
    receipt: {
      ...base.receipt,
      vaultId,
      upstreamVaultId,
      state: 'ready',
      readAccess: 'active',
      origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
    },
    storage: { ...base.storage, vaultId, mount: paths.mount, image: paths.image },
    os: { uid: 1200, gid: 1201, imageDevice: 1, imageInode: 2, mountDevice: '7:4' },
  })
}

async function fixture(options: { active?: string[]; failTar?: string; failStart?: boolean } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-backup-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const etc = join(outer, 'etc')
  await initializeStorageNamespace({ root, uid })
  await mkdir(etc, { mode: 0o700 })
  const base = reservedVaultFixture(root)
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: base.receipt.tenantId,
      physicalHostBinding: base.receipt.physicalHostBinding,
      hostEpoch: 1,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: base.receipt.artifactDigest,
      zone: 'example.com',
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  const records = {
    [A]: serving(root, A, '66666666-6666-4666-8666-666666666666'),
    [B]: serving(root, B, '77777777-7777-4777-8777-777777777777'),
  }
  for (const record of Object.values(records)) {
    const paths = managedPaths({ root, vaultId: record.receipt.vaultId })
    await ensureOwnedDirectory(paths.control, 0o700, { uid })
    await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
  }
  const active = new Set(options.active ?? [A, B])
  const trace: string[] = []
  const run: PrivateCommandRunner = async (argv) => {
    const unit = argv.at(-1)!
    const id = unit.slice('ficus-bigbrain@'.length, -'.service'.length)
    if (argv[1] === 'is-active') return { code: active.has(id) ? 0 : 3, stdout: '' }
    if (argv[1] === 'stop') {
      trace.push(`stop:${id}`)
      active.delete(id)
    }
    if (argv[1] === 'start') {
      trace.push(`start:${id}`)
      if (options.failStart) return { code: 1, stdout: '' }
      active.add(id)
    }
    if (argv[0] === '/usr/bin/tar') {
      const vault = argv[argv.indexOf('--directory') + 1]!.split('/').at(-1)!
      trace.push(`copy:${vault}:${active.has(vault) ? 'LIVE' : 'quiet'}`)
      await writeFile(argv[argv.indexOf('--file') + 1]!, `tar of ${vault}`)
      // GNU tar writes a (possibly incomplete) archive and exits 1 on "file changed" warnings.
      if (options.failTar === vault) return { code: 1, stdout: '' }
    }
    return { code: 0, stdout: '' }
  }
  const verified: string[] = []
  const opts = {
    root,
    etc,
    uid,
    run,
    leaseId: LEASE,
    freeBytes: async () => 100 * 1024 ** 3,
    verifyStorage: async (r: ControlReceipt) => {
      verified.push(r.receipt.vaultId)
    },
  }
  return { root, etc, opts, trace, active, records, verified }
}

test('quiesces only serving vaults, copies each verified store while stopped, restarts them and returns the bounded inventory', async () => {
  const f = await fixture()
  const result = (await stageManagedBackup(f.opts))!
  expect(f.trace).toEqual([`stop:${A}`, `stop:${B}`, `copy:${A}:quiet`, `copy:${B}:quiet`, `start:${A}`, `start:${B}`])
  expect(f.verified).toEqual([A, B])
  expect(result.inventory.vaults.map((v) => v.vaultId)).toEqual([A, B])
  expect(result.inventory.manifestDigest).toMatch(/^sha256:/)
  const manifest = await readPrivateJson(
    join(result.staging, 'managed-bigbrain'),
    'manifest.json',
    backupManifestSchema,
    { uid }
  )
  expect(manifest.vaults[0]).toMatchObject({ archive: `vaults/${A}.tar`, bytes: `tar of ${A}`.length })
  // Secret-free manifest: no tokens, escrow or invite material ever enters the archive staging.
  expect(await readFile(join(result.staging, 'managed-bigbrain', 'manifest.json'), 'utf8')).not.toMatch(
    /sv_|token|secret/
  )
  await expect(stat(join(f.root, 'control', 'maintenance.json'))).rejects.toThrow()
  await releaseManagedBackup({ root: f.root, uid })
  await expect(stat(result.staging)).rejects.toThrow()
})

test('a vault that was already stopped is copied but never started by the backup', async () => {
  const f = await fixture({ active: [A] })
  await stageManagedBackup(f.opts)
  expect(f.trace).toEqual([`stop:${A}`, `copy:${A}:quiet`, `copy:${B}:quiet`, `start:${A}`])
})

test('copy failure (including tar exit 1) fails the backup, discards staging and still restarts', async () => {
  const f = await fixture({ failTar: B })
  await expect(stageManagedBackup(f.opts)).rejects.toThrow('operation_failed')
  expect(f.trace.filter((t) => t.startsWith('start:'))).toEqual([`start:${A}`, `start:${B}`])
  await expect(stat(join(f.root, 'backup'))).rejects.toThrow()
  await expect(stat(join(f.root, 'control', 'maintenance.json'))).rejects.toThrow()
})

test('storage verification failure never reads an unmounted/foreign directory', async () => {
  const f = await fixture()
  f.opts.verifyStorage = async () => {
    throw new Error('storage_unavailable')
  }
  await expect(stageManagedBackup(f.opts)).rejects.toThrow('storage_unavailable')
  expect(f.trace.some((t) => t.startsWith('copy:'))).toBe(false)
})

test('insufficient staging space refuses before stopping anything', async () => {
  const f = await fixture()
  await expect(stageManagedBackup({ ...f.opts, freeBytes: async () => 1024 })).rejects.toThrow('storage_unavailable')
  expect(f.trace).toEqual([])
})

test('a crashed stager lease is reconciled under the lock: restarts only what current desired state wants', async () => {
  const f = await fixture({ failStart: true })
  await expect(stageManagedBackup(f.opts)).rejects.toThrow()
  // Restart failed: the lease survives for recovery, recording exactly what was stopped.
  expect(JSON.parse(await readFile(join(f.root, 'control', 'maintenance.json'), 'utf8')).stopped).toEqual([A, B])
  // Meanwhile B was deleted; recovery must not resurrect it.
  const deleted = controlReceiptSchema.parse({
    ...f.records[B],
    phase: 'deleted',
    receipt: { ...f.records[B]!.receipt, state: 'deleted' },
  })
  await writePrivateJson(
    managedPaths({ root: f.root, vaultId: B }).control,
    'receipt.json',
    deleted,
    controlReceiptSchema,
    { uid }
  )
  f.trace.length = 0
  const healthy = await fixture()
  const run = healthy.opts.run
  expect(
    await reconcileMaintenance({
      ...f.opts,
      run: async (argv, o) =>
        argv[1] === 'start' ? (f.trace.push(`start:${argv.at(-1)}`), { code: 0, stdout: '' }) : run(argv, o),
    })
  ).toBe(true)
  expect(f.trace).toEqual([`start:ficus-bigbrain@${A}.service`])
  await expect(stat(join(f.root, 'control', 'maintenance.json'))).rejects.toThrow()
  expect(await reconcileMaintenance(f.opts)).toBe(false)
})

test('a suspended host restarts nothing; an absent installation is a no-op', async () => {
  const f = await fixture()
  const host = await readPrivateJson(f.etc, 'host.json', installedHostSchema, { uid })
  await writePrivateJson(f.etc, 'host.json', { ...host, hostState: 'suspended' }, installedHostSchema, { uid })
  await stageManagedBackup(f.opts)
  expect(f.trace.filter((t) => t.startsWith('start:'))).toEqual([])
  await rm(join(f.etc, 'host.json'))
  expect(await stageManagedBackup(f.opts)).toBeNull()
})

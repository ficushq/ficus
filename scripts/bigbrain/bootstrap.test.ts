import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { initializeStorageNamespace } from './volume-image'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { escrowSchema, initializeVaultOwner, prepareReadCredential } from './bootstrap'
import type { NativeMember } from './native-admin'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const ownerToken = `sv_aaaaaaaa_${'o'.repeat(43)}`
const readToken = `sv_bbbbbbbb_${'r'.repeat(43)}`
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-bootstrap-'))
  roots.push(outer)
  const root = join(outer, 'state')
  await initializeStorageNamespace({ root, uid })
  const base = reservedVaultFixture(root)
  const record: ControlReceipt = {
    ...base,
    phase: 'storage_ready',
    os: { uid: 1200, gid: 1201, imageDevice: 1, imageInode: 2, mountDevice: '7:4' },
  }
  const paths = managedPaths({ root, vaultId: record.receipt.vaultId })
  await ensureOwnedDirectory(paths.control, 0o700, { uid })
  await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
  const owner: NativeMember = {
    id: 'mem_00000001',
    handle: record.owner.handle,
    role: 'owner',
    permissions: ['read', 'write'],
    revoked: null,
  }
  const reader: NativeMember = {
    id: 'mem_00000002',
    handle: 'ficus-reader',
    role: 'member',
    permissions: ['read'],
    revoked: null,
  }
  const calls: string[] = []
  const revoked: string[] = []
  let members: NativeMember[] = []
  let failNext: string | null = null
  const credentials = [
    { id: 'aaaaaaaa', member_id: owner.id, revoked: null },
    { id: 'bbbbbbbb', member_id: reader.id, revoked: null },
  ]
  const step = (name: string) => {
    calls.push(name)
    if (failNext === name) {
      failNext = null
      throw new Error('lost response')
    }
  }
  const admin = {
    async initializeOwner() {
      members = [owner]
      step('init')
      return { member: owner, token: ownerToken, credential: { id: 'aaaaaaaa' } } as never
    },
    async listMembers() {
      calls.push('members')
      return members
    },
    async listCredentials() {
      calls.push('credentials')
      return credentials.filter((c) => members.some((m) => m.id === c.member_id)) as never
    },
    async revokeCredential(id: string) {
      calls.push(`revoke:${id}`)
      revoked.push(id)
    },
    async ensureReadMember() {
      calls.push('reader')
      if (!members.includes(reader)) members = [...members, reader]
      return reader
    },
    async mintReadCredential() {
      step('mint')
      return { token: readToken, credential: { id: 'bbbbbbbb' } } as never
    },
  }
  const options = { root, uid, admin }
  return { record, paths, options, calls, revoked, fail: (name: string) => (failNext = name) }
}

test('owner init and read mint each happen once; exact replay never repeats native side effects', async () => {
  const f = await fixture()
  const initialized = await initializeVaultOwner(f.record, f.options)
  expect(initialized.phase).toBe('initialized')
  expect(await initializeVaultOwner(initialized, f.options)).toEqual(initialized)
  const ready = await prepareReadCredential(initialized, f.options)
  expect(ready.phase).toBe('reader_ready')
  expect(await prepareReadCredential(ready, f.options)).toEqual(ready)
  expect(f.calls.filter((c) => c === 'init' || c === 'mint')).toEqual(['init', 'mint'])
  const escrow = await readPrivateJson(f.paths.control, 'reader.json', escrowSchema, { uid })
  expect(escrow).toMatchObject({ phase: 'complete', credentialId: 'bbbbbbbb', token: readToken })
  // The owner bootstrap secret is root escrow, never placed in Core read material.
  expect(JSON.stringify(escrow)).not.toContain(ownerToken)
})

test('lost init response adopts only the exact sole owner store, revokes the lost owner credential and never re-inits', async () => {
  const f = await fixture()
  f.fail('init')
  await expect(initializeVaultOwner(f.record, f.options)).rejects.toThrow()
  const initialized = await initializeVaultOwner(f.record, f.options)
  expect(initialized.phase).toBe('initialized')
  expect(f.calls.filter((c) => c === 'init')).toHaveLength(1)
  expect(f.revoked).toEqual(['aaaaaaaa'])
  expect(await readPrivateJson(f.paths.control, 'owner.json', escrowSchema, { uid })).toMatchObject({
    phase: 'complete',
    token: null,
    credentialId: null,
  })
})

test('lost mint response revokes the lost reader credential and refuses rather than minting again', async () => {
  const f = await fixture()
  const initialized = await initializeVaultOwner(f.record, f.options)
  f.fail('mint')
  await expect(prepareReadCredential(initialized, f.options)).rejects.toThrow()
  await expect(prepareReadCredential(initialized, f.options)).rejects.toThrow('operation_failed')
  expect(f.calls.filter((c) => c === 'mint')).toHaveLength(1)
  expect(f.revoked).toEqual(['bbbbbbbb'])
})

test('stale receipt, foreign escrow fence and out-of-order phases never invoke native administration', async () => {
  const f = await fixture()
  await expect(
    initializeVaultOwner(
      { ...f.record, displayName: 'Other', receipt: { ...f.record.receipt, displayName: 'Other' } },
      f.options
    )
  ).rejects.toThrow('generation_conflict')
  await expect(prepareReadCredential(f.record, f.options)).rejects.toThrow('generation_conflict')
  await writePrivateJson(
    f.paths.control,
    'owner.json',
    {
      schema: 1,
      tenantId: f.record.receipt.tenantId,
      physicalHostBinding: f.record.receipt.physicalHostBinding,
      vaultId: f.record.receipt.vaultId,
      requestId: '44444444-4444-4444-8444-444444444444',
      phase: 'pending',
      memberId: null,
      credentialId: null,
      token: null,
    },
    escrowSchema,
    { uid }
  )
  await expect(initializeVaultOwner(f.record, f.options)).rejects.toThrow('identity_mismatch')
  expect(f.calls).toEqual([])
})

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { NativeVaultAdmin, type NativeMember } from './native-admin'
import { reservedVaultFixture } from './host-test-fixtures'
import type { PrivateCommandRunner } from './process'
const record = {
  ...reservedVaultFixture('/var/lib/ficus-bigbrain'),
  phase: 'storage_ready' as const,
  os: { uid: 1200, gid: 1201, imageDevice: 2049, imageInode: 123, mountDevice: '7:4' },
}
const token = `sv_12345678_${'a'.repeat(43)}`
const hash = createHash('sha256').update(token).digest('hex')
const member: NativeMember = {
  id: 'mem_abcdef12',
  handle: 'ficus-reader',
  role: 'member',
  permissions: ['read'],
  revoked: null,
}
const minted = {
  token,
  credential: {
    id: '12345678',
    member_id: member.id,
    name: `Ficus read ${record.operation.requestId}`,
    kind: 'agent',
    scopes: ['read'],
    sha256: hash,
    revoked: null,
  },
}
test('admin builds only fixed dropped-privilege CLI verbs; new Ficus member and credential are explicitly read-only agent/nonfollowing', async () => {
  const calls: string[][] = []
  let exists = false
  const run: PrivateCommandRunner = async (args) => {
    calls.push(args)
    if (args.includes('mint')) return { code: 0, stdout: JSON.stringify(minted) }
    if (args.includes('add')) {
      exists = true
      return { code: 0, stdout: JSON.stringify(member) }
    }
    return { code: 0, stdout: JSON.stringify(exists ? [member] : []) }
  }
  const admin = new NativeVaultAdmin(record, { run })
  expect(await admin.ensureReadMember()).toEqual(member)
  expect(await admin.ensureReadMember()).toEqual(member)
  expect(calls.filter((args) => args.includes('add'))).toHaveLength(1)
  expect((await admin.mintReadCredential(member)).credential.followsMember).toBe(false)
  const args = calls.at(-1)!
  expect(args.slice(0, 4)).toEqual(['/usr/bin/setpriv', '--reuid=1200', '--regid=1201', '--clear-groups'])
  expect(args).toContain(record.storage.mount + '/auth/members.json')
  expect(args).toContain('--kind')
  expect(args).toContain('agent')
  expect(args).toContain('--scopes')
  expect(args).toContain('read')
  expect(args).not.toContain('write')
  expect(args).not.toContain('--follow-member')
})
test('overprivileged/revoked/cross-member/dependent or wrong-hash minted output never becomes a read secret', async () => {
  for (const bad of [
    { kind: 'person' },
    { scopes: ['read', 'write'] },
    { followsMember: true },
    { member_id: 'mem_ffffffff' },
    { revoked: '2026-06-01T00:00:00Z' },
    { sha256: 'f'.repeat(64) },
    { minted_by: '99999999' },
  ]) {
    const admin = new NativeVaultAdmin(record, {
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ ...minted, credential: { ...minted.credential, ...bad } }),
      }),
    })
    await expect(admin.mintReadCredential(member)).rejects.toThrow('invalid_response')
  }
  let invoked = false
  const admin = new NativeVaultAdmin(record, {
    run: async () => {
      invoked = true
      throw new Error('PRIVATE')
    },
  })
  await expect(admin.mintReadCredential({ ...member, role: 'owner' })).rejects.toThrow('identity_mismatch')
  expect(invoked).toBe(false)
})
test('bootstrap accepts only the exact requested owner, private person read+write credential and canonical paths; errors never reflect stdout', async () => {
  const paths = { vault: record.storage.mount + '/vault', members: record.storage.mount + '/auth/members.json' }
  const owner = { ...member, handle: record.owner.handle, role: 'owner', permissions: ['read', 'write'] }
  const result = {
    ...paths,
    member: owner,
    token,
    credential: { ...minted.credential, kind: 'person', scopes: ['read', 'write'] },
  }
  const admin = new NativeVaultAdmin(record, { run: async () => ({ code: 0, stdout: JSON.stringify(result) }) })
  expect((await admin.initializeOwner()).member.handle).toBe(record.owner.handle)
  for (const output of [
    { ...result, vault: '/foreign' },
    { ...result, member: { ...owner, handle: 'other' } },
    { ...result, credential: { ...result.credential, kind: 'agent' } },
  ]) {
    const changed = new NativeVaultAdmin(record, { run: async () => ({ code: 0, stdout: JSON.stringify(output) }) })
    await expect(changed.initializeOwner()).rejects.toThrow('invalid_response')
  }
  const failing = new NativeVaultAdmin(record, { run: async () => ({ code: 1, stdout: 'PRIVATE' }) })
  await expect(failing.initializeOwner()).rejects.toThrow('upstream_unavailable')
})

test('revocation accepts only the pinned CLI acknowledgement for the exact credential', async () => {
  const ack = (stdout: unknown) =>
    new NativeVaultAdmin(record, { run: async () => ({ code: 0, stdout: JSON.stringify(stdout) }) })
  await ack({ id: '12345678', revoked: true }).revokeCredential('12345678')
  await expect(ack({ id: '87654321', revoked: true }).revokeCredential('12345678')).rejects.toThrow('invalid_response')
  await expect(ack({ id: '12345678', revoked: false }).revokeCredential('12345678')).rejects.toThrow('invalid_response')
  await expect(ack({ id: '12345678', revoked: true }).revokeCredential('../x')).rejects.toThrow('invalid_request')
})

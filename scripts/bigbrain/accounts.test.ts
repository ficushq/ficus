import { expect, test } from 'bun:test'
import { ensureManagedIdentity, removeManagedIdentity, managedIdentityNames, inspectManagedIdentity } from './accounts'
import type { PrivateCommandRunner } from './process'
const key = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '22222222-2222-4222-8222-222222222222',
  vaultId: '33333333-3333-4333-8333-333333333333',
}
function fixture() {
  const names = managedIdentityNames(key)
  let exists = false
  let group = false
  let processes = false
  let comment = names.comment
  const calls: string[][] = []
  const run: PrivateCommandRunner = async (args) => {
    calls.push(args)
    if (args[0] === '/usr/bin/getent') {
      if (args[1] === 'passwd')
        return exists
          ? { code: 0, stdout: `${names.username}:x:1200:1201:${comment}:/nonexistent:/usr/sbin/nologin\n` }
          : { code: 2, stdout: '' }
      return group ? { code: 0, stdout: `${names.username}:x:1201:\n` } : { code: 2, stdout: '' }
    }
    if (args[0] === '/usr/sbin/useradd') {
      exists = true
      group = true
    }
    if (args[0] === '/usr/sbin/userdel') exists = false
    if (args[0] === '/usr/sbin/groupdel') group = false
    return { code: args[0] === '/usr/bin/pgrep' && !processes ? 1 : 0, stdout: '' }
  }
  return {
    run,
    calls,
    setForeign() {
      comment = 'foreign full vault identity'
    },
    setGroupOnly() {
      group = true
    },
    setProcesses() {
      processes = true
    },
  }
}
test('root creates one nologin/private-group identity and adopts only its full immutable marker on exact retry', async () => {
  const f = fixture()
  expect(await ensureManagedIdentity(key, f.run)).toEqual({ uid: 1200, gid: 1201 })
  expect(await ensureManagedIdentity(key, f.run)).toEqual({ uid: 1200, gid: 1201 })
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
  expect(f.calls.find((c) => c[0] === '/usr/sbin/useradd')).toContain('--no-create-home')
  expect(f.calls.flat()).not.toContain('--remove')
  const useradd = f.calls.find((c) => c[0] === '/usr/sbin/useradd')!
  expect(useradd).toContain('--system')
  expect(useradd).toContain('--no-log-init')
  // Observed on Ubuntu 24.04: `-K CREATE_MAIL_SPOOL=no` exits 3. Never pass -K or -G.
  expect(useradd.some((a) => ['-K', '-G', '--groups', '--key'].includes(a))).toBe(false)
})
test('truncated-name collision, foreign binding marker and unowned group never permit adoption', async () => {
  const f = fixture()
  await ensureManagedIdentity(key, f.run)
  const collision = { ...key, vaultId: key.vaultId.slice(0, -1) + '4' }
  expect(managedIdentityNames(collision).username).toBe(managedIdentityNames(key).username)
  await expect(ensureManagedIdentity(collision, f.run)).rejects.toThrow('identity_mismatch')
  await expect(ensureManagedIdentity({ ...key, physicalHostBinding: key.tenantId }, f.run)).rejects.toThrow(
    'identity_mismatch'
  )
  f.setForeign()
  await expect(ensureManagedIdentity(key, f.run)).rejects.toThrow('identity_mismatch')
  const partial = fixture()
  partial.setGroupOnly()
  await expect(ensureManagedIdentity(key, partial.run)).rejects.toThrow('identity_mismatch')
  expect(partial.calls.some((c) => c[0] === '/usr/sbin/useradd')).toBe(false)
})
test('read-only identity inspection never creates an account during partial-create cleanup', async () => {
  const f = fixture()
  expect(await inspectManagedIdentity(key, f.run)).toBeNull()
  expect(f.calls.some((c) => c[0] === '/usr/sbin/useradd')).toBe(false)
  await ensureManagedIdentity(key, f.run)
  expect(await inspectManagedIdentity(key, f.run)).toEqual({ uid: 1200, gid: 1201 })
})

test('deletion never kills by UID, refuses live/foreign identity, and tolerates repeated exact cleanup', async () => {
  const f = fixture()
  await ensureManagedIdentity(key, f.run)
  f.setProcesses()
  await expect(removeManagedIdentity(key, { uid: 1200, gid: 1201 }, f.run)).rejects.toThrow('busy')
  const clean = fixture()
  await ensureManagedIdentity(key, clean.run)
  await removeManagedIdentity(key, { uid: 1200, gid: 1201 }, clean.run)
  await removeManagedIdentity(key, { uid: 1200, gid: 1201 }, clean.run)
  expect(clean.calls.filter((c) => c[0] === '/usr/sbin/userdel')).toHaveLength(1)
  expect(clean.calls.some((c) => c[0]!.includes('kill'))).toBe(false)
  f.setForeign()
  await expect(removeManagedIdentity(key, { uid: 1200, gid: 1201 }, f.run)).rejects.toThrow('identity_mismatch')
})

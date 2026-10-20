import { managedBigbrainHostBindingSchema } from '@ficus/shared/managed-bigbrain'
import { runPrivateCommand, type PrivateCommandRunner } from './process'
const keySchema = managedBigbrainHostBindingSchema
  .omit({ hostEpoch: true })
  .extend({ vaultId: managedBigbrainHostBindingSchema.shape.tenantId })
  .strict()
export interface ManagedIdentityKey {
  tenantId: string
  physicalHostBinding: string
  vaultId: string
}
export interface ManagedIdentity {
  uid: number
  gid: number
}
export function managedIdentityNames(input: ManagedIdentityKey) {
  const parsed = keySchema.safeParse(input)
  if (!parsed.success) throw new Error('invalid_request')
  const key = parsed.data
  return {
    username: `bbv_${key.vaultId.replaceAll('-', '').slice(0, 24)}`,
    comment: `ficus-bigbrain ${key.tenantId} ${key.physicalHostBinding} ${key.vaultId}`,
  }
}
const numericId = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 0xfffffffe
async function lookup(database: 'passwd' | 'group', key: string, run: PrivateCommandRunner): Promise<string[] | null> {
  const result = await run(['/usr/bin/getent', database, key])
  if (result.code === 2) return null
  if (result.code !== 0) throw new Error('operation_failed')
  const lines = result.stdout.trimEnd().split('\n')
  if (lines.length !== 1) throw new Error('identity_mismatch')
  return lines[0]!.split(':')
}
async function userFor(input: ManagedIdentityKey, run: PrivateCommandRunner): Promise<ManagedIdentity | null> {
  const names = managedIdentityNames(input)
  const fields = await lookup('passwd', names.username, run)
  if (!fields) return null
  if (
    fields.length !== 7 ||
    fields[0] !== names.username ||
    !numericId(fields[2]!) ||
    !numericId(fields[3]!) ||
    fields[4] !== names.comment ||
    fields[5] !== '/nonexistent' ||
    fields[6] !== '/usr/sbin/nologin'
  )
    throw new Error('identity_mismatch')
  const numeric = await lookup('passwd', fields[2]!, run)
  if (JSON.stringify(numeric) !== JSON.stringify(fields)) throw new Error('identity_mismatch')
  return { uid: Number(fields[2]), gid: Number(fields[3]) }
}
async function groupFor(username: string, run: PrivateCommandRunner): Promise<number | null> {
  const fields = await lookup('group', username, run)
  if (!fields) return null
  if (fields.length !== 4 || fields[0] !== username || !numericId(fields[2]!) || fields[3] !== '')
    throw new Error('identity_mismatch')
  const numeric = await lookup('group', fields[2]!, run)
  if (JSON.stringify(numeric) !== JSON.stringify(fields)) throw new Error('identity_mismatch')
  return Number(fields[2])
}
/** Inspection for recovery/delete: absence never causes resource creation. */
export async function inspectManagedIdentity(
  key: ManagedIdentityKey,
  run: PrivateCommandRunner = runPrivateCommand
): Promise<ManagedIdentity | null> {
  const names = managedIdentityNames(key)
  const user = await userFor(key, run)
  const group = await groupFor(names.username, run)
  if (user ? group !== user.gid : group !== null) throw new Error('identity_mismatch')
  return user
}

/** Root controller lock required. Full GECOS marker fences collisions/incarnations; an
 * unknown preexisting account/group is never adopted solely because its short name matches.
 * No home/mail spool/lastlog allocation outside the bounded managed filesystems.
 */
export async function ensureManagedIdentity(
  key: ManagedIdentityKey,
  run: PrivateCommandRunner = runPrivateCommand
): Promise<ManagedIdentity> {
  const names = managedIdentityNames(key)
  let user = await userFor(key, run)
  if (!user) {
    if ((await groupFor(names.username, run)) !== null) throw new Error('identity_mismatch')
    const result = await run([
      '/usr/sbin/useradd',
      '--system',
      '--user-group',
      // No supplementary groups at all (-G is never passed). System accounts get no mail spool;
      // Debian/Ubuntu reject `-K CREATE_MAIL_SPOOL=...` (not a login.defs key) with exit 3.
      '--no-create-home',
      '--no-log-init',
      '--home-dir',
      '/nonexistent',
      '--shell',
      '/usr/sbin/nologin',
      '--comment',
      names.comment,
      '--',
      names.username,
    ])
    if (result.code !== 0) throw new Error('operation_failed')
    user = await userFor(key, run)
    if (!user) throw new Error('operation_failed')
  }
  if ((await groupFor(names.username, run)) !== user.gid) throw new Error('identity_mismatch')
  return user
}
/** Caller first stops/drains the exact recorded unit and removes owned storage. Never
 * kill by UID, remove a home recursively, or remove a reused/unowned identity.
 */
export async function removeManagedIdentity(
  key: ManagedIdentityKey,
  expected: ManagedIdentity,
  run: PrivateCommandRunner = runPrivateCommand
): Promise<void> {
  const names = managedIdentityNames(key)
  if (![expected.uid, expected.gid].every((v) => numericId(String(v)))) throw new Error('invalid_request')
  const user = await userFor(key, run)
  if (user) {
    if (
      user.uid !== expected.uid ||
      user.gid !== expected.gid ||
      (await groupFor(names.username, run)) !== expected.gid
    )
      throw new Error('identity_mismatch')
    const processes = await run(['/usr/bin/pgrep', '-u', String(expected.uid)])
    if (processes.code === 0) throw new Error('busy')
    if (processes.code !== 1) throw new Error('operation_failed')
    if ((await run(['/usr/sbin/userdel', '--', names.username])).code !== 0) throw new Error('operation_failed')
  }
  const group = await groupFor(names.username, run)
  if (group !== null) {
    if (group !== expected.gid) throw new Error('identity_mismatch')
    if ((await run(['/usr/sbin/groupdel', '--', names.username])).code !== 0) throw new Error('operation_failed')
  }
}

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { managedPaths } from './paths'
import { readPrivateJson, writePrivateJson } from './secure-files'
import type { NativeVaultAdmin } from './native-admin'

const uuid = z.uuid().regex(/^[0-9a-f-]{36}$/)
const token = z.string().regex(/^sv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/)
const memberId = z.string().regex(/^mem_[0-9a-f]{8}$/)
const credentialId = z.string().regex(/^[0-9a-f]{8}$/)
const fence = { schema: z.literal(1), tenantId: uuid, physicalHostBinding: uuid, vaultId: uuid, requestId: uuid }
/** Written and fsynced BEFORE the native side effect; `pending` is never permission to repeat it. */
export const escrowSchema = z
  .strictObject({
    ...fence,
    phase: z.enum(['pending', 'complete']),
    memberId: memberId.nullable(),
    credentialId: credentialId.nullable(),
    /** Null after recovery: a lost secret is revoked natively, never re-minted under the same request. */
    token: token.nullable(),
  })
  .refine(
    (v) =>
      (v.phase === 'pending' ? v.token === null : v.memberId !== null) && (v.token === null || v.credentialId !== null)
  )
export type Escrow = z.infer<typeof escrowSchema>
interface Options {
  root?: string
  uid?: number
  admin: Pick<
    NativeVaultAdmin,
    | 'initializeOwner'
    | 'listMembers'
    | 'listCredentials'
    | 'revokeCredential'
    | 'ensureReadMember'
    | 'mintReadCredential'
  >
}

async function present(directory: string, name: string): Promise<boolean> {
  try {
    await lstat(join(directory, name))
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}
async function current(input: ControlReceipt, options: Options) {
  const record = controlReceiptSchema.parse(input)
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: options.root })
  const stored = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, options)
  if (JSON.stringify(stored) !== JSON.stringify(record)) throw new Error('generation_conflict')
  if (record.receipt.state === 'deleted' || !record.os) throw new Error('storage_unavailable')
  const key = {
    schema: 1 as const,
    tenantId: record.receipt.tenantId,
    physicalHostBinding: record.receipt.physicalHostBinding,
    vaultId: record.receipt.vaultId,
    requestId: record.operation.requestId,
  }
  return { record, paths, key }
}
async function readEscrow(directory: string, name: string, key: Record<string, unknown>, options: Options) {
  if (!(await present(directory, name))) return null
  const escrow = await readPrivateJson(directory, name, escrowSchema, options)
  for (const [field, value] of Object.entries(key))
    if (escrow[field as keyof Escrow] !== value) throw new Error('identity_mismatch')
  return escrow
}
async function advance(record: ControlReceipt, phase: ControlReceipt['phase'], directory: string, options: Options) {
  const next = controlReceiptSchema.parse({ ...record, phase })
  await writePrivateJson(directory, 'receipt.json', next, controlReceiptSchema, options)
  return next
}
/** Revoke every live credential of a member except `keep`. Used only when a secret's
 * delivery is uncertain: the lost bearer must not remain valid on the native side.
 */
async function revokeLost(options: Options, member: string, keep: string | null) {
  for (const credential of await options.admin.listCredentials())
    if (credential.member_id === member && !credential.revoked && credential.id !== keep)
      await options.admin.revokeCredential(credential.id)
}

/** Root lifecycle lock + verified live mount required. storage_ready -> initialized exactly once.
 * The owner person credential is root escrow only (the human signs in by owner link); it is
 * never Core material. Recovery from an uncertain init adopts only the exact sole owner store,
 * revokes the lost owner credential(s) and never re-runs init.
 */
export async function initializeVaultOwner(input: ControlReceipt, options: Options): Promise<ControlReceipt> {
  const { record, paths, key } = await current(input, options)
  if (!['storage_ready', 'initialized'].includes(record.phase)) {
    if (['reader_ready', 'service_started', 'ready'].includes(record.phase)) return record
    throw new Error('generation_conflict')
  }
  let escrow = await readEscrow(paths.control, 'owner.json', key, options)
  if (record.phase === 'initialized') {
    if (escrow?.phase !== 'complete') throw new Error('storage_unavailable')
    return record
  }
  if (!escrow) {
    await writePrivateJson(
      paths.control,
      'owner.json',
      { ...key, phase: 'pending', memberId: null, credentialId: null, token: null },
      escrowSchema,
      options
    )
    const result = await options.admin.initializeOwner()
    escrow = {
      ...key,
      phase: 'complete',
      memberId: result.member.id,
      credentialId: result.credential.id,
      token: result.token,
    }
    await writePrivateJson(paths.control, 'owner.json', escrow, escrowSchema, options)
  } else if (escrow.phase === 'pending') {
    const members = await options.admin.listMembers()
    const owner = members[0]
    if (
      members.length !== 1 ||
      !owner ||
      owner.handle !== record.owner.handle ||
      owner.role !== 'owner' ||
      owner.revoked !== null
    )
      throw new Error('identity_mismatch')
    await revokeLost(options, owner.id, null)
    escrow = { ...key, phase: 'complete', memberId: owner.id, credentialId: null, token: null }
    await writePrivateJson(paths.control, 'owner.json', escrow, escrowSchema, options)
  }
  return advance(record, 'initialized', paths.control, options)
}

/** initialized -> reader_ready. Exactly one read-only, agent, nonfollowing Ficus credential per
 * creation request, held in root-private escrow until the service proves its upstream vault
 * identity (handoff publication happens later). An uncertain mint revokes lost reader
 * credentials and refuses: a new credential needs an explicit read-reconnect generation.
 */
export async function prepareReadCredential(input: ControlReceipt, options: Options): Promise<ControlReceipt> {
  const { record, paths, key } = await current(input, options)
  if (['service_started', 'ready'].includes(record.phase)) return record
  if (!['initialized', 'reader_ready'].includes(record.phase)) throw new Error('generation_conflict')
  const escrow = await readEscrow(paths.control, 'reader.json', key, options)
  if (record.phase === 'reader_ready') {
    if (escrow?.phase !== 'complete' || !escrow.token) throw new Error('storage_unavailable')
    return record
  }
  if (escrow?.phase === 'pending') {
    const member = (await options.admin.listMembers()).find((m) => m.handle === 'ficus-reader')
    if (member) await revokeLost(options, member.id, null)
    throw new Error('operation_failed')
  }
  if (!escrow) {
    const member = await options.admin.ensureReadMember()
    await writePrivateJson(
      paths.control,
      'reader.json',
      { ...key, phase: 'pending', memberId: member.id, credentialId: null, token: null },
      escrowSchema,
      options
    )
    const minted = await options.admin.mintReadCredential(member)
    await writePrivateJson(
      paths.control,
      'reader.json',
      { ...key, phase: 'complete', memberId: member.id, credentialId: minted.credential.id, token: minted.token },
      escrowSchema,
      options
    )
  } else if (!escrow.token) throw new Error('storage_unavailable')
  return advance(record, 'reader_ready', paths.control, options)
}

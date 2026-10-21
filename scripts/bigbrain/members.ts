import { z } from 'zod'
import {
  type ManagedBigbrainHostRequest,
  type ManagedBigbrainMember,
  type ManagedBigbrainMemberInviteResult,
  type ManagedBigbrainMemberRoster,
} from '@ficus/shared/managed-bigbrain'
import type { InstalledHost } from './control-input'
import { ensureVaultServed, type LifecycleDeps } from './lifecycle'
import { memberAdminResultSchemas, type MemberAdminInput } from './member-admin'
import { memberAdapter } from './member-adapter'
import { cachedMemberInvite } from './member-invite-cache'
import { managedPaths } from './paths'
import { readVaultRecord } from './provision'
import type { ControlReceipt } from './receipts'

type Request<A extends ManagedBigbrainHostRequest['action']> = Extract<ManagedBigbrainHostRequest, { action: A }>
// Vault identity operations are the lifecycle's (vault-name.ts), never a member request's.
type Op = Exclude<MemberAdminInput['op'], 'vault-identity' | 'vault-name'>
type WithoutPath<T> = T extends unknown ? Omit<T, 'membersPath'> : never
type Results = { [K in Op]: z.infer<(typeof memberAdminResultSchemas)[K]> }

export type MemberDeps = LifecycleDeps

/** A ready vault of this tenant/host, at the request's generation when it names one. */
async function liveVault(
  request: { vaultId: string; tenantId: string; physicalHostBinding: string; expectedGeneration?: number },
  deps: MemberDeps
): Promise<ControlReceipt> {
  const record = await readVaultRecord(request.vaultId, deps)
  if (
    !record ||
    record.receipt.tenantId !== request.tenantId ||
    record.receipt.physicalHostBinding !== request.physicalHostBinding
  )
    throw new Error('not_found')
  if (record.phase !== 'ready' || record.receipt.state !== 'ready') throw new Error('generation_conflict')
  if (request.expectedGeneration !== undefined && record.receipt.generation !== request.expectedGeneration)
    throw new Error('generation_conflict')
  return record
}

async function call<O extends Op>(
  record: ControlReceipt,
  op: O,
  fields: Omit<WithoutPath<Extract<MemberAdminInput, { op: O }>>, 'op'>,
  host: InstalledHost,
  deps: MemberDeps
): Promise<Results[O]> {
  const membersPath = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root }).memberStore
  const raw = await memberAdapter(host, deps)(record, {
    ...fields,
    op,
    membersPath,
  } as MemberAdminInput)
  const parsed = memberAdminResultSchemas[op].safeParse(raw)
  if (!parsed.success) throw new Error('upstream_protocol')
  return parsed.data as Results[O]
}

/** member-list: the vault's live members and pending invites, display fields only. */
export async function listMembers(
  request: Request<'member-list'>,
  host: InstalledHost,
  deps: MemberDeps
): Promise<ManagedBigbrainMemberRoster> {
  return call(await liveVault(request, deps), 'list', {}, host, deps)
}

/** member-invite: one single-use, 24-hour member invitation per request ID. The vault must be
 * served at its origin (like owner-invite); the durable cache returns the same link on retry and
 * never mints a second one. */
export async function inviteMember(
  request: Request<'member-invite'>,
  host: InstalledHost,
  deps: MemberDeps
): Promise<ManagedBigbrainMemberInviteResult> {
  const record = await liveVault(request, deps)
  if (!record.receipt.origin) throw new Error('maintenance')
  await ensureVaultServed(request.vaultId, deps)
  const minted = await cachedMemberInvite({
    vaultId: request.vaultId,
    root: deps.root,
    uid: deps.uid,
    request,
    now: deps.now,
    authorize: async () => void (await liveVault(request, deps)),
    pendingInvites: async () => {
      const roster = await call(record, 'list', {}, host, deps)
      return roster.invitesTruncated ? 'unknown' : new Set(roster.invites.map((invite) => invite.inviteId))
    },
    mint: (issuedAt) =>
      call(record, 'invite', { displayName: request.displayName, access: request.access, issuedAt }, host, deps),
  })
  return {
    inviteId: minted.inviteId,
    inviteUrl: `${record.receipt.origin}/invite#${minted.secret}`,
    displayName: request.displayName,
    access: request.access,
    expiresAt: minted.expiresAt,
  }
}

/** invite-cancel: the invitation can no longer be redeemed. */
export async function cancelInvite(request: Request<'invite-cancel'>, host: InstalledHost, deps: MemberDeps) {
  return call(await liveVault(request, deps), 'cancel', { inviteId: request.inviteId }, host, deps)
}

/** member-set-access: read or read and write, effective on the member's next request. */
export async function setMemberAccess(
  request: Request<'member-set-access'>,
  host: InstalledHost,
  deps: MemberDeps
): Promise<ManagedBigbrainMember> {
  const record = await liveVault(request, deps)
  return call(record, 'set-access', { handle: request.handle, access: request.access }, host, deps)
}

/** member-remove: revokes the member and every credential it holds; its handle stays reserved
 * and everything it wrote stays attributed to it. */
export async function removeMember(
  request: Request<'member-remove'>,
  host: InstalledHost,
  deps: MemberDeps
): Promise<ManagedBigbrainMember> {
  return call(await liveVault(request, deps), 'remove', { handle: request.handle }, host, deps)
}

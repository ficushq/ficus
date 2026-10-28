import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_INVITE_CLOCK_SKEW_MS,
  MANAGED_BIGBRAIN_MAX_LISTED_INVITES,
  MANAGED_BIGBRAIN_MAX_LISTED_MEMBERS,
  MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS,
  MANAGED_BIGBRAIN_READER_HANDLE,
  managedBigbrainDisplayNameSchema,
  managedBigbrainInviteIdSchema,
  managedBigbrainMemberAccessSchema,
  managedBigbrainMemberHandleSchema,
  managedBigbrainMemberIsProtected,
  managedBigbrainMemberRosterSchema,
  managedBigbrainMemberSchema,
  managedBigbrainPendingInviteSchema,
  type ManagedBigbrainMember,
  type ManagedBigbrainMemberRoster,
} from '@ficus/shared/managed-bigbrain'
import { readBoundedControlBytes } from './control-input'

/**
 * Member-management adapter, compiled into `bigbrain-members.js` with the pinned upstream source
 * and run ONLY by the root controller, as the vault's own UID, one bounded JSON request on stdin.
 * It calls exactly these upstream exports (lib/sharedInvites.ts, lib/sharedMembers.ts, and
 * lib/fsx.ts for the vault's server name) and no credential, token or network API. The controller
 * authorizes the request, fences it to the vault's generation and keeps the replay cache; this
 * adapter enforces what Ficus may change.
 */
export interface NativeMemberApi {
  listMembers(store: string): unknown[]
  ownerOf(store: string): unknown
  pendingMemberInvites(store: string, now: Date): unknown[]
  createMemberInvite(store: string, display: string, permission: 'read' | 'write', now: Date): unknown
  cancelMemberInvite(store: string, id: string): boolean
  setMemberPermissions(store: string, handle: string, permissions: readonly string[]): unknown
  revokeMember(store: string, handle: string, now: Date): unknown
  /** Upstream's membership lock contention (lib/sharedMemberLock.ts): answered as `busy`. */
  BusyError: abstract new (...args: never[]) => Error
  /** The vault's `.shared-identity.json`, created by upstream with its own random id (and the
   * default name) when absent (lib/sharedInvites.ts). */
  sharedVaultIdentity(root: string): unknown
  /** Upstream's atomic replace (lib/fsx.ts): temp file in the same directory, then rename. */
  writeAtomic(path: string, content: string, mode: number): void
}

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsolute(v) && resolve(v) === v && !/\p{Cc}/u.test(v))
const membersPath = absolutePath
/** The vault directory served by upstream (`--vault`), holding `.shared-identity.json`. */
const vaultPath = absolutePath
const displayName = managedBigbrainPendingInviteSchema.shape.displayName
const handle = managedBigbrainMemberHandleSchema
const access = managedBigbrainMemberAccessSchema
export const memberAdminInputSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), membersPath }).strict(),
  z
    .object({ op: z.literal('invite'), membersPath, displayName, access, issuedAt: z.string().datetime().max(40) })
    .strict(),
  z.object({ op: z.literal('cancel'), membersPath, inviteId: managedBigbrainInviteIdSchema }).strict(),
  z.object({ op: z.literal('set-access'), membersPath, handle, access }).strict(),
  z.object({ op: z.literal('remove'), membersPath, handle }).strict(),
  z.object({ op: z.literal('vault-identity'), vaultPath }).strict(),
  z.object({ op: z.literal('vault-name'), vaultPath, name: managedBigbrainDisplayNameSchema }).strict(),
])
export type MemberAdminInput = z.infer<typeof memberAdminInputSchema>

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** The one secret-bearing result: the controller turns it into the link and never logs it. */
export const memberInviteMintSchema = z
  .object({ inviteId: managedBigbrainInviteIdSchema, secret, expiresAt: z.string().datetime().max(40) })
  .strict()
/** The vault's upstream identity: its id (never changed by Ficus) and its server name, null when
 * the file has none. */
export const vaultIdentityResultSchema = z
  .object({ upstreamVaultId: z.string().uuid(), name: z.string().max(4096).nullable() })
  .strict()
export const memberAdminResultSchemas = {
  list: managedBigbrainMemberRosterSchema,
  invite: memberInviteMintSchema,
  cancel: z.object({ inviteId: managedBigbrainInviteIdSchema }).strict(),
  'set-access': managedBigbrainMemberSchema,
  remove: managedBigbrainMemberSchema,
  'vault-identity': vaultIdentityResultSchema,
  'vault-name': vaultIdentityResultSchema.extend({ changed: z.boolean() }).strict(),
} as const
/** Codes the adapter may answer with; anything else is the controller's `upstream_protocol`. */
export const MEMBER_ADMIN_CODES = [
  'invalid_request',
  'not_found',
  'forbidden',
  'busy',
  'upstream_protocol',
  'operation_failed',
] as const
export const memberAdminReplySchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(MEMBER_ADMIN_CODES) }).strict(),
])

// What the pinned store records; only the fields below ever leave this process.
const nativeMember = z.object({
  handle,
  display: z.string().max(4096),
  role: z.enum(['owner', 'member']),
  permissions: z.array(z.string().max(16)).max(8),
  created: z.string().max(64).optional(),
  revoked: z.string().max(64).nullable().optional(),
  pending: z.boolean().optional(),
})
const nativeInvite = z.object({
  id: z.string(),
  display: z.string().max(4096),
  permission: z.string(),
  expires: z.string().max(64),
})

/** One line, no control characters, at most 120 UTF-16 units; the handle when nothing is left.
 * Upstream display names are one line already, but an email placeholder can be longer. */
function shown(value: string, fallback: string): string {
  const units: string[] = []
  let length = 0
  for (const char of value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()) {
    if (length + char.length > 120) break
    units.push(char)
    length += char.length
  }
  return units.join('').trim() || fallback
}
function isoOrNull(value: string | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}
function view(raw: unknown): ManagedBigbrainMember & { revoked: boolean } {
  const parsed = nativeMember.safeParse(raw)
  if (!parsed.success) throw new Error('upstream_protocol')
  const m = parsed.data
  const member = {
    handle: m.handle,
    displayName: shown(m.display, m.handle),
    role: m.role,
    access: m.permissions.includes('write')
      ? ('write' as const)
      : m.permissions.includes('read')
        ? ('read' as const)
        : ('none' as const),
    status: m.revoked ? ('removed' as const) : m.pending ? ('pending' as const) : ('active' as const),
    createdAt: isoOrNull(m.created),
  }
  const checked = managedBigbrainMemberSchema.safeParse(member)
  if (!checked.success) throw new Error('upstream_protocol')
  return { ...checked.data, revoked: Boolean(m.revoked) }
}
const strip = ({ revoked: _revoked, ...member }: ManagedBigbrainMember & { revoked: boolean }) => member
/** Owner first, then the Ficus reader, then everyone else oldest first. */
function rank(member: ManagedBigbrainMember): string {
  const first = member.role === 'owner' ? '0' : member.handle === MANAGED_BIGBRAIN_READER_HANDLE ? '1' : '2'
  return `${first}${member.createdAt ?? '9'}${member.handle}`
}

function roster(store: string, api: NativeMemberApi, now: Date): ManagedBigbrainMemberRoster {
  const members = api
    .listMembers(store)
    .map(view)
    .filter((m) => !m.revoked)
    .map(strip)
    .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
  const invites = api
    .pendingMemberInvites(store, now)
    .map((raw) => {
      // The pending list upstream includes each invitation's secret: it is dropped here.
      const parsed = nativeInvite.safeParse(raw)
      if (!parsed.success) throw new Error('upstream_protocol')
      const invite = parsed.data
      const checked = managedBigbrainPendingInviteSchema.safeParse({
        inviteId: invite.id,
        displayName: shown(invite.display, 'Invited member'),
        access: invite.permission,
        expiresAt: isoOrNull(invite.expires),
      })
      if (!checked.success) throw new Error('upstream_protocol')
      return checked.data
    })
    .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0))
  return managedBigbrainMemberRosterSchema.parse({
    members: members.slice(0, MANAGED_BIGBRAIN_MAX_LISTED_MEMBERS),
    invites: invites.slice(0, MANAGED_BIGBRAIN_MAX_LISTED_INVITES),
    membersTruncated: members.length > MANAGED_BIGBRAIN_MAX_LISTED_MEMBERS,
    invitesTruncated: invites.length > MANAGED_BIGBRAIN_MAX_LISTED_INVITES,
  })
}

/** The member Ficus may change: present, not removed, not the owner and not a protected handle. */
function changeable(store: string, target: string, api: NativeMemberApi) {
  const member = api
    .listMembers(store)
    .map(view)
    .find((m) => m.handle === target)
  if (!member) throw new Error('not_found')
  const owner = nativeMember.safeParse(api.ownerOf(store))
  if (
    member.role !== 'member' ||
    managedBigbrainMemberIsProtected(member.handle) ||
    (owner.success && owner.data.handle === member.handle)
  )
    throw new Error('forbidden')
  return member
}

// What upstream keeps in `.shared-identity.json`; every other field is preserved as it is.
const upstreamIdentity = z.object({ id: z.string().uuid(), name: z.unknown().optional() }).passthrough()
function vaultIdentity(root: string, api: NativeMemberApi) {
  const parsed = upstreamIdentity.safeParse(api.sharedVaultIdentity(root))
  if (!parsed.success) throw new Error('upstream_protocol')
  return parsed.data
}
const identityView = (identity: z.infer<typeof upstreamIdentity>) => ({
  upstreamVaultId: identity.id,
  name: typeof identity.name === 'string' ? identity.name.slice(0, 4096) : null,
})

/** Set the vault's server name (what the BigBrain app shows) the way upstream's deploy guide
 * says: edit `name` in `.shared-identity.json` and keep everything else, above all the id.
 * Upstream creates the file (and its random id) when it is absent, exactly as on first serve.
 * Idempotent: an equal name is not rewritten. */
function setVaultName(root: string, name: string, api: NativeMemberApi) {
  const before = vaultIdentity(root, api)
  if (before.name === name) return { ...identityView(before), changed: false }
  api.writeAtomic(join(root, '.shared-identity.json'), JSON.stringify({ ...before, name }), 0o600)
  const after = vaultIdentity(root, api)
  if (after.id !== before.id || after.name !== name) throw new Error('upstream_protocol')
  return { ...identityView(after), changed: true }
}

export function runMemberAdmin(input: unknown, api: NativeMemberApi, now = Date.now()) {
  const parsed = memberAdminInputSchema.safeParse(input)
  if (!parsed.success) throw new Error('invalid_request')
  const request = parsed.data
  if (request.op === 'vault-identity') return identityView(vaultIdentity(request.vaultPath, api))
  if (request.op === 'vault-name') return setVaultName(request.vaultPath, request.name, api)
  const store = request.membersPath
  switch (request.op) {
    case 'list':
      return roster(store, api, new Date(now))
    case 'invite': {
      // The controller's issuance time, taken just before: never a future or stale mint.
      const issued = Date.parse(request.issuedAt)
      if (Math.abs(now - issued) > MANAGED_BIGBRAIN_INVITE_CLOCK_SKEW_MS) throw new Error('invalid_request')
      const created = z
        .object({
          id: z.string(),
          secret: z.string(),
          display: z.string(),
          permission: z.string(),
          expires: z.string(),
        })
        .safeParse(api.createMemberInvite(store, request.displayName, request.access, new Date(issued)))
      if (
        !created.success ||
        !managedBigbrainInviteIdSchema.safeParse(created.data.id).success ||
        !secret.safeParse(created.data.secret).success ||
        created.data.display !== request.displayName ||
        created.data.permission !== request.access ||
        Date.parse(created.data.expires) !== issued + MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS
      )
        throw new Error('upstream_protocol')
      return { inviteId: created.data.id, secret: created.data.secret, expiresAt: created.data.expires }
    }
    case 'cancel':
      // Upstream answers false for an unknown or already accepted invitation.
      if (!api.cancelMemberInvite(store, request.inviteId)) throw new Error('not_found')
      return { inviteId: request.inviteId }
    case 'set-access': {
      const member = changeable(store, request.handle, api)
      if (member.revoked) throw new Error('not_found')
      const updated = view(
        api.setMemberPermissions(store, member.handle, request.access === 'write' ? ['read', 'write'] : ['read'])
      )
      if (updated.handle !== member.handle || updated.access !== request.access) throw new Error('upstream_protocol')
      return strip(updated)
    }
    case 'remove': {
      // Removal revokes the member and every credential it holds; the handle stays reserved.
      const member = changeable(store, request.handle, api)
      const removed = view(api.revokeMember(store, member.handle, new Date(now)))
      if (removed.handle !== member.handle || removed.status !== 'removed') throw new Error('upstream_protocol')
      return strip(removed)
    }
  }
}

function failureCode(error: unknown, api: NativeMemberApi): (typeof MEMBER_ADMIN_CODES)[number] {
  if (error instanceof api.BusyError) return 'busy'
  const message = error instanceof Error ? error.message : ''
  return (MEMBER_ADMIN_CODES as readonly string[]).includes(message)
    ? (message as (typeof MEMBER_ADMIN_CODES)[number])
    : 'operation_failed'
}

/** The adapter's one reply line: `{ok:true,result}` or `{ok:false,code}` with a fixed code, never
 * upstream text. */
export function memberAdminReply(input: unknown, api: NativeMemberApi, now = Date.now()) {
  try {
    return { ok: true as const, result: runMemberAdmin(input, api, now) }
  } catch (error) {
    return { ok: false as const, code: failureCode(error, api) }
  }
}

/** Compiled entrypoint (generated by the fixed-pin artifact builder). */
export async function memberAdminMain(api: NativeMemberApi): Promise<void> {
  let reply: z.infer<typeof memberAdminReplySchema>
  try {
    if (process.argv.length !== 2) throw new Error('invalid_request')
    const bytes = await readBoundedControlBytes(Bun.stdin.stream())
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('invalid_request')
    }
    reply = memberAdminReply(input, api)
  } catch (error) {
    reply = { ok: false, code: failureCode(error, api) }
  }
  console.log(JSON.stringify(reply))
}

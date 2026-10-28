import { z } from 'zod'

/** Wire contract only. Passing validation is not authorization or proof of host installation. */
export const MANAGED_BIGBRAIN_CONTRACT_VERSION = 1 as const
export const MANAGED_BIGBRAIN_UPSTREAM_COMMIT = 'cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed' as const
export const MANAGED_BIGBRAIN_SHARED_PROTOCOL = 1 as const
export const MANAGED_BIGBRAIN_MCP_PROTOCOL = '2025-06-18' as const
export const MANAGED_BIGBRAIN_HELPER = '/usr/local/libexec/ficus-bigbrainctl' as const
export const MANAGED_BIGBRAIN_SCOPES = ['managed-bigbrain:read', 'managed-bigbrain:manage'] as const
export type ManagedBigbrainScope = (typeof MANAGED_BIGBRAIN_SCOPES)[number]
export const MANAGED_BIGBRAIN_HOST_REQUEST_BYTES = 8192
/** Sized for the largest reply, a bounded member roster (see MANAGED_BIGBRAIN_MAX_LISTED_*). Older
 * hosts cap their own replies lower and never send the member actions. */
export const MANAGED_BIGBRAIN_HOST_REPLY_BYTES = 131072
export const MANAGED_BIGBRAIN_MAX_VAULTS = 2
/** Matches the pinned native createAppLink API; never a public request-controlled TTL. */
export const MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS = 60 * 60 * 1000
export const MANAGED_BIGBRAIN_INVITE_CLOCK_SKEW_MS = 30_000
export const MANAGED_BIGBRAIN_MAX_ACTIVE_INVITES = 64
/** Matches the pinned native createMemberInvite (single use, 24 hours); never request-controlled. */
export const MANAGED_BIGBRAIN_MEMBER_INVITE_TTL_MS = 24 * 60 * 60 * 1000
/** Live member invites Ficus tracks per vault for replay (each one also stays cancellable). */
export const MANAGED_BIGBRAIN_MAX_MEMBER_INVITES = 32
/** Roster bounds: a longer roster is truncated (flagged), never an oversized reply. */
export const MANAGED_BIGBRAIN_MAX_LISTED_MEMBERS = 100
export const MANAGED_BIGBRAIN_MAX_LISTED_INVITES = 50
/** The vault's read-only Ficus member: shown, never changed or removed through Ficus. */
export const MANAGED_BIGBRAIN_READER_HANDLE = 'ficus-reader' as const

export const MANAGED_BIGBRAIN_ERROR_CODES = [
  'unsupported_host',
  'not_installed',
  'capability_stale',
  'backup_unavailable',
  'tls_unavailable',
  'dns_unavailable',
  'capacity',
  'busy',
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'generation_conflict',
  'request_conflict',
  'identity_mismatch',
  'pin_mismatch',
  'scope_mismatch',
  'read_access_revoked',
  'invite_expired',
  'host_unreachable',
  'output_limit',
  'resource_limit',
  'storage_unavailable',
  'maintenance',
  'upstream_unavailable',
  'upstream_protocol',
  'invalid_response',
  'operation_failed',
] as const
export const managedBigbrainErrorCodeSchema = z.enum(MANAGED_BIGBRAIN_ERROR_CODES)
export type ManagedBigbrainErrorCode = z.infer<typeof managedBigbrainErrorCodeSchema>

const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]{36}$/)
const uint = z.number().int().safe().nonnegative()
const positive = uint.min(1)
const version = z.literal(MANAGED_BIGBRAIN_CONTRACT_VERSION)
const pin = z.literal(MANAGED_BIGBRAIN_UPSTREAM_COMMIT)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const datetime = z.string().datetime().max(40)
const label = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v))
/** Vault and member display names: one trimmed line of 1-120 characters, no control characters.
 * A vault's name is also written as its upstream server name (what the BigBrain app shows). */
export const managedBigbrainDisplayNameSchema = label
const zonePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const zoneSchema = z.string().max(210).regex(zonePattern)

/** Longest tenant label (a Platform tenant subdomain). */
export const MANAGED_BIGBRAIN_TENANT_LABEL_MAX = 56
/** Hex characters of the vault UUID in a tenant-prefixed hostname. */
export const MANAGED_BIGBRAIN_SHORT_ID_LENGTH = 12
const DNS_LABEL_MAX = 63
const ORIGIN_MAX = 253
const FALLBACK_LABEL = /^bb-([0-9a-f]{32})$/
const PREFIXED_LABEL = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-bb-([0-9a-f]{12})$/
/** Tenant subdomains in the vault hostname namespace: Platform must never issue one. A tenant
 * named like this could shadow (or be shadowed by) a vault hostname in the shared zone. */
export function managedBigbrainReservesLabel(label: string): boolean {
  return label.startsWith('bb-') || /-bb-[0-9a-f]{12}$/.test(label)
}
/** The tenant's Platform subdomain: a single DNS label outside the reserved vault namespace. */
export const managedBigbrainTenantLabelSchema = z
  .string()
  .max(MANAGED_BIGBRAIN_TENANT_LABEL_MAX)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .refine((v) => !managedBigbrainReservesLabel(v))
const tenantLabelSchema = managedBigbrainTenantLabelSchema

export interface ManagedBigbrainOriginParts {
  hostname: string
  zone: string
  /** Null for the fallback `bb-<32 hex>` form. */
  tenantLabel: string | null
  /** 32 hex characters (fallback) or the 12-hex short id (tenant-prefixed). */
  vaultKey: string
}
/** Syntax only: an exact `https://<host>` serialization in one of the two vault forms. It binds
 * no vault, tenant or zone; use the policy/vault checks for that. */
export function parseManagedBigbrainOrigin(origin: string): ManagedBigbrainOriginParts | null {
  if (typeof origin !== 'string' || origin.length > ORIGIN_MAX || !origin.startsWith('https://')) return null
  // Exact serialization rejects credentials, ports (including :443), paths, queries and fragments.
  const hostname = origin.slice('https://'.length)
  const dot = hostname.indexOf('.')
  if (dot < 0) return null
  const first = hostname.slice(0, dot)
  const zone = hostname.slice(dot + 1)
  if (first.length > DNS_LABEL_MAX || !zoneSchema.safeParse(zone).success) return null
  const fallback = FALLBACK_LABEL.exec(first)
  if (fallback) return { hostname, zone, tenantLabel: null, vaultKey: fallback[1]! }
  const prefixed = PREFIXED_LABEL.exec(first)
  if (!prefixed || !tenantLabelSchema.safeParse(prefixed[1]).success) return null
  return { hostname, zone, tenantLabel: prefixed[1]!, vaultKey: prefixed[2]! }
}
const originSchema = z
  .string()
  .max(ORIGIN_MAX)
  .refine((value) => parseManagedBigbrainOrigin(value) !== null)
const readAccess = z.enum(['pending', 'active', 'revoked'])
export const managedBigbrainStateSchema = z.enum([
  'requested',
  'provisioning',
  'ready',
  'degraded',
  'failed',
  'deleting',
  'deleted',
])
export type ManagedBigbrainState = z.infer<typeof managedBigbrainStateSchema>
export const managedBigbrainHostStateSchema = z.enum(['active', 'suspended', 'terminated', 'deleted'])
export type ManagedBigbrainHostState = z.infer<typeof managedBigbrainHostStateSchema>
export const managedBigbrainOwnerSchema = z
  .object({
    userId: uuid,
    handle: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      .refine((v) => v !== 'ficus-reader'),
    display: label,
  })
  .strict()
export type ManagedBigbrainOwner = z.infer<typeof managedBigbrainOwnerSchema>

/**
 * The upstream owner of every vault Core creates. Shared vaults belong to the Ficus instance, not
 * a person: BigBrain still needs one owner member, so it is `ficus`. `userId` is an opaque anchor
 * the host helper records at create and matches on owner-invite (never a Ficus user); vaults
 * created before this rule keep their creator's ID as their anchor.
 */
export const MANAGED_BIGBRAIN_FICUS_OWNER: ManagedBigbrainOwner = Object.freeze({
  userId: '00000000-0000-4000-8000-00000000f1c5',
  handle: 'ficus',
  display: 'Ficus',
})

/** Operator ceilings: API callers may not choose/expand these budgets. */
export const managedBigbrainLimitsSchema = z
  .object({
    maxVaults: positive.max(MANAGED_BIGBRAIN_MAX_VAULTS),
    perVaultDiskBytes: positive.max(512 * 1024 * 1024),
    perVaultMemoryBytes: positive.max(256 * 1024 * 1024),
    aggregateMemoryBytes: positive.max(640 * 1024 * 1024),
    aggregateCpuPercent: positive.max(50),
    minCoreFreeDiskBytes: positive,
    perVaultRequests: positive.max(2),
    aggregateRequests: positive.max(4),
    requestBytes: positive.max(1024 * 1024 + 64 * 1024),
    nativeResponseBytes: positive.max(16 * 1024 * 1024),
    toolResponseBytes: positive.max(512 * 1024),
    requestTimeoutMs: positive.max(15000),
  })
  .strict()
export type ManagedBigbrainLimits = z.infer<typeof managedBigbrainLimitsSchema>
/** The one admission policy: the host installer records it and Platform sends it on create. */
export const MANAGED_BIGBRAIN_DEFAULT_LIMITS: Readonly<ManagedBigbrainLimits> = Object.freeze({
  maxVaults: MANAGED_BIGBRAIN_MAX_VAULTS,
  perVaultDiskBytes: 512 * 1024 * 1024,
  perVaultMemoryBytes: 256 * 1024 * 1024,
  aggregateMemoryBytes: 640 * 1024 * 1024,
  aggregateCpuPercent: 50,
  minCoreFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  perVaultRequests: 2,
  aggregateRequests: 4,
  requestBytes: 1024 * 1024 + 64 * 1024,
  nativeResponseBytes: 16 * 1024 * 1024,
  toolResponseBytes: 512 * 1024,
  requestTimeoutMs: 15000,
})
/** Setup-toolkit `bigbrain:` section (YAML snake_case keys enabled/tenant_id/physical_host_binding/
 * host_epoch/zone, passed to the installer as this camelCase JSON). Default off. Identity is
 * Platform-generated and persisted before install; hostEpoch only seeds an ABSENT host record.
 * No paths, limits or artifact choices are configurable.
 */
export const managedBigbrainHostConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      tenantId: uuid,
      physicalHostBinding: uuid,
      hostEpoch: uint,
      zone: zoneSchema,
      /** The tenant's Platform subdomain for new vault hostnames; absent means the fallback form. */
      tenantLabel: tenantLabelSchema.optional(),
    })
    .strict(),
])
export type ManagedBigbrainHostConfig = z.infer<typeof managedBigbrainHostConfigSchema>

/** Root-owned installed host record. Core reads it for the helper envelope; root writes it. */
export const MANAGED_BIGBRAIN_HOST_RECORD = '/etc/ficus/bigbrain/host.json' as const
export const managedBigbrainInstalledHostSchema = z
  .object({
    tenantId: uuid,
    physicalHostBinding: uuid,
    hostEpoch: uint,
    contractVersion: version,
    hostState: managedBigbrainHostStateSchema,
    upstreamCommit: pin,
    artifactDigest: digest,
    zone: zoneSchema,
    /** Platform-written tenant label used for NEW vault hostnames only; null = fallback form. */
    tenantLabel: tenantLabelSchema.nullable().default(null),
    limits: managedBigbrainLimitsSchema,
    effect: z
      .object({
        action: z.enum(['suspend-tenant', 'resume-tenant', 'destroy-tenant', 'restore-fence']),
        effectId: uuid,
        previousHostEpoch: uint,
        completed: z.boolean(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
export type ManagedBigbrainInstalledHost = z.infer<typeof managedBigbrainInstalledHostSchema>

export const managedBigbrainCapabilitiesSchema = z
  .object({
    contractVersion: version,
    tenantId: uuid,
    // Null means no install incarnation exists. It is never admissible as a host fence.
    physicalHostBinding: uuid.nullable(),
    available: z.boolean(),
    reasonCode: managedBigbrainErrorCodeSchema.nullable(),
    installed: z.boolean(),
    upstreamCommit: pin,
    artifactDigest: digest.nullable(),
    sharedProtocol: z.literal(MANAGED_BIGBRAIN_SHARED_PROTOCOL),
    hostEpoch: uint,
    hostState: managedBigbrainHostStateSchema,
    /** Installed DNS zone for vault hostnames; non-null exactly when installed. */
    zone: zoneSchema.nullable(),
    /** Installed tenant label for new vault hostnames; null = fallback form or not installed. */
    tenantLabel: tenantLabelSchema.nullable().default(null),
    limits: managedBigbrainLimitsSchema,
    observedAt: datetime,
  })
  .strict()
  .refine((v) => (v.zone !== null) === v.installed)
  .refine((v) => v.installed || v.tenantLabel === null)
  .refine((v) =>
    v.available
      ? v.installed &&
        v.physicalHostBinding !== null &&
        v.artifactDigest !== null &&
        v.reasonCode === null &&
        v.hostState === 'active'
      : v.reasonCode !== null
  )
export type ManagedBigbrainCapabilities = z.infer<typeof managedBigbrainCapabilitiesSchema>

const inviteWindowFields = { issuedAt: datetime, expiresAt: datetime }
export const managedBigbrainInviteWindowSchema = z
  .object(inviteWindowFields)
  .strict()
  .refine((v) => Date.parse(v.expiresAt) - Date.parse(v.issuedAt) === MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS)
/** A tolerated future ledger timestamp is RETRYABLE, never passed to the native issuer as now.
 * Expiry has no grace period. Bounded skew does not extend native validity or permit future minting.
 */
export function managedBigbrainInviteWindowStatus(
  window: unknown,
  now: number
): 'current' | 'not_yet_valid' | 'expired' | 'invalid' {
  const parsed = managedBigbrainInviteWindowSchema.safeParse(window)
  if (!parsed.success || !Number.isFinite(now)) return 'invalid'
  const issuedAt = Date.parse(parsed.data.issuedAt)
  if (issuedAt > now) return issuedAt - now <= MANAGED_BIGBRAIN_INVITE_CLOCK_SKEW_MS ? 'not_yet_valid' : 'invalid'
  return Date.parse(parsed.data.expiresAt) <= now ? 'expired' : 'current'
}

/** Secret-bearing exception: never pass through generic DTO logging, caching or audit. */
export const managedBigbrainOwnerInviteResultSchema = z
  .object({
    inviteUrl: z
      .string()
      .max(304)
      .refine((value) => {
        const [base, fragment, ...rest] = value.split('#')
        return (
          rest.length === 0 &&
          base?.endsWith('/invite') &&
          originSchema.safeParse(base.slice(0, -7)).success &&
          /^[A-Za-z0-9_-]{43}$/.test(fragment ?? '')
        )
      }),
    expiresAt: datetime,
  })
  .strict()
export type ManagedBigbrainOwnerInviteResult = z.infer<typeof managedBigbrainOwnerInviteResultSchema>

/** Upstream member handle (`HANDLE_RE`): immutable, never reused, the author ID in the record. */
export const managedBigbrainMemberHandleSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
/** Upstream member invitation ID (12 random bytes, hex); its member's handle is `invite-<id>`. */
export const managedBigbrainInviteIdSchema = z.string().regex(/^[0-9a-f]{24}$/)
/** What Ficus may set: `read`, or `write` (upstream read + write). Never owner. */
export const managedBigbrainMemberAccessSchema = z.enum(['read', 'write'])
export type ManagedBigbrainMemberAccess = z.infer<typeof managedBigbrainMemberAccessSchema>
/** Handles Ficus never changes or removes, whatever a request says: the instance owner and the
 * Ficus reader. The host additionally refuses every member whose upstream role is owner. */
export function managedBigbrainMemberIsProtected(handle: string): boolean {
  return handle === MANAGED_BIGBRAIN_FICUS_OWNER.handle || handle === MANAGED_BIGBRAIN_READER_HANDLE
}
/** One roster entry: display fields only. Never emails, identities, credentials or tokens. */
export const managedBigbrainMemberSchema = z
  .object({
    handle: managedBigbrainMemberHandleSchema,
    displayName: label,
    role: z.enum(['owner', 'member']),
    access: z.enum(['read', 'write', 'none']),
    /** `pending`: added by email in the BigBrain app and not signed in yet. */
    status: z.enum(['active', 'pending', 'removed']),
    createdAt: datetime.nullable(),
  })
  .strict()
export type ManagedBigbrainMember = z.infer<typeof managedBigbrainMemberSchema>
/** A pending member invitation, without its secret. */
export const managedBigbrainPendingInviteSchema = z
  .object({
    inviteId: managedBigbrainInviteIdSchema,
    displayName: label,
    access: managedBigbrainMemberAccessSchema,
    expiresAt: datetime,
  })
  .strict()
export type ManagedBigbrainPendingInvite = z.infer<typeof managedBigbrainPendingInviteSchema>
export const managedBigbrainMemberRosterSchema = z
  .object({
    members: z.array(managedBigbrainMemberSchema).max(MANAGED_BIGBRAIN_MAX_LISTED_MEMBERS),
    invites: z.array(managedBigbrainPendingInviteSchema).max(MANAGED_BIGBRAIN_MAX_LISTED_INVITES),
    membersTruncated: z.boolean(),
    invitesTruncated: z.boolean(),
  })
  .strict()
  .refine((v) => new Set(v.members.map((m) => m.handle)).size === v.members.length)
  .refine((v) => new Set(v.invites.map((i) => i.inviteId)).size === v.invites.length)
export type ManagedBigbrainMemberRoster = z.infer<typeof managedBigbrainMemberRosterSchema>
/** Secret-bearing exception like the owner link: returned once, never stored, cached or logged. */
export const managedBigbrainMemberInviteResultSchema = managedBigbrainPendingInviteSchema
  .extend({ inviteUrl: managedBigbrainOwnerInviteResultSchema.shape.inviteUrl })
  .strict()
export type ManagedBigbrainMemberInviteResult = z.infer<typeof managedBigbrainMemberInviteResultSchema>
/** A binding is an identity fence, not authentication. Never derive authority from a probe/archive. */
export const managedBigbrainHostBindingSchema = z
  .object({ tenantId: uuid, physicalHostBinding: uuid, hostEpoch: uint })
  .strict()
export type ManagedBigbrainHostBinding = z.infer<typeof managedBigbrainHostBindingSchema>
export const managedBigbrainHostEnvelopeSchema = managedBigbrainHostBindingSchema
  .extend({ contractVersion: version, requestId: uuid })
  .strict()
export type ManagedBigbrainHostEnvelope = z.infer<typeof managedBigbrainHostEnvelopeSchema>
export const managedBigbrainHostVaultFenceSchema = z
  .object({ vaultId: uuid, expectedGeneration: uint, generation: positive })
  .strict()
  .refine((v) => v.generation > v.expectedGeneration)
export type ManagedBigbrainHostVaultFence = z.infer<typeof managedBigbrainHostVaultFenceSchema>
const vaultFenceFields = { vaultId: uuid, expectedGeneration: uint, generation: positive }
const memberFenceFields = { vaultId: uuid, expectedGeneration: positive }
export const managedBigbrainArchiveInventorySchema = z
  .object({
    tenantId: uuid,
    sourcePhysicalHostBinding: uuid,
    manifestDigest: digest,
    vaults: z
      .array(z.object({ vaultId: uuid, upstreamVaultId: uuid, generation: positive }).strict())
      .max(MANAGED_BIGBRAIN_MAX_VAULTS),
  })
  .strict()
  .refine((v) => uniqueVaultIds(v.vaults))
export type ManagedBigbrainArchiveInventory = z.infer<typeof managedBigbrainArchiveInventorySchema>
const hostAction = <A extends string, S extends z.ZodRawShape>(action: A, fields: S) =>
  managedBigbrainHostEnvelopeSchema.extend({ action: z.literal(action), ...fields }).strict()
export const managedBigbrainHostRequestSchema = z
  .discriminatedUnion('action', [
    hostAction('probe', {}),
    hostAction('status', { vaultId: uuid }),
    hostAction('create', {
      ...vaultFenceFields,
      displayName: label,
      owner: managedBigbrainOwnerSchema,
      origin: originSchema,
      limits: managedBigbrainLimitsSchema,
      upstreamCommit: pin,
      artifactDigest: digest,
    }),
    hostAction('rename', { ...vaultFenceFields, displayName: label }),
    hostAction('owner-invite', {
      vaultId: uuid,
      expectedGeneration: positive,
      actorUserId: uuid,
      ...inviteWindowFields,
    }),
    // Member management: no generation advance (Ficus vault state is unchanged), but each one is
    // fenced to the vault's current generation like owner-invite.
    hostAction('member-list', { vaultId: uuid }),
    hostAction('member-invite', {
      ...memberFenceFields,
      displayName: label,
      access: managedBigbrainMemberAccessSchema,
    }),
    hostAction('invite-cancel', { ...memberFenceFields, inviteId: managedBigbrainInviteIdSchema }),
    hostAction('member-set-access', {
      ...memberFenceFields,
      handle: managedBigbrainMemberHandleSchema,
      access: managedBigbrainMemberAccessSchema,
    }),
    hostAction('member-remove', { ...memberFenceFields, handle: managedBigbrainMemberHandleSchema }),
    hostAction('read-revoke', vaultFenceFields),
    hostAction('read-reconnect', vaultFenceFields),
    hostAction('delete', { ...vaultFenceFields, confirmedVaultId: uuid, confirmedName: label }),
    hostAction('suspend-tenant', { previousHostEpoch: uint, effectId: uuid }),
    hostAction('resume-tenant', { previousHostEpoch: uint, effectId: uuid }),
    hostAction('destroy-tenant', { previousHostEpoch: uint, effectId: uuid }),
    hostAction('restore-fence', { previousHostEpoch: uint, effectId: uuid }),
    hostAction('backup-stage', { effectId: uuid }),
    hostAction('backup-release', { effectId: uuid }),
    // Restores exactly what the staged archive contains (Core's restored DB is the vault authority).
    hostAction('restore', { effectId: uuid, archiveManifestDigest: digest }),
    hostAction('reconcile-maintenance', {}),
  ])
  .superRefine((v, ctx) => {
    if ('generation' in v && v.generation <= v.expectedGeneration)
      ctx.addIssue({ code: 'custom', message: 'generation_conflict' })
    if ('previousHostEpoch' in v && v.hostEpoch <= v.previousHostEpoch)
      ctx.addIssue({ code: 'custom', message: 'generation_conflict' })
    if (v.action === 'create' && !originHasVault(v.origin, v.vaultId))
      ctx.addIssue({ code: 'custom', message: 'identity_mismatch' })
    if (
      v.action === 'owner-invite' &&
      !managedBigbrainInviteWindowSchema.safeParse({ issuedAt: v.issuedAt, expiresAt: v.expiresAt }).success
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_request' })
    if (v.action === 'delete' && v.confirmedVaultId !== v.vaultId)
      ctx.addIssue({ code: 'custom', message: 'identity_mismatch' })
    if (
      (v.action === 'member-set-access' || v.action === 'member-remove') &&
      managedBigbrainMemberIsProtected(v.handle)
    )
      ctx.addIssue({ code: 'custom', message: 'forbidden' })
  })
export type ManagedBigbrainHostRequest = z.infer<typeof managedBigbrainHostRequestSchema>

/** Private receipt. Not a public connection DTO and never contains auth material. */
export const managedBigbrainHostReceiptSchema = z
  .object({
    receiptId: uuid,
    tenantId: uuid,
    physicalHostBinding: uuid,
    vaultId: uuid,
    hostEpoch: uint,
    generation: positive,
    upstreamVaultId: uuid.nullable(),
    /** The host's recorded name: fences its own delete. Core's name is authoritative. */
    displayName: label,
    state: managedBigbrainStateSchema,
    upstreamCommit: pin,
    artifactDigest: digest,
    localPort: positive.max(65535).nullable(),
    origin: originSchema.nullable(),
    readAccess,
    /** Whether this vault's data was in the latest host backup staging (nightly runs isolate a
     * failing vault instead of losing the whole backup). Absent until the first staging. */
    backup: z.enum(['included', 'excluded']).optional(),
  })
  .strict()
  .refine((v) => v.origin === null || originHasVault(v.origin, v.vaultId))
export type ManagedBigbrainHostReceipt = z.infer<typeof managedBigbrainHostReceiptSchema>
const replyBase = { contractVersion: version, requestId: uuid }
const success = { ...replyBase, ok: z.literal(true), physicalHostBinding: uuid }
export const managedBigbrainHostReplySchema = z
  .union([
    z
      .object({ ...replyBase, ok: z.literal(false), code: managedBigbrainErrorCodeSchema, retryable: z.boolean() })
      .strict(),
    z.object({ ...success, action: z.literal('probe'), capabilities: managedBigbrainCapabilitiesSchema }).strict(),
    z
      .object({ ...success, action: z.literal('owner-invite'), invite: managedBigbrainOwnerInviteResultSchema })
      .strict(),
    z
      .object({
        ...success,
        action: z.literal('member-list'),
        vaultId: uuid,
        roster: managedBigbrainMemberRosterSchema,
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.literal('member-invite'),
        vaultId: uuid,
        invite: managedBigbrainMemberInviteResultSchema,
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.literal('invite-cancel'),
        vaultId: uuid,
        inviteId: managedBigbrainInviteIdSchema,
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.enum(['member-set-access', 'member-remove']),
        vaultId: uuid,
        member: managedBigbrainMemberSchema,
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.enum(['status', 'create', 'rename', 'read-revoke', 'read-reconnect', 'delete']),
        receipt: managedBigbrainHostReceiptSchema,
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.enum([
          'suspend-tenant',
          'resume-tenant',
          'destroy-tenant',
          'backup-stage',
          'backup-release',
          'restore',
          'reconcile-maintenance',
        ]),
        hostEpoch: uint,
        effectId: uuid.nullable(),
        completed: z.boolean(),
        code: managedBigbrainErrorCodeSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...success,
        action: z.literal('restore-fence'),
        hostEpoch: uint,
        effectId: uuid,
        archive: managedBigbrainArchiveInventorySchema,
      })
      .strict(),
  ])
  .refine((v) => !v.ok || !('receipt' in v) || v.physicalHostBinding === v.receipt.physicalHostBinding)
  .refine((v) => !v.ok || v.action !== 'probe' || v.physicalHostBinding === v.capabilities.physicalHostBinding)
export type ManagedBigbrainHostReply = z.infer<typeof managedBigbrainHostReplySchema>

/**
 * The read handoff's fields without its cross-field check, for deriving other schemas (zod 4 cannot
 * `.omit()` a refined object). Validate handoffs with `managedBigbrainReadHandoffSchema`.
 */
export const managedBigbrainReadHandoffObjectSchema = z
  .object({
    contractVersion: version,
    tenantId: uuid,
    physicalHostBinding: uuid,
    vaultId: uuid,
    hostEpoch: uint,
    generation: positive,
    upstreamVaultId: uuid,
    upstreamCommit: pin,
    artifactDigest: digest,
    credentialId: z.string().regex(/^[0-9a-f]{8}$/),
    kind: z.literal('agent'),
    scopes: z.tuple([z.literal('read')]),
    followsMember: z.literal(false),
    token: z.string().regex(/^sv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/),
  })
  .strict()
/** Root-written private material, never transported in HostReply/Platform response. */
export const managedBigbrainReadHandoffSchema = managedBigbrainReadHandoffObjectSchema.refine(
  (v) => v.token.slice(3, 11) === v.credentialId
)
export type ManagedBigbrainReadHandoff = z.infer<typeof managedBigbrainReadHandoffSchema>

function originHasVault(origin: string, vaultId: string): boolean {
  return managedBigbrainOriginHasVault(origin, vaultId)
}
/** The 12-hex short id of a vault UUID (first 12 hex characters, dashes removed). */
export function managedBigbrainVaultShortId(vaultId: string): string {
  if (!uuid.safeParse(vaultId).success) throw new Error('invalid_request')
  return vaultId.replaceAll('-', '').slice(0, MANAGED_BIGBRAIN_SHORT_ID_LENGTH)
}
/**
 * THE vault hostname rule (Core, host toolkit and Platform all use this; never build one by hand):
 * `<tenant>-bb-<short id>.<zone>` when a tenant label is given and that first label fits in 63
 * characters (and the origin in 253), otherwise `bb-<32 hex>.<zone>`. Call it ONCE, at create:
 * the result is persisted on the vault and receipt and never re-derived, so tenant renames and
 * older vaults keep their address.
 */
export function managedBigbrainVaultHostname(input: {
  vaultId: string
  zone: string
  tenantLabel: string | null | undefined
}): string {
  if (!uuid.safeParse(input.vaultId).success || !zoneSchema.safeParse(input.zone).success)
    throw new Error('invalid_request')
  const label = input.tenantLabel ?? null
  if (label !== null && !tenantLabelSchema.safeParse(label).success) throw new Error('invalid_request')
  const fallback = `bb-${input.vaultId.replaceAll('-', '')}.${input.zone}`
  if (label === null) return fallback
  const first = `${label}-bb-${managedBigbrainVaultShortId(input.vaultId)}`
  const hostname = `${first}.${input.zone}`
  return first.length <= DNS_LABEL_MAX && `https://${hostname}`.length <= ORIGIN_MAX ? hostname : fallback
}
export function managedBigbrainVaultOrigin(input: {
  vaultId: string
  zone: string
  tenantLabel: string | null | undefined
}): string {
  return `https://${managedBigbrainVaultHostname(input)}`
}
/** Whether a valid origin names THIS vault (either form, any zone/label). For persisted origins:
 * a recorded tenant label is kept across renames, so it is not compared with the current one. */
export function managedBigbrainOriginHasVault(origin: string, vaultId: string): boolean {
  const parts = parseManagedBigbrainOrigin(origin)
  if (!parts || !uuid.safeParse(vaultId).success) return false
  const hex = vaultId.replaceAll('-', '')
  return parts.tenantLabel === null ? parts.vaultKey === hex : parts.vaultKey === hex.slice(0, parts.vaultKey.length)
}
/** Admission of a NEW origin (host create, DNS): exactly the fallback form or the tenant-prefixed
 * form for this vault, installed zone and installed tenant label; nothing else. Syntax alone
 * cannot authorize an external zone or another tenant's label. */
export function managedBigbrainOriginMatchesPolicy(
  origin: string,
  vaultId: string,
  installedZone: string,
  tenantLabel: string | null = null
): boolean {
  if (
    !uuid.safeParse(vaultId).success ||
    !zoneSchema.safeParse(installedZone).success ||
    (tenantLabel !== null && !tenantLabelSchema.safeParse(tenantLabel).success) ||
    !originSchema.safeParse(origin).success
  )
    return false
  const allowed = new Set([
    managedBigbrainVaultOrigin({ vaultId, zone: installedZone, tenantLabel: null }),
    managedBigbrainVaultOrigin({ vaultId, zone: installedZone, tenantLabel }),
  ])
  return allowed.has(origin)
}
/** Compare separately authenticated Platform authority, root-installed state and observed input.
 * SSH pin/server ownership, epoch transitions, generation, pin/digest and permissions need separate checks.
 */
export function managedBigbrainHostBindingMatches(
  authority: ManagedBigbrainHostBinding,
  installed: ManagedBigbrainHostBinding,
  observed: ManagedBigbrainHostBinding
): boolean {
  return (
    [authority, installed, observed].every(
      (v) =>
        managedBigbrainHostBindingSchema.safeParse({
          tenantId: v.tenantId,
          physicalHostBinding: v.physicalHostBinding,
          hostEpoch: v.hostEpoch,
        }).success
    ) &&
    [installed, observed].every(
      (v) =>
        v.tenantId === authority.tenantId &&
        v.physicalHostBinding === authority.physicalHostBinding &&
        v.hostEpoch === authority.hostEpoch
    )
  )
}
function uniqueVaultIds(vaults: { vaultId: string }[]): boolean {
  return new Set(vaults.map((v) => v.vaultId)).size === vaults.length
}
/** Provider-record ownership tag (DNS comment) for one vault: Platform keeps no vault table and
 * identifies only records it owns by exact hostname plus this tag; never wildcard deletion. */
export const MANAGED_BIGBRAIN_DNS_OWNER_PREFIX = 'ficus:managed-bigbrain:' as const
export function managedBigbrainDnsOwner(tenantId: string, vaultId: string): string {
  if (!uuid.safeParse(tenantId).success || !uuid.safeParse(vaultId).success) throw new Error('invalid_request')
  return `${MANAGED_BIGBRAIN_DNS_OWNER_PREFIX}${tenantId}:${vaultId}`
}
const ipv4 = z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/)
/** Core's body for PUT /api/managed-bigbrain/dns/:vaultId. `{}` means the vault's bb-<32 hex>
 * origin (the only form older Platform builds know); a tenant-prefixed vault sends the origin
 * recorded at create. Platform must admit it with managedBigbrainOriginMatchesPolicy for the
 * tenant's zone and current label, or match its existing owned record by exact hostname + owner
 * tag; it never derives a prefixed origin itself. Use managedBigbrainDnsRequestFor to build it. */
export const managedBigbrainDnsRequestSchema = z
  .object({ origin: originSchema.optional() })
  .strict()
  .refine((v) => v.origin === undefined || parseManagedBigbrainOrigin(v.origin)?.tenantLabel !== null)
export function managedBigbrainDnsRequestFor(vaultId: string, origin: string): { origin?: string } {
  const parts = parseManagedBigbrainOrigin(origin)
  if (!parts || !managedBigbrainOriginHasVault(origin, vaultId)) throw new Error('invalid_request')
  return parts.tenantLabel === null ? {} : { origin }
}
export type ManagedBigbrainDnsRequest = z.infer<typeof managedBigbrainDnsRequestSchema>
/** Platform's reply to PUT /api/managed-bigbrain/dns/:vaultId. */
export const managedBigbrainDnsRecordSchema = z
  .object({
    contractVersion: version,
    tenantId: uuid,
    vaultId: uuid,
    zone: zoneSchema,
    hostname: z.string().max(253),
    origin: originSchema,
    serverIp: ipv4,
  })
  .strict()
  .refine((v) => {
    const parts = parseManagedBigbrainOrigin(v.origin)
    return (
      parts !== null &&
      managedBigbrainOriginHasVault(v.origin, v.vaultId) &&
      parts.zone === v.zone &&
      v.hostname === parts.hostname
    )
  })
export type ManagedBigbrainDnsRecord = z.infer<typeof managedBigbrainDnsRecordSchema>

/** Callers must also cap the stdin/SSH pipe incrementally before collecting it. */
function parseHostMessage<T>(
  body: string | Uint8Array,
  limit: number,
  schema: z.ZodType<T>,
  code: ManagedBigbrainErrorCode
): T {
  try {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    if (bytes.byteLength > limit) throw new Error(code)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return schema.parse(value)
  } catch {
    // Zod errors may contain input; never propagate them from the secret transport.
    throw new Error(code)
  }
}
export function parseManagedBigbrainHostRequest(body: string | Uint8Array): ManagedBigbrainHostRequest {
  return parseHostMessage(
    body,
    MANAGED_BIGBRAIN_HOST_REQUEST_BYTES,
    managedBigbrainHostRequestSchema,
    'invalid_request'
  )
}
export function parseManagedBigbrainHostReply(body: string | Uint8Array): ManagedBigbrainHostReply {
  return parseHostMessage(body, MANAGED_BIGBRAIN_HOST_REPLY_BYTES, managedBigbrainHostReplySchema, 'invalid_response')
}

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
export const MANAGED_BIGBRAIN_HOST_REPLY_BYTES = 16384
export const MANAGED_BIGBRAIN_MAX_VAULTS = 2
/** Matches the pinned native createAppLink API; never a public request-controlled TTL. */
export const MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS = 60 * 60 * 1000
export const MANAGED_BIGBRAIN_INVITE_CLOCK_SKEW_MS = 30_000
export const MANAGED_BIGBRAIN_MAX_ACTIVE_INVITES = 64

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
const zonePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const zoneSchema = z.string().max(210).regex(zonePattern)
const originSchema = z
  .string()
  .max(253)
  .refine((value) => {
    // Exact serialization rejects credentials, ports (including :443), paths, queries and fragments.
    if (!/^https:\/\/bb-[0-9a-f]{32}\./.test(value)) return false
    const zone = value.slice('https://bb-'.length + 33)
    return zoneSchema.safeParse(zone).success
  })
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
    .object({ enabled: z.literal(true), tenantId: uuid, physicalHostBinding: uuid, hostEpoch: uint, zone: zoneSchema })
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
    /** Installed DNS zone for bb-<vault>.<zone>; non-null exactly when installed. */
    zone: zoneSchema.nullable(),
    limits: managedBigbrainLimitsSchema,
    observedAt: datetime,
  })
  .strict()
  .refine((v) => (v.zone !== null) === v.installed)
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

/** Root-written private material, never transported in HostReply/Platform response. */
export const managedBigbrainReadHandoffSchema = z
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
  .refine((v) => v.token.slice(3, 11) === v.credentialId)
export type ManagedBigbrainReadHandoff = z.infer<typeof managedBigbrainReadHandoffSchema>

function originHasVault(origin: string, vaultId: string): boolean {
  return origin.startsWith(`https://bb-${vaultId.replaceAll('-', '')}.`)
}
/** Also required at the host boundary: syntax alone cannot authorize an external zone. */
export function managedBigbrainOriginMatchesPolicy(origin: string, vaultId: string, installedZone: string): boolean {
  return (
    uuid.safeParse(vaultId).success &&
    zoneSchema.safeParse(installedZone).success &&
    originSchema.safeParse(origin).success &&
    origin === `https://bb-${vaultId.replaceAll('-', '')}.${installedZone}`
  )
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
  .refine(
    (v) =>
      managedBigbrainOriginMatchesPolicy(v.origin, v.vaultId, v.zone) &&
      v.hostname === `bb-${v.vaultId.replaceAll('-', '')}.${v.zone}`
  )
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

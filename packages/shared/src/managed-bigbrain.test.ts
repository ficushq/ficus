import { describe, expect, test } from 'bun:test'
import * as contract from './managed-bigbrain'
import { INSTANCE_INTEGRATION_SCOPES } from './integration-relay/protocol'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const binding = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const digest = `sha256:${'a'.repeat(64)}`
const pin = 'cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed'
const origin = `https://bb-${id.replaceAll('-', '')}.example.com`
const owner = { userId: other, handle: 'ada', display: 'Ada' }
const limits = {
  maxVaults: 2,
  perVaultDiskBytes: 536870912,
  perVaultMemoryBytes: 268435456,
  aggregateMemoryBytes: 671088640,
  aggregateCpuPercent: 50,
  minCoreFreeDiskBytes: 2147483648,
  perVaultRequests: 2,
  aggregateRequests: 4,
  requestBytes: 1114112,
  nativeResponseBytes: 16777216,
  toolResponseBytes: 524288,
  requestTimeoutMs: 15000,
}
const envelope = { contractVersion: 1, requestId: other, tenantId: id, physicalHostBinding: binding, hostEpoch: 3 }
const fence = { vaultId: id, expectedGeneration: 0, generation: 1 }
const receipt = {
  receiptId: other,
  tenantId: id,
  physicalHostBinding: binding,
  vaultId: id,
  hostEpoch: 3,
  generation: 1,
  upstreamVaultId: other,
  state: 'ready',
  upstreamCommit: pin,
  artifactDigest: digest,
  localPort: 30000,
  origin,
  readAccess: 'active',
}
const capabilities = {
  contractVersion: 1,
  tenantId: id,
  physicalHostBinding: binding,
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: pin,
  artifactDigest: digest,
  sharedProtocol: 1,
  hostEpoch: 3,
  hostState: 'active',
  limits,
  observedAt: '2026-10-20T00:00:00Z',
}
const handoff = {
  contractVersion: 1,
  tenantId: id,
  physicalHostBinding: binding,
  vaultId: id,
  hostEpoch: 3,
  generation: 1,
  upstreamVaultId: other,
  upstreamCommit: pin,
  artifactDigest: digest,
  credentialId: '1234abcd',
  kind: 'agent',
  scopes: ['read'],
  followsMember: false,
  token: `sv_1234abcd_${'a'.repeat(43)}`,
}
const grant = {
  vaultId: id,
  disposition: 'restore',
  upstreamVaultId: other,
  generation: 2,
  owner,
  origin,
  readAccess: 'revoked',
}
const archive = {
  tenantId: id,
  sourcePhysicalHostBinding: other,
  manifestDigest: digest,
  vaults: [{ vaultId: id, upstreamVaultId: other, generation: 1 }],
}
const requests = [
  { action: 'probe' },
  { action: 'status', vaultId: id },
  {
    action: 'create',
    ...fence,
    displayName: 'Research',
    owner,
    origin,
    limits,
    upstreamCommit: pin,
    artifactDigest: digest,
  },
  { action: 'rename', ...fence, displayName: 'Renamed' },
  { action: 'owner-invite', vaultId: id, expectedGeneration: 1, actorUserId: other },
  ...['read-revoke', 'read-reconnect'].map((action) => ({ action, ...fence })),
  { action: 'delete', ...fence, confirmedVaultId: id, confirmedName: 'Research' },
  ...['suspend-tenant', 'resume-tenant', 'destroy-tenant', 'restore-fence'].map((action) => ({
    action,
    previousHostEpoch: 2,
    effectId: other,
  })),
  ...['backup-stage', 'backup-release'].map((action) => ({ action, effectId: other })),
  { action: 'restore', effectId: other, archiveManifestDigest: digest, currentVaults: [grant] },
  { action: 'reconcile-maintenance' },
].map((request) => ({ ...envelope, ...request }))
const replies = [
  { ok: false, code: 'operation_failed', retryable: false },
  { ok: true, action: 'probe', physicalHostBinding: binding, capabilities },
  {
    ok: true,
    action: 'owner-invite',
    physicalHostBinding: binding,
    invite: { inviteUrl: `${origin}/invite#${'b'.repeat(43)}`, expiresAt: '2026-10-20T01:00:00Z' },
  },
  ...['status', 'create', 'rename', 'read-revoke', 'read-reconnect', 'delete'].map((action) => ({
    ok: true,
    action,
    physicalHostBinding: binding,
    receipt,
  })),
  ...[
    'suspend-tenant',
    'resume-tenant',
    'destroy-tenant',
    'backup-stage',
    'backup-release',
    'restore',
    'reconcile-maintenance',
  ].map((action) => ({
    ok: true,
    action,
    physicalHostBinding: binding,
    hostEpoch: 3,
    effectId: other,
    completed: true,
    code: null,
  })),
  { ok: true, action: 'restore-fence', physicalHostBinding: binding, hostEpoch: 3, effectId: other, archive },
].map((reply) => ({ contractVersion: 1, requestId: other, ...reply }))

// These fixtures contain only synthetic material. No tests contact a host or upstream.
describe('managed BigBrain v1 wire contract', () => {
  test('publishes the fixed helper, upstream pin and narrow instance scopes', () => {
    expect(contract.MANAGED_BIGBRAIN_HELPER).toBe('/usr/local/libexec/ficus-bigbrainctl')
    expect(contract.MANAGED_BIGBRAIN_UPSTREAM_COMMIT).toBe(pin)
    expect(contract.MANAGED_BIGBRAIN_CONTRACT_VERSION).toBe(1)
    expect(contract.MANAGED_BIGBRAIN_SCOPES).toEqual(['managed-bigbrain:read', 'managed-bigbrain:manage'])
    for (const scope of contract.MANAGED_BIGBRAIN_SCOPES) expect(INSTANCE_INTEGRATION_SCOPES).toContain(scope)
  })
  test('management never accepts endpoint, tenant, credentials or command overrides', () => {
    const input = { requestId: id, expectedGeneration: 0, displayName: 'Research', owner }
    expect(contract.createManagedVaultSchema.safeParse(input).success).toBe(true)
    for (const key of [
      'endpoint',
      'token',
      'tenantId',
      'physicalHostBinding',
      'path',
      'port',
      'command',
      'purgeBackups',
    ]) {
      expect(contract.createManagedVaultSchema.safeParse({ ...input, [key]: 'override' }).success).toBe(false)
    }
  })
  for (const request of requests)
    test(`accepts strict host action ${request.action}`, () => {
      expect(contract.managedBigbrainHostRequestSchema.safeParse(request).success).toBe(true)
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...request, command: 'echo bad' }).success).toBe(
        false
      )
      const { physicalHostBinding: _, ...unbound } = request
      expect(contract.managedBigbrainHostRequestSchema.safeParse(unbound).success).toBe(false)
    })
  for (const [i, reply] of replies.entries())
    test(`validates reply variant ${i} without secret injection`, () => {
      expect(contract.managedBigbrainHostReplySchema.safeParse(reply).success).toBe(true)
      for (const key of ['token', 'ownerToken', 'stderr', 'handoffPath', 'inviteUrl']) {
        expect(contract.managedBigbrainHostReplySchema.safeParse({ ...reply, [key]: 'secret' }).success).toBe(false)
      }
    })
  test('safe nested receipts/capabilities cannot carry private material', () => {
    for (const [schema, value] of [
      [contract.managedBigbrainCapabilitiesSchema, capabilities],
      [contract.managedBigbrainHostReceiptSchema, receipt],
    ] as const) {
      for (const key of ['token', 'inviteUrl', 'ownerEscrow', 'path'])
        expect(schema.safeParse({ ...value, [key]: 'secret' }).success).toBe(false)
      const { physicalHostBinding: _, ...unbound } = value
      expect(schema.safeParse(unbound).success).toBe(false)
    }
    expect(
      contract.managedBigbrainCapabilitiesSchema.safeParse({ ...capabilities, available: true, installed: false })
        .success
    ).toBe(false)
    expect(
      contract.managedBigbrainCapabilitiesSchema.safeParse({
        ...capabilities,
        available: true,
        reasonCode: 'not_installed',
      }).success
    ).toBe(false)
  })
  test('rejects unsafe integers, noncanonical UUIDs, unpinned versions and unbounded labels', () => {
    const create = requests.find((r) => r.action === 'create')!
    for (const bad of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, hostEpoch: bad }).success).toBe(false)
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, generation: bad }).success).toBe(false)
    }
    for (const bad of [binding.toUpperCase(), '../other', 'id'])
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, physicalHostBinding: bad }).success).toBe(
        false
      )
    for (const bad of ['main', 'a'.repeat(40)])
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, upstreamCommit: bad }).success).toBe(
        false
      )
    for (const bad of ['', '  Research', 'A\nB', 'a'.repeat(121)])
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, displayName: bad }).success).toBe(false)
    for (const bad of ['ficus-reader', 'Ada', '../owner'])
      expect(contract.managedBigbrainOwnerSchema.safeParse({ ...owner, handle: bad }).success).toBe(false)
    expect(
      contract.managedBigbrainHostRequestSchema.safeParse({ ...create, artifactDigest: `sha256:${'A'.repeat(64)}` })
        .success
    ).toBe(false)
    expect(
      contract.managedBigbrainCapabilitiesSchema.safeParse({ ...capabilities, observedAt: 'yesterday' }).success
    ).toBe(false)
    expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, generation: 0 }).success).toBe(false)
    expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, action: 'exec' }).success).toBe(false)
  })
  test('bounds limits, inventory and restore grants rather than accepting arbitrary blobs', () => {
    expect(contract.managedBigbrainLimitsSchema.safeParse(limits).success).toBe(true)
    for (const [key, value] of Object.entries(limits)) {
      for (const bad of [0, -1, value + Number.MAX_SAFE_INTEGER])
        expect(contract.managedBigbrainLimitsSchema.safeParse({ ...limits, [key]: bad }).success).toBe(false)
    }
    expect(contract.managedBigbrainLimitsSchema.safeParse({ ...limits, toolResponseBytes: 524289 }).success).toBe(false)
    const restore = requests.find((r) => r.action === 'restore')!
    expect(
      contract.managedBigbrainHostRequestSchema.safeParse({ ...restore, currentVaults: [grant, grant] }).success
    ).toBe(false)
    expect(
      contract.managedBigbrainHostRequestSchema.safeParse({ ...restore, currentVaults: Array(100).fill(grant) }).success
    ).toBe(false)
    expect(contract.managedBigbrainRestoreGrantSchema.safeParse({ ...grant, readAccess: 'active' }).success).toBe(false)
    expect(
      contract.managedBigbrainRestoreGrantSchema.safeParse({ vaultId: id, disposition: 'exclude', code: 'not_found' })
        .success
    ).toBe(true)
  })
  test('admits only canonical per-vault HTTPS origins in the installed zone', () => {
    const create = requests.find((r) => r.action === 'create')!
    for (const bad of [
      'http://localhost',
      'https://169.254.169.254',
      `${origin}/path`,
      `${origin}:443`,
      `${origin}?x=1`,
      `https://user@${origin.slice(8)}`,
      'https://other.example.com',
    ]) {
      expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, origin: bad }).success).toBe(false)
    }
    expect(contract.managedBigbrainOriginMatchesPolicy(origin, id, 'example.com')).toBe(true)
    expect(contract.managedBigbrainOriginMatchesPolicy(origin, other, 'example.com')).toBe(false)
    expect(contract.managedBigbrainOriginMatchesPolicy(origin, id, 'foreign.com')).toBe(false)
    expect(contract.managedBigbrainOriginMatchesPolicy(origin, id, 'com')).toBe(false)
  })
  test('private handoff requires explicit read-only credential identity and immutable binding', () => {
    expect(contract.managedBigbrainReadHandoffSchema.safeParse(handoff).success).toBe(true)
    for (const change of [
      { followsMember: true },
      { scopes: ['read', 'write'] },
      { kind: 'person' },
      { token: 'owner' },
      { credentialId: 'deadbeef' },
      { physicalHostBinding: undefined },
    ]) {
      expect(contract.managedBigbrainReadHandoffSchema.safeParse({ ...handoff, ...change }).success).toBe(false)
    }
  })
  test('binds mutations/probes/import/reads to independent installed and authoritative host fences', () => {
    const authority = { tenantId: id, physicalHostBinding: binding, hostEpoch: 3 }
    expect(contract.managedBigbrainHostBindingMatches(authority, authority, handoff)).toBe(true)
    for (const changed of [{ physicalHostBinding: other }, { hostEpoch: 2 }, { tenantId: other }]) {
      expect(contract.managedBigbrainHostBindingMatches(authority, { ...authority, ...changed }, handoff)).toBe(false)
      expect(contract.managedBigbrainHostBindingMatches(authority, authority, { ...handoff, ...changed })).toBe(false)
    }
    // Upgrade/reconcile leaves binding unchanged; artifact identity is checked separately.
    const upgraded = { ...handoff, artifactDigest: `sha256:${'b'.repeat(64)}` }
    expect(contract.managedBigbrainHostBindingMatches(authority, authority, upgraded)).toBe(true)
    expect(
      contract.managedBigbrainHostBindingMatches(authority, authority, {
        ...authority,
        physicalHostBinding: archive.sourcePhysicalHostBinding,
      })
    ).toBe(false)
  })
  test('parses bounded UTF-8 helper messages without including secret input in errors', () => {
    expect<unknown>(contract.parseManagedBigbrainHostRequest(JSON.stringify(requests[0]))).toEqual(requests[0])
    expect<unknown>(contract.parseManagedBigbrainHostReply(JSON.stringify(replies[0]))).toEqual(replies[0])
    for (const body of [
      '{secret',
      JSON.stringify({ ...requests[0], token: 'PRIVATE' }),
      ' '.repeat(8193),
      '界'.repeat(3000),
      new Uint8Array([0xff]),
    ]) {
      expect(() => contract.parseManagedBigbrainHostRequest(body)).toThrow('invalid_request')
    }
    expect(() => contract.parseManagedBigbrainHostReply(' '.repeat(16385))).toThrow('invalid_response')
    const probe = replies.find((r) => r.ok && 'action' in r && r.action === 'probe')!
    expect(contract.managedBigbrainHostReplySchema.safeParse({ ...probe, physicalHostBinding: other }).success).toBe(
      false
    )
  })
  test('validates every public management DTO and safe summary separately', () => {
    const summary = {
      contractVersion: 1,
      vaultId: id,
      displayName: 'Research',
      ownerUserId: other,
      state: 'ready',
      readAccess: 'active',
      desiredGeneration: 1,
      appliedGeneration: 1,
      upstreamVaultId: other,
      upstreamCommit: pin,
      origin,
      operationId: other,
      lastErrorCode: null,
      retryable: false,
      updatedAt: capabilities.observedAt,
    }
    const cases = [
      [contract.managedBigbrainVaultSummarySchema, summary],
      [contract.managedBigbrainVaultListSchema, { items: [summary] }],
      [
        contract.managedBigbrainOperationSchema,
        { contractVersion: 1, operationId: other, vaultId: id, generation: 1, state: 'accepted', code: null },
      ],
      [contract.managedBigbrainRetrySchema, { requestId: id, expectedGeneration: 1 }],
      [contract.managedBigbrainOwnerInviteSchema, { requestId: id, expectedGeneration: 1, actorUserId: other }],
      [contract.managedBigbrainReadAccessSchema, { requestId: id, expectedGeneration: 1, action: 'revoke' }],
      [
        contract.managedBigbrainDeleteVaultSchema,
        { requestId: id, expectedGeneration: 1, confirmedVaultId: id, confirmedName: 'Research' },
      ],
    ] as const
    for (const [schema, value] of cases) {
      expect(schema.safeParse(value).success).toBe(true)
      for (const key of ['token', 'inviteUrl', 'tenantId', 'endpoint', 'path'])
        expect(schema.safeParse({ ...value, [key]: 'PRIVATE' }).success).toBe(false)
    }
    expect(contract.managedBigbrainVaultSummarySchema.safeParse({ ...summary, appliedGeneration: 2 }).success).toBe(
      false
    )
    expect(
      contract.managedBigbrainVaultSummarySchema.safeParse({ ...summary, lastErrorCode: 'raw stderr' }).success
    ).toBe(false)
    for (const inviteUrl of [
      `${origin}/invite?secret=PRIVATE`,
      `${origin}/invite#short`,
      'http://localhost/invite#' + 'b'.repeat(43),
    ]) {
      expect(
        contract.managedBigbrainOwnerInviteResultSchema.safeParse({ inviteUrl, expiresAt: capabilities.observedAt })
          .success
      ).toBe(false)
    }
  })
  test('restore validates current grants against exact archive identity, not archive authority', () => {
    expect(contract.managedBigbrainRestoreGrantsMatch(archive, [grant], id)).toBe(true)
    expect(
      contract.managedBigbrainRestoreGrantsMatch(
        archive,
        [{ vaultId: id, disposition: 'exclude', code: 'forbidden' }],
        id
      )
    ).toBe(true)
    for (const grants of [
      [],
      [grant, grant],
      [{ ...grant, vaultId: other }],
      [{ ...grant, upstreamVaultId: id }],
      [{ ...grant, generation: 1 }],
    ]) {
      expect(contract.managedBigbrainRestoreGrantsMatch(archive, grants, id)).toBe(false)
    }
    expect(contract.managedBigbrainRestoreGrantsMatch(archive, [grant], other)).toBe(false)
  })
})

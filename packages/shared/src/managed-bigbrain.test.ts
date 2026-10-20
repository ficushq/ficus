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
  displayName: 'Research',
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
  zone: 'example.com',
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
  {
    action: 'owner-invite',
    vaultId: id,
    expectedGeneration: 1,
    actorUserId: other,
    issuedAt: '2026-10-20T00:00:00Z',
    expiresAt: '2026-10-20T01:00:00Z',
  },
  ...['read-revoke', 'read-reconnect'].map((action) => ({ action, ...fence })),
  { action: 'delete', ...fence, confirmedVaultId: id, confirmedName: 'Research' },
  ...['suspend-tenant', 'resume-tenant', 'destroy-tenant', 'restore-fence'].map((action) => ({
    action,
    previousHostEpoch: 2,
    effectId: other,
  })),
  ...['backup-stage', 'backup-release'].map((action) => ({ action, effectId: other })),
  { action: 'restore', effectId: other, archiveManifestDigest: digest },
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
  test('private owner-link authority uses immutable native one-hour issuance with bounded clock refusal', () => {
    const window = { issuedAt: '2026-10-20T00:00:00Z', expiresAt: '2026-10-20T01:00:00Z' }
    const now = Date.parse(window.issuedAt)
    expect(contract.MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toBe(3600000)
    expect(contract.managedBigbrainInviteWindowStatus(window, now)).toBe('current')
    expect(contract.managedBigbrainInviteWindowStatus(window, now - 1000)).toBe('not_yet_valid')
    expect(contract.managedBigbrainInviteWindowStatus(window, now - 30001)).toBe('invalid')
    expect(contract.managedBigbrainInviteWindowStatus(window, now + 3600000)).toBe('expired')
    for (const bad of [
      { ...window, expiresAt: window.issuedAt },
      { ...window, expiresAt: '2026-10-21T01:00:00Z' },
      { ...window, expiresAt: '2026-10-20T00:05:00Z' },
    ]) {
      expect(contract.managedBigbrainInviteWindowSchema.safeParse(bad).success).toBe(false)
    }
    const request = requests.find((r) => r.action === 'owner-invite')!
    const { issuedAt: _issued, expiresAt: _expires, ...missingWindow } = request as Record<string, unknown>
    expect(contract.managedBigbrainHostRequestSchema.safeParse(missingWindow).success).toBe(false)
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
    // Restore is archive-driven: no caller-supplied grants or vault lists.
    expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...restore, currentVaults: [] }).success).toBe(false)
    expect(
      contract.managedBigbrainArchiveInventorySchema.safeParse({
        ...archive,
        vaults: Array(contract.MANAGED_BIGBRAIN_MAX_VAULTS + 1)
          .fill(0)
          .map((_, i) => ({
            vaultId: `${i}1111111-1111-4111-8111-111111111111`,
            upstreamVaultId: other,
            generation: 1,
          })),
      }).success
    ).toBe(false)
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
  test('the owner-link result is a strict secret-bearing shape', () => {
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
})

describe('managed BigBrain host installation config', () => {
  const enabled = {
    enabled: true,
    tenantId: '11111111-1111-4111-8111-111111111111',
    physicalHostBinding: '33333333-3333-4333-8333-333333333333',
    hostEpoch: 0,
    zone: 'bigbrain.example.com',
  }
  test('default limits are the single shared admission policy', () => {
    expect(contract.managedBigbrainLimitsSchema.parse(contract.MANAGED_BIGBRAIN_DEFAULT_LIMITS)).toEqual(
      contract.MANAGED_BIGBRAIN_DEFAULT_LIMITS
    )
    expect(contract.MANAGED_BIGBRAIN_DEFAULT_LIMITS.maxVaults).toBe(contract.MANAGED_BIGBRAIN_MAX_VAULTS)
    expect(Object.isFrozen(contract.MANAGED_BIGBRAIN_DEFAULT_LIMITS)).toBe(true)
  })
  test('disabled carries no identity; enabled requires the full canonical binding and safe zone', () => {
    expect(contract.managedBigbrainHostConfigSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(contract.managedBigbrainHostConfigSchema.parse(enabled)).toEqual(enabled)
    for (const bad of [
      { enabled: false, tenantId: enabled.tenantId },
      { ...enabled, physicalHostBinding: undefined },
      { ...enabled, zone: 'Example.com' },
      { ...enabled, zone: 'example.com:443' },
      { ...enabled, hostEpoch: -1 },
      { ...enabled, limits: contract.MANAGED_BIGBRAIN_DEFAULT_LIMITS },
      { ...enabled, artifactPath: '/tmp/x' },
    ])
      expect(contract.managedBigbrainHostConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('slim Platform contract (Core-local vault operations)', () => {
  const installed = {
    contractVersion: 1,
    tenantId: id,
    physicalHostBinding: binding,
    hostEpoch: 3,
    hostState: 'active',
    upstreamCommit: pin,
    artifactDigest: digest,
    zone: 'example.com',
    limits,
    effect: null,
  }
  test('the installed host record parses its shape and rejects extra keys', () => {
    expect(contract.MANAGED_BIGBRAIN_HOST_RECORD).toBe('/etc/ficus/bigbrain/host.json')
    expect(contract.managedBigbrainInstalledHostSchema.parse(installed)).toEqual({
      ...installed,
      tenantLabel: null,
    } as never)
    expect(contract.managedBigbrainInstalledHostSchema.parse({ ...installed, tenantLabel: 'noah' }).tenantLabel).toBe(
      'noah'
    )
    const { effect: _effect, ...withoutEffect } = installed
    expect(contract.managedBigbrainInstalledHostSchema.parse(withoutEffect).effect).toBeNull()
    for (const bad of [
      { ...installed, token: 'x' },
      { ...installed, zone: 'Example.com' },
      { ...installed, tenantLabel: 'Noah' },
      { ...installed, tenantLabel: 'bb-noah' },
      { ...installed, physicalHostBinding: 'x' },
      { ...installed, effect: { action: 'create', effectId: other, previousHostEpoch: 2, completed: true } },
    ])
      expect(contract.managedBigbrainInstalledHostSchema.safeParse(bad).success).toBe(false)
  })
  test('DNS records name exactly one vault in one zone, with a fixed ownership tag', () => {
    const record = {
      contractVersion: 1,
      tenantId: other,
      vaultId: id,
      zone: 'example.com',
      hostname: `bb-${id.replaceAll('-', '')}.example.com`,
      origin,
      serverIp: '203.0.113.7',
    }
    expect(contract.managedBigbrainDnsRecordSchema.safeParse(record).success).toBe(true)
    for (const bad of [
      { ...record, vaultId: other },
      { ...record, zone: 'foreign.com' },
      { ...record, hostname: 'bb-x.example.com' },
      { ...record, origin: `https://bb-${other.replaceAll('-', '')}.example.com` },
      { ...record, serverIp: '999.1.1.1' },
      { ...record, recordId: 'cf-1' },
    ])
      expect(contract.managedBigbrainDnsRecordSchema.safeParse(bad).success).toBe(false)
    expect(contract.managedBigbrainDnsOwner(other, id)).toBe(`ficus:managed-bigbrain:${other}:${id}`)
    expect(contract.managedBigbrainDnsOwner(other, id).startsWith(contract.MANAGED_BIGBRAIN_DNS_OWNER_PREFIX)).toBe(
      true
    )
    expect(() => contract.managedBigbrainDnsOwner('*', id)).toThrow('invalid_request')
  })
  test('receipts carry the host name; capabilities carry the zone exactly when installed', () => {
    const { displayName: _name, ...unnamed } = receipt
    expect(contract.managedBigbrainHostReceiptSchema.safeParse(unnamed).success).toBe(false)
    expect(contract.managedBigbrainCapabilitiesSchema.safeParse({ ...capabilities, zone: null }).success).toBe(false)
    expect(
      contract.managedBigbrainCapabilitiesSchema.safeParse({
        ...capabilities,
        available: false,
        installed: false,
        reasonCode: 'not_installed',
        physicalHostBinding: null,
        artifactDigest: null,
        zone: null,
      }).success
    ).toBe(true)
  })
  test('Platform per-vault management DTOs and restore grants no longer exist', () => {
    for (const name of [
      'managedBigbrainVaultSummarySchema',
      'managedBigbrainVaultListSchema',
      'managedBigbrainOperationSchema',
      'managedBigbrainPutVaultSchema',
      'createManagedVaultSchema',
      'managedBigbrainRetrySchema',
      'managedBigbrainOwnerInviteSchema',
      'managedBigbrainReadAccessSchema',
      'managedBigbrainDeleteVaultSchema',
      'managedBigbrainRestoreGrantSchema',
      'managedBigbrainRestoreGrantsMatch',
    ])
      expect(name in contract).toBe(false)
  })
})

describe('managed BigBrain vault hostnames', () => {
  const vault = '7b0a25fe-1d6a-4c11-8d22-0123456789ab'
  const hex = vault.replaceAll('-', '')
  const zone = 'ficus.sh'
  const fallback = `https://bb-${hex}.ficus.sh`
  const prefixed = 'https://noah-bb-7b0a25fe1d6a.ficus.sh'
  test('a short tenant gets <tenant>-bb-<12 hex>; no tenant label keeps bb-<32 hex>', () => {
    expect(contract.managedBigbrainVaultShortId(vault)).toBe('7b0a25fe1d6a')
    expect(contract.managedBigbrainVaultHostname({ vaultId: vault, zone, tenantLabel: 'noah' })).toBe(
      'noah-bb-7b0a25fe1d6a.ficus.sh'
    )
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone, tenantLabel: 'noah' })).toBe(prefixed)
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone, tenantLabel: null })).toBe(fallback)
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone, tenantLabel: undefined })).toBe(fallback)
  })
  test('falls back exactly when <tenant>-bb-<12 hex> would exceed one 63-character DNS label', () => {
    const fits = 'a'.repeat(47) // 47 + '-bb-' + 12 = 63
    const tooLong = 'a'.repeat(48)
    const max = 'a'.repeat(contract.MANAGED_BIGBRAIN_TENANT_LABEL_MAX)
    expect(contract.managedBigbrainVaultHostname({ vaultId: vault, zone, tenantLabel: fits })).toBe(
      `${fits}-bb-7b0a25fe1d6a.ficus.sh`
    )
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone, tenantLabel: tooLong })).toBe(fallback)
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone, tenantLabel: max })).toBe(fallback)
    expect(contract.managedBigbrainTenantLabelSchema.safeParse(max).success).toBe(true)
    expect(contract.managedBigbrainTenantLabelSchema.safeParse(`${max}a`).success).toBe(false)
    // A long zone that leaves no room for the prefixed origin also falls back.
    const longZone = `${'z'.repeat(60)}.${'y'.repeat(60)}.${'x'.repeat(60)}.example.com`
    expect(contract.managedBigbrainVaultOrigin({ vaultId: vault, zone: longZone, tenantLabel: fits })).toBe(
      `https://bb-${hex}.${longZone}`
    )
  })
  test('refuses invalid inputs instead of building a hostname', () => {
    for (const tenantLabel of ['Noah', 'noah.evil', '-noah', 'noah-', '', 'bb-noah', 'x-bb-0123456789ab'])
      expect(() => contract.managedBigbrainVaultHostname({ vaultId: vault, zone, tenantLabel })).toThrow(
        'invalid_request'
      )
    expect(() => contract.managedBigbrainVaultHostname({ vaultId: 'x', zone, tenantLabel: 'noah' })).toThrow()
    expect(() =>
      contract.managedBigbrainVaultHostname({ vaultId: vault, zone: 'Ficus.sh', tenantLabel: null })
    ).toThrow()
  })
  test('reserves the vault namespace for tenant subdomains', () => {
    for (const label of ['bb-anything', 'bb-', 'noah-bb-7b0a25fe1d6a', 'a-b-bb-000000000000'])
      expect(contract.managedBigbrainReservesLabel(label)).toBe(true)
    for (const label of ['noah', 'bb', 'bbq', 'noah-bb', 'noah-bb-7b0a25fe1d6', 'noah-bb-7B0A25FE1D6A', 'abb-x'])
      expect(contract.managedBigbrainReservesLabel(label)).toBe(false)
  })
  test('parses exactly the two forms', () => {
    expect(contract.parseManagedBigbrainOrigin(prefixed)).toEqual({
      hostname: 'noah-bb-7b0a25fe1d6a.ficus.sh',
      zone,
      tenantLabel: 'noah',
      vaultKey: '7b0a25fe1d6a',
    })
    expect(contract.parseManagedBigbrainOrigin(fallback)).toEqual({
      hostname: `bb-${hex}.ficus.sh`,
      zone,
      tenantLabel: null,
      vaultKey: hex,
    })
    for (const bad of [
      'https://noah-bb-7b0a25fe1d6.ficus.sh',
      'https://noah-bb-7b0a25fe1d6ab.ficus.sh',
      'https://Noah-bb-7b0a25fe1d6a.ficus.sh',
      'https://noah-bb-7b0a25fe1d6a.ficus.sh/',
      'https://noah-bb-7b0a25fe1d6a.ficus.sh:443',
      'https://noah-bb-7b0a25fe1d6a',
      'https://-bb-7b0a25fe1d6a.ficus.sh',
      'https://bb-7b0a25fe1d6a.ficus.sh',
      'https://x-bb-0123456789ab-bb-7b0a25fe1d6a.ficus.sh',
      `https://${'a'.repeat(48)}-bb-7b0a25fe1d6a.ficus.sh`,
      'http://noah-bb-7b0a25fe1d6a.ficus.sh',
      'https://user@noah-bb-7b0a25fe1d6a.ficus.sh',
    ])
      expect(contract.parseManagedBigbrainOrigin(bad)).toBeNull()
  })
  test('policy admits exactly the fallback and this tenant prefixed origin for this vault and zone', () => {
    const p = contract.managedBigbrainOriginMatchesPolicy
    expect(p(prefixed, vault, zone, 'noah')).toBe(true)
    expect(p(fallback, vault, zone, 'noah')).toBe(true)
    // Existing bb-<32 hex> vaults stay valid with or without a tenant label installed.
    expect(p(fallback, vault, zone, null)).toBe(true)
    expect(p(fallback, vault, zone)).toBe(true)
    expect(p(prefixed, vault, zone, null)).toBe(false)
    expect(p(prefixed, vault, zone, 'alice')).toBe(false)
    expect(p(prefixed, vault, 'other.sh', 'noah')).toBe(false)
    expect(p(prefixed, '7b0a25fe-1d6a-4c11-8d22-ffffffffffff', zone, 'noah')).toBe(true) // same short id
    expect(p(prefixed, '7b0a25fe-1d6b-4c11-8d22-0123456789ab', zone, 'noah')).toBe(false)
    expect(p(prefixed, vault, zone, 'Noah')).toBe(false)
    const long = 'a'.repeat(48)
    expect(p(`https://${long}-bb-7b0a25fe1d6a.ficus.sh`, vault, zone, long)).toBe(false)
  })
  test('persisted origins bind their vault, not the current tenant label', () => {
    expect(contract.managedBigbrainOriginHasVault(prefixed, vault)).toBe(true)
    expect(contract.managedBigbrainOriginHasVault('https://old-name-bb-7b0a25fe1d6a.ficus.sh', vault)).toBe(true)
    expect(contract.managedBigbrainOriginHasVault(fallback, vault)).toBe(true)
    expect(contract.managedBigbrainOriginHasVault(prefixed, id)).toBe(false)
    expect(contract.managedBigbrainOriginHasVault(`https://bb-${hex.slice(0, 31)}0.ficus.sh`, vault)).toBe(false)
  })
  test('host create, receipts, invites and DNS accept the tenant-prefixed form', () => {
    const create = {
      ...envelope,
      action: 'create',
      vaultId: vault,
      expectedGeneration: 0,
      generation: 1,
      displayName: 'Team',
      owner,
      origin: prefixed,
      limits,
      upstreamCommit: pin,
      artifactDigest: digest,
    }
    expect(contract.managedBigbrainHostRequestSchema.safeParse(create).success).toBe(true)
    expect(contract.managedBigbrainHostRequestSchema.safeParse({ ...create, vaultId: id }).success).toBe(false)
    const r = { ...receipt, vaultId: vault, origin: prefixed }
    expect(contract.managedBigbrainHostReceiptSchema.safeParse(r).success).toBe(true)
    expect(contract.managedBigbrainHostReceiptSchema.safeParse({ ...r, vaultId: id }).success).toBe(false)
    expect(
      contract.managedBigbrainOwnerInviteResultSchema.safeParse({
        inviteUrl: `${prefixed}/invite#${'b'.repeat(43)}`,
        expiresAt: '2026-10-20T01:00:00Z',
      }).success
    ).toBe(true)
    const record = {
      contractVersion: 1,
      tenantId: other,
      vaultId: vault,
      zone,
      hostname: 'noah-bb-7b0a25fe1d6a.ficus.sh',
      origin: prefixed,
      serverIp: '203.0.113.7',
    }
    expect(contract.managedBigbrainDnsRecordSchema.safeParse(record).success).toBe(true)
    for (const bad of [
      { ...record, hostname: `bb-${hex}.ficus.sh` },
      { ...record, zone: 'other.sh' },
      { ...record, vaultId: id },
    ])
      expect(contract.managedBigbrainDnsRecordSchema.safeParse(bad).success).toBe(false)
    expect(contract.managedBigbrainDnsRequestSchema.safeParse({ origin: prefixed }).success).toBe(true)
    expect(contract.managedBigbrainDnsRequestSchema.safeParse({ origin: 'https://evil.example' }).success).toBe(false)
  })
  test('capabilities and host config carry the tenant label only when installed', () => {
    expect(contract.managedBigbrainCapabilitiesSchema.parse(capabilities).tenantLabel).toBeNull()
    expect(contract.managedBigbrainCapabilitiesSchema.parse({ ...capabilities, tenantLabel: 'noah' }).tenantLabel).toBe(
      'noah'
    )
    const config = { enabled: true, tenantId: id, physicalHostBinding: binding, hostEpoch: 0, zone }
    expect(contract.managedBigbrainHostConfigSchema.safeParse(config).success).toBe(true)
    expect(contract.managedBigbrainHostConfigSchema.safeParse({ ...config, tenantLabel: 'noah' }).success).toBe(true)
    expect(contract.managedBigbrainHostConfigSchema.safeParse({ ...config, tenantLabel: 'bb-x' }).success).toBe(false)
  })
})

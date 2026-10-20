import { expect, test } from 'bun:test'
import { admitVaultRequest, controlReceiptSchema, hashVaultRequest } from './receipts'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin } from '@ficus/shared/managed-bigbrain'
import { planVaultStorage } from './storage'
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const binding = '33333333-3333-4333-8333-333333333333'
const create = {
  contractVersion: 1,
  tenantId: id,
  physicalHostBinding: binding,
  hostEpoch: 1,
  requestId: other,
  action: 'create',
  vaultId: id,
  expectedGeneration: 0,
  generation: 1,
  displayName: 'Research',
  owner: { userId: other, handle: 'ada', display: 'Ada' },
  origin: `https://bb-${id.replaceAll('-', '')}.example.com`,
  limits: {
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
  },
  upstreamCommit: pin,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
}
function receipt() {
  return controlReceiptSchema.parse({
    schema: 1,
    phase: 'reserved',
    displayName: create.displayName,
    owner: create.owner,
    receipt: {
      receiptId: other,
      tenantId: id,
      physicalHostBinding: binding,
      vaultId: id,
      hostEpoch: 1,
      generation: 1,
      upstreamVaultId: null,
      displayName: create.displayName,
      state: 'provisioning',
      upstreamCommit: pin,
      artifactDigest: create.artifactDigest,
      localPort: 30000,
      origin: create.origin,
      readAccess: 'pending',
    },
    operation: { requestId: other, action: 'create', inputHash: hashVaultRequest(create), expectedGeneration: 0 },
    storage: planVaultStorage({
      vaultId: id,
      existing: [],
      policy: { maxVaults: 2, perVaultDiskBytes: 536870912, minCoreFreeDiskBytes: 2147483648 },
      freeDiskBytes: 6 * 1024 ** 3,
    }),
    os: null,
  })
}
test('exact generation/request/body replay resumes recorded phases without duplicating identity', () => {
  expect(admitVaultRequest(create, null)).toBe('create')
  const current = receipt()
  expect(admitVaultRequest(create, current)).toBe('replay')
  // Transport epoch is separately admitted against current installed root state.
  expect(admitVaultRequest({ ...create, hostEpoch: 2 }, current)).toBe('replay')
  // Every compatible Core build repackages Ficus source and changes component digest.
  // Current installed digest admission remains mandatory; it is not a changed vault recipe.
  expect(admitVaultRequest({ ...create, artifactDigest: `sha256:${'b'.repeat(64)}` }, current)).toBe('replay')
  expect(() => admitVaultRequest({ ...create, displayName: 'Changed' }, current)).toThrow('request_conflict')
  expect(() => admitVaultRequest({ ...create, requestId: id }, current)).toThrow('generation_conflict')
})
test('fences old replay after newer generation and refuses another tenant/binding/vault', () => {
  const current = receipt()
  current.receipt.generation = 2
  current.operation.requestId = id
  expect(() => admitVaultRequest(create, current)).toThrow('generation_conflict')
  for (const change of [
    { tenantId: other },
    { vaultId: other, origin: `https://bb-${other.replaceAll('-', '')}.example.com` },
    { physicalHostBinding: id },
  ])
    expect(() => admitVaultRequest({ ...create, ...change }, receipt())).toThrow('identity_mismatch')
  expect(() => admitVaultRequest({ ...create, hostEpoch: 0 }, receipt())).toThrow('generation_conflict')
})
test('admits explicit next-generation transitions, never reuses create to overwrite existing data', () => {
  const rename = {
    ...create,
    action: 'rename',
    requestId: id,
    expectedGeneration: 1,
    generation: 2,
    displayName: 'Renamed',
  }
  const {
    owner: _owner,
    origin: _origin,
    limits: _limits,
    upstreamCommit: _pin,
    artifactDigest: _digest,
    ...input
  } = rename
  expect(admitVaultRequest(input, receipt())).toBe('advance')
  expect(() =>
    admitVaultRequest({ ...create, requestId: id, expectedGeneration: 1, generation: 2 }, receipt())
  ).toThrow('request_conflict')
  expect(() => admitVaultRequest(input, null)).toThrow('not_found')
})
test('hash is canonical and includes immutable operation recipe, not volatile transport epoch', () => {
  expect(hashVaultRequest(create)).toBe(hashVaultRequest(Object.fromEntries(Object.entries(create).reverse())))
  expect(hashVaultRequest(create)).toBe(hashVaultRequest({ ...create, hostEpoch: 2 }))
  expect(hashVaultRequest(create)).not.toBe(hashVaultRequest({ ...create, displayName: 'Different' }))
  expect(() => hashVaultRequest({ ...create, token: 'PRIVATE' })).toThrow('invalid_request')
  expect(controlReceiptSchema.safeParse({ ...receipt(), token: 'PRIVATE' }).success).toBe(false)
})

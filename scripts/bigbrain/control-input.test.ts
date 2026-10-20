import { expect, test } from 'bun:test'
import { readHostRequest, validateHostAdmission, installedHostSchema } from './control-input'
import { managedPaths } from './paths'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin } from '../../packages/shared/src/managed-bigbrain'

const tenantId = '11111111-1111-4111-8111-111111111111'
const vaultId = '22222222-2222-4222-8222-222222222222'
const physicalHostBinding = '33333333-3333-4333-8333-333333333333'
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
const installed = {
  contractVersion: 1,
  tenantId,
  physicalHostBinding,
  hostEpoch: 2,
  hostState: 'active',
  upstreamCommit: pin,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  zone: 'example.com',
  limits,
}
const probe = { contractVersion: 1, tenantId, physicalHostBinding, hostEpoch: 2, requestId: tenantId, action: 'probe' }
const create = {
  ...probe,
  action: 'create',
  vaultId,
  expectedGeneration: 0,
  generation: 1,
  displayName: 'Research',
  owner: { userId: tenantId, handle: 'ada', display: 'Ada' },
  origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
  limits,
  upstreamCommit: pin,
  artifactDigest: installed.artifactDigest,
}
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

test('incrementally caps helper stdin, cancels overflow and accepts one bounded JSON message', async () => {
  expect<unknown>(await readHostRequest(stream(new TextEncoder().encode(JSON.stringify(probe))))).toEqual(probe)
  let cancelled = false
  const large = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(4097))
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(readHostRequest(large)).rejects.toThrow('invalid_request')
  expect(cancelled).toBe(true)
  await expect(readHostRequest(stream(new Uint8Array([255])))).rejects.toThrow('invalid_request')
})
test('fixed paths use canonical full UUIDs and no caller-selected path/port', () => {
  const paths = managedPaths({ vaultId })
  expect(paths.mount).toBe(`/var/lib/ficus-bigbrain/vaults/${vaultId}`)
  expect(paths.memberStore).toBe(`/var/lib/ficus-bigbrain/vaults/${vaultId}/auth/members.json`)
  expect(paths.control).toBe(`/var/lib/ficus-bigbrain/control/${vaultId}`)
  expect(paths.handoff).toBe(`/var/lib/ficus-bigbrain/read-handoff/${vaultId}.json`)
  expect(managedPaths({ vaultId: tenantId }).mount).not.toBe(paths.mount)
  for (const bad of ['../other', vaultId.toUpperCase().replace('2', 'A'), '/etc', ''])
    expect(() => managedPaths({ vaultId: bad })).toThrow('invalid_request')
  expect(() => managedPaths({ vaultId, path: '/etc' } as never)).toThrow('invalid_request')
})
test('admits matching bound create and refuses foreign origin, pin, digest, identity or limits', () => {
  expect(installedHostSchema.safeParse(installed).success).toBe(true)
  expect(() => validateHostAdmission(create, installed)).not.toThrow()
  for (const change of [
    { tenantId: vaultId },
    { physicalHostBinding: tenantId },
    { hostEpoch: 1 },
    { origin: create.origin.replace('example.com', 'evil.com') },
    { artifactDigest: `sha256:${'b'.repeat(64)}` },
    { limits: { ...limits, maxVaults: 1 } },
    { upstreamCommit: 'main' },
  ]) {
    expect(() => validateHostAdmission({ ...create, ...change }, installed)).toThrow()
  }
})
test('exact applied/pending host lifecycle effect replay is admitted, not mistaken for a fresh epoch', () => {
  const request = { ...probe, action: 'suspend-tenant', hostEpoch: 3, previousHostEpoch: 2, effectId: vaultId }
  const current = {
    ...installed,
    hostEpoch: 3,
    hostState: 'suspended',
    effect: { action: 'suspend-tenant', effectId: vaultId, previousHostEpoch: 2, completed: true },
  }
  expect(() => validateHostAdmission(request, current)).not.toThrow()
  expect(() =>
    validateHostAdmission(request, { ...current, effect: { ...current.effect, completed: false } })
  ).not.toThrow()
  expect(() => validateHostAdmission({ ...request, action: 'resume-tenant' }, current)).toThrow('generation_conflict')
  expect(() => validateHostAdmission({ ...request, effectId: tenantId }, current)).toThrow('generation_conflict')
})

test('epoch changes require explicit previous fence; old host cannot adopt a replacement binding', () => {
  expect(() =>
    validateHostAdmission(
      { ...probe, action: 'suspend-tenant', hostEpoch: 3, previousHostEpoch: 2, effectId: vaultId },
      installed
    )
  ).not.toThrow()
  expect(() =>
    validateHostAdmission(
      { ...probe, action: 'suspend-tenant', hostEpoch: 3, previousHostEpoch: 1, effectId: vaultId },
      installed
    )
  ).toThrow('generation_conflict')
  expect(() => validateHostAdmission({ ...probe, physicalHostBinding: tenantId }, installed)).toThrow(
    'identity_mismatch'
  )
  expect(() => validateHostAdmission(create, { ...installed, hostState: 'suspended' })).toThrow('forbidden')
  expect(() =>
    validateHostAdmission({ ...probe, action: 'status', vaultId }, { ...installed, hostState: 'suspended' })
  ).not.toThrow()
})

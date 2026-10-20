// Pure, nonsecret test recipes. Never imported by the host executables.
import { controlReceiptSchema } from './receipts'
import { planVaultStorage } from './storage'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '../../packages/shared/src/managed-bigbrain'
export function reservedVaultFixture(root: string) {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const vaultId = '22222222-2222-4222-8222-222222222222'
  const binding = '33333333-3333-4333-8333-333333333333'
  return controlReceiptSchema.parse({
    schema: 1,
    phase: 'reserved',
    displayName: 'Research',
    owner: { userId: tenantId, handle: 'ada', display: 'Ada' },
    operation: { requestId: binding, action: 'create', inputHash: `sha256:${'a'.repeat(64)}`, expectedGeneration: 0 },
    receipt: {
      receiptId: binding,
      tenantId,
      physicalHostBinding: binding,
      vaultId,
      hostEpoch: 1,
      generation: 1,
      upstreamVaultId: null,
      state: 'provisioning',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      localPort: 30000,
      origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
      readAccess: 'pending',
    },
    storage: planVaultStorage({
      vaultId,
      root,
      existing: [],
      freeDiskBytes: 6 * 1024 ** 3,
      policy: { maxVaults: 2, perVaultDiskBytes: 16 * 1024 ** 2, minCoreFreeDiskBytes: 2 * 1024 ** 3 },
    }),
    os: null,
  })
}

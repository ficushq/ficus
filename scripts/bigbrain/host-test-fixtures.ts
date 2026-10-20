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

/** Synthetic (non-executable) artifact through the real builder/verifier with a fake toolchain. */
export async function syntheticArtifact(outDir: string): Promise<string> {
  const { buildBigbrainArtifact } = await import('./artifact')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const manifest = await buildBigbrainArtifact({
    outDir,
    bunVersion: '1.4.2',
    run: async (argv, cwd) => {
      if (argv[0] === 'bun' && argv.includes('--version')) return { code: 0, stdout: '1.4.2' }
      if (argv[0] === 'git' && argv.includes('rev-parse'))
        return { code: 0, stdout: MANAGED_BIGBRAIN_UPSTREAM_COMMIT + '\n' }
      if (argv[0] === 'git' && argv.includes('archive')) await writeFile(argv[argv.indexOf('--output') + 1]!, 'source')
      if (argv[0] === 'tar') {
        await mkdir(join(cwd, 'bin'), { recursive: true })
        await writeFile(join(cwd, 'LICENSE'), 'AGPL-3.0-only synthetic fixture')
        await writeFile(join(cwd, 'bun.lock'), 'locked')
      }
      if (argv.includes('--compile')) await writeFile(argv[argv.indexOf('--outfile') + 1]!, 'compiled:' + argv[2])
      return { code: 0, stdout: '' }
    },
  })
  return manifest.digest
}

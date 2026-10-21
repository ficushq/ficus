// Pure, nonsecret test recipes. Never imported by the host executables.
import { controlReceiptSchema } from './receipts'
import { planVaultStorage } from './storage'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { randomUUID } from 'node:crypto'
import { memberAdminReply } from './member-admin'
import { fakeMemberApi, fileIdentityApi } from './member-test-fixtures'
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
      displayName: 'Research',
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
      if (argv[0] === 'bun' && argv[1] === 'build') {
        const out = argv[argv.indexOf('--outdir') + 1]!
        const name = argv
          .find((a) => a.startsWith('--entry-naming='))!
          .slice('--entry-naming='.length)
          .replace('[ext]', 'js')
        await mkdir(out, { recursive: true })
        await writeFile(join(out, name), 'bundle:' + argv[2])
        if (argv[2] === 'bin/shared.ts' || argv[2] === '.ficus-serve-entry.ts')
          for (const font of ['hanken-grotesk-latin.woff2', 'hanken-grotesk-latin-ext.woff2'])
            await writeFile(join(out, font), font)
      }
      return { code: 0, stdout: '' }
    },
  })
  return manifest.digest
}

/** A simulated (unprivileged) host for pipeline tests: fake NSS/useradd, blkid/mkfs, systemd
 * and losetup answers; REAL fallocate-equivalent bytes, tar/find/chmod on temporary files;
 * chown recorded (not performed). This proves orchestration/ordering, never OS enforcement.
 */
export function simulatedHost(options: {
  root: string
  unitDirectory: string
  tenantId: string
  physicalHostBinding: string
  /** The id upstream generates for a vault's identity file (default: random, as upstream). */
  upstreamVaultId?: string
}) {
  // The shipped member adapter's vault identity operations on the real (temporary) vault files.
  const identity = fileIdentityApi(() => options.upstreamVaultId ?? randomUUID())
  const identityApi = fakeMemberApi(undefined, identity).api
  const accounts = new Map<string, { uid: number; gid: number; comment: string }>()
  const formatted = new Set<string>()
  const mounted = new Map<string, string>() // mount path -> image path
  const active = new Set<string>()
  const calls: string[][] = []
  let nextId = 1200
  const run = async (argv: string[], runOptions?: { input?: string }): Promise<{ code: number; stdout: string }> => {
    calls.push(argv)
    if (argv.some((a) => a.endsWith('/bigbrain-members.js'))) {
      const input = JSON.parse(runOptions?.input ?? 'null') as { op?: string } | null
      if (input?.op === 'vault-identity' || input?.op === 'vault-name')
        return { code: 0, stdout: `${JSON.stringify(memberAdminReply(input, identityApi))}\n` }
    }
    const { stat, open } = await import('node:fs/promises')
    const { managedIdentityNames } = await import('./accounts')
    const [cmd, ...args] = argv
    if (cmd === '/usr/bin/getent') {
      const entry = [...accounts.entries()].find(
        ([name, a]) => name === args[1] || String(args[0] === 'passwd' ? a.uid : a.gid) === args[1]
      )
      if (!entry) return { code: 2, stdout: '' }
      const [name, a] = entry
      return {
        code: 0,
        stdout:
          args[0] === 'passwd'
            ? `${name}:x:${a.uid}:${a.gid}:${a.comment}:/nonexistent:/usr/sbin/nologin\n`
            : `${name}:x:${a.gid}:\n`,
      }
    }
    if (cmd === '/usr/sbin/useradd') {
      const name = argv.at(-1)!
      const comment = argv[argv.indexOf('--comment') + 1] ?? argv[argv.indexOf('-c') + 1]!
      accounts.set(name, { uid: nextId, gid: nextId + 1, comment })
      nextId += 2
      return { code: 0, stdout: '' }
    }
    if (cmd === '/usr/sbin/blkid') {
      const image = argv.at(-1)!
      const vaultId = image.split('/').at(-1)!.replace('.img', '')
      return formatted.has(image) ? { code: 0, stdout: `TYPE=ext4\nUUID=${vaultId}\n` } : { code: 2, stdout: '' }
    }
    if (cmd === '/usr/bin/fallocate') {
      const image = argv.at(-1)!
      const length = Number(argv[argv.indexOf('--length') + 1] ?? argv[argv.indexOf('-l') + 1])
      const file = await open(image, 'r+')
      try {
        const block = Buffer.alloc(65536)
        for (let p = 4096; p < length; p += block.length)
          await file.write(block, 0, Math.min(block.length, length - p), p)
        await file.sync()
      } finally {
        await file.close()
      }
      return { code: 0, stdout: '' }
    }
    if (cmd === '/usr/sbin/mkfs.ext4') {
      formatted.add(argv.at(-1)!)
      return { code: 0, stdout: '' }
    }
    if (cmd === '/usr/bin/systemctl') {
      const unit = argv.at(-1)!
      if (args[0] === 'show')
        return { code: 0, stdout: `FragmentPath=${options.unitDirectory}/${unit}\nDropInPaths=\nLoadState=loaded\n` }
      if (args[0] === 'start' && unit.endsWith('.mount')) {
        const vaultId = unit.match(/vaults-(.+)\.mount$/)![1]!.replaceAll('\\x2d', '-')
        mounted.set(`${options.root}/vaults/${vaultId}`, `${options.root}/volumes/${vaultId}.img`)
      }
      if (args[0] === 'start' || (args[0] === 'enable' && args[1] === '--now')) active.add(unit)
      if (args[0] === 'stop') active.delete(unit)
      if (args[0] === 'is-active') return { code: active.has(unit) ? 0 : 3, stdout: '' }
      return { code: 0, stdout: '' }
    }
    if (cmd === '/usr/sbin/losetup') {
      // Each mounted image gets its own loop device, /dev/loop4, /dev/loop5, ... in mount order.
      const index = Math.max(0, Number(argv.at(-1)!.replace('/dev/loop', '')) - 4)
      const image = [...mounted.values()][index] ?? [...mounted.values()][0]!
      const info = await stat(image)
      const device = BigInt(info.dev)
      const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)
      const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
      return {
        code: 0,
        stdout: JSON.stringify({
          loopdevices: [
            {
              name: `/dev/loop${index + 4}`,
              'back-file': image,
              'back-ino': info.ino,
              'back-maj:min': `${major}:${minor}`,
            },
          ],
        }),
      }
    }
    if (cmd === '/usr/bin/tar' || cmd === '/usr/bin/find' || cmd === '/usr/bin/chmod') {
      const proc = Bun.spawn([cmd.split('/').at(-1)!, ...args], { stdout: 'ignore', stderr: 'ignore' })
      return { code: await proc.exited, stdout: '' }
    }
    return { code: 0, stdout: '' }
  }
  return {
    run,
    calls,
    /** Every upstream identity write (path, content, mode) the adapter made. */
    identityWrites: identity.writes,
    accounts,
    active,
    names: (vaultId: string) => async () =>
      (await import('./accounts')).managedIdentityNames({
        tenantId: options.tenantId,
        physicalHostBinding: options.physicalHostBinding,
        vaultId,
      }),
    mountinfo: async () =>
      [...mounted.keys()]
        .map((m, i) => `1 0 7:${i + 4} / ${m} rw,nodev,nosuid,noexec - ext4 /dev/loop${i + 4} rw`)
        .join('\n'),
    prepareLayout: async (path: string) => {
      const { mkdir } = await import('node:fs/promises')
      for (const dir of ['auth', 'vault']) await mkdir(`${path}/${dir}`, { recursive: true, mode: 0o700 })
    },
  }
}

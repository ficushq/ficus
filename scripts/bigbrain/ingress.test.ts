import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
} from '../../packages/shared/src/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { reservedVaultFixture } from './host-test-fixtures'
import { publishIngress, renderVaultSite } from './ingress'
import { managedPaths } from './paths'
import { controlReceiptSchema } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { initializeStorageNamespace } from './volume-image'
import type { PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const A = '22222222-2222-4222-8222-222222222222'
const B = '44444444-4444-4444-8444-444444444444'
const hex = (id: string) => id.replaceAll('-', '')

async function fixture(options: { caddyValid?: boolean } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-ingress-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const etc = join(outer, 'etc')
  await initializeStorageNamespace({ root, uid })
  await mkdir(etc, { mode: 0o700 })
  await mkdir(join(etc, 'public'), { mode: 0o755 })
  await mkdir(join(etc, 'caddy'), { mode: 0o755 })
  const base = reservedVaultFixture(root)
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: base.receipt.tenantId,
      physicalHostBinding: base.receipt.physicalHostBinding,
      hostEpoch: 4,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: base.receipt.artifactDigest,
      zone: 'example.com',
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  for (const [vaultId, phase, port] of [
    [A, 'ready', 30000],
    [B, 'reader_ready', 30001],
  ] as const) {
    const paths = managedPaths({ root, vaultId })
    await ensureOwnedDirectory(paths.control, 0o700, { uid })
    await writePrivateJson(
      paths.control,
      'receipt.json',
      controlReceiptSchema.parse({
        ...base,
        phase,
        receipt: {
          ...base.receipt,
          vaultId,
          localPort: port,
          upstreamVaultId: '66666666-6666-4666-8666-666666666666',
          state: phase === 'ready' ? 'ready' : 'provisioning',
          origin: `https://bb-${hex(vaultId)}.example.com`,
        },
        storage: {
          ...base.storage,
          vaultId,
          port,
          mount: paths.mount,
          image: paths.image,
          username: `bbv_${hex(vaultId).slice(0, 24)}`,
        },
        os: { uid: 1200, gid: 1201, imageDevice: 1, imageInode: 2, mountDevice: '7:4' },
      }),
      controlReceiptSchema,
      { uid }
    )
  }
  const calls: string[] = []
  const run: PrivateCommandRunner = async (argv) => {
    calls.push(argv.slice(0, 2).join(' '))
    return { code: argv[1] === 'validate' && options.caddyValid === false ? 1 : 0, stdout: '' }
  }
  return { root, etc, uid, run, calls, opts: { root, etc, uid, run } }
}

test('publishes only ready vaults as credential-free routes and exact-host Caddy sites, then validates and reloads', async () => {
  const f = await fixture()
  const manifest = await publishIngress(f.opts)
  expect(manifest).toMatchObject({
    hostEpoch: 4,
    hostState: 'active',
    routes: [{ vaultId: A, localPort: 30000, state: 'ready' }],
  })
  expect(JSON.parse(await readFile(join(f.etc, 'public', 'routes.json'), 'utf8')).routes).toHaveLength(1)
  expect(await readdir(join(f.etc, 'caddy'))).toEqual([`${A}.caddy`])
  const site = await readFile(join(f.etc, 'caddy', `${A}.caddy`), 'utf8')
  expect(site).toStartWith(`bb-${hex(A)}.example.com {`)
  expect(site).toContain('reverse_proxy 127.0.0.1:34792')
  expect(site).not.toMatch(/token|sv_|30000/)
  expect(f.calls).toEqual(['/usr/bin/caddy validate', '/usr/bin/systemctl reload'])
  f.calls.length = 0
  await publishIngress(f.opts)
  expect(f.calls).toEqual([])
})

test('a suspended host keeps disabled routes for the gateway and removes every public site', async () => {
  const f = await fixture()
  await publishIngress(f.opts)
  const host = await readPrivateJson(f.etc, 'host.json', installedHostSchema, { uid })
  await writePrivateJson(f.etc, 'host.json', { ...host, hostState: 'suspended' }, installedHostSchema, { uid })
  const manifest = await publishIngress(f.opts)
  expect(manifest.routes.map((r) => r.state)).toEqual(['disabled'])
  expect(await readdir(join(f.etc, 'caddy'))).toEqual([])
})

test('a Caddy rejection restores the previous sites; foreign files in the include directory are refused', async () => {
  const bad = await fixture({ caddyValid: false })
  await expect(publishIngress(bad.opts)).rejects.toThrow('tls_unavailable')
  expect(await readdir(join(bad.etc, 'caddy'))).toEqual([])
  const foreign = await fixture()
  await writeFile(join(foreign.etc, 'caddy', 'evil.caddy'), 'x', { mode: 0o644 })
  await expect(publishIngress(foreign.opts)).rejects.toThrow('identity_mismatch')
})

test('site rendering accepts only managed vault hosts and plain certificate paths', () => {
  expect(() => renderVaultSite('https://example.com', '/c', '/k')).toThrow('invalid_request')
  expect(() => renderVaultSite(`https://bb-${hex(A)}.example.com`, '/c {\n}', '/k')).toThrow('invalid_request')
})

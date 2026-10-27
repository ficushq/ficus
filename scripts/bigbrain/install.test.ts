import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS } from '@ficus/shared/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { readPrivateJson, writePrivateJson } from './secure-files'
import { syntheticArtifact } from './host-test-fixtures'
import { installManagedHost, parseInstallArgs } from './install'
import { caddySitesDirectory } from './ingress'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const config = {
  enabled: true,
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '33333333-3333-4333-8333-333333333333',
  hostEpoch: 3,
  zone: 'bigbrain.example.com',
}
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-install-'))
  roots.push(outer)
  const artifactRoot = join(outer, 'artifact')
  const digest = await syntheticArtifact(artifactRoot)
  let probes = 0
  const bunChecks: string[] = []
  const steps: string[] = []
  const options = {
    config,
    artifactRoot,
    etc: join(outer, 'etc'),
    opt: join(outer, 'opt'),
    state: join(outer, 'state'),
    uid,
    probeHost: async () => {
      probes++
    },
    hostBun: async (version: string) => {
      bunChecks.push(version)
    },
    ingress: async () => void steps.push('ingress'),
    hostAssets: async (digest: string) => void steps.push(`assets:${digest}`),
  }
  return { outer, options, digest, probes: () => probes, bunChecks, steps }
}
const host = (f: Awaited<ReturnType<typeof fixture>>) =>
  readPrivateJson(f.options.etc, 'host.json', installedHostSchema, { uid })

test('a missing shared parent of the config directory is created; an unsafe existing one refuses', async () => {
  const f = await fixture()
  const etc = join(f.outer, 'missing-parent', 'bigbrain')
  expect(await installManagedHost({ ...f.options, etc })).toMatchObject({ installed: true, created: true })
  const g = await fixture()
  const { mkdir, chmod } = await import('node:fs/promises')
  await mkdir(join(g.outer, 'unsafe'), { mode: 0o777 })
  await chmod(join(g.outer, 'unsafe'), 0o777)
  await expect(installManagedHost({ ...g.options, etc: join(g.outer, 'unsafe', 'bigbrain') })).rejects.toThrow(
    'storage_unavailable'
  )
})

test('vault Caddy sites get a Caddy-readable directory beside etc; legacy sites inside etc are removed', async () => {
  const f = await fixture()
  const { mkdir, readdir } = await import('node:fs/promises')
  // An upgraded host: earlier releases wrote sites inside the root-only etc directory.
  await mkdir(join(f.options.etc, 'caddy'), { recursive: true, mode: 0o755 })
  await writeFile(join(f.options.etc, 'caddy', '22222222-2222-4222-8222-222222222222.caddy'), 'x', { mode: 0o644 })
  await chmod(f.options.etc, 0o700)
  expect(await installManagedHost(f.options)).toMatchObject({ installed: true })
  const sites = caddySitesDirectory(f.options.etc)
  expect(sites).toBe(join(f.outer, 'bigbrain-caddy'))
  expect((await stat(sites)).mode & 0o777).toBe(0o755)
  expect((await stat(f.options.etc)).mode & 0o777).toBe(0o700)
  expect(await readdir(f.options.etc)).not.toContain('caddy')
  // Anything foreign in the legacy directory is left for an operator, never deleted blindly.
  const g = await fixture()
  await mkdir(join(g.options.etc, 'caddy'), { recursive: true, mode: 0o755 })
  await writeFile(join(g.options.etc, 'caddy', 'operator-notes.txt'), 'keep', { mode: 0o644 })
  await chmod(g.options.etc, 0o700)
  await installManagedHost(g.options)
  expect(await readdir(join(g.options.etc, 'caddy'))).toEqual(['operator-notes.txt'])
})

test('disabled is a no-op that writes nothing and never probes', async () => {
  const f = await fixture()
  expect(await installManagedHost({ ...f.options, config: { enabled: false } })).toEqual({ installed: false })
  expect(f.probes()).toBe(0)
  await expect(stat(f.options.etc)).rejects.toThrow()
  await expect(stat(f.options.opt)).rejects.toThrow()
})

test('first install seeds the host record from the persisted binding and installs an immutable verified release', async () => {
  const f = await fixture()
  const result = await installManagedHost(f.options)
  expect(result).toEqual({
    installed: true,
    created: true,
    artifactDigest: f.digest,
    hostEpoch: 3,
    hostState: 'active',
    // A new host has no vaults to repair (the real repair ran over the empty state).
    vaultNames: { repaired: 0, failed: 0 },
  })
  expect(await host(f)).toMatchObject({
    tenantId: config.tenantId,
    physicalHostBinding: config.physicalHostBinding,
    hostEpoch: 3,
    zone: config.zone,
    hostState: 'active',
    effect: null,
    limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  })
  const release = join(f.options.opt, 'releases', f.digest.slice(7))
  expect((await stat(release)).mode & 0o777).toBe(0o755)
  expect((await stat(join(release, 'bigbrain-shared.js'))).mode & 0o777).toBe(0o644)
  expect(f.bunChecks).toEqual(['1.4.2'])
  // Routes/sites are derived first, then the release-bound launcher/units/gateway.
  expect(f.steps).toEqual(['ingress', `assets:${f.digest}`])
  expect((await stat(join(release, 'LICENSE'))).mode & 0o777).toBe(0o644)
  expect((await stat(join(f.options.etc, 'host.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(f.options.state, 'control'))).mode & 0o777).toBe(0o700)
})

test('re-run/upgrade keeps the authoritative epoch, state and pending effect; config epoch never rewinds it', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  const advanced = {
    ...(await host(f)),
    hostEpoch: 9,
    hostState: 'suspended' as const,
    effect: {
      action: 'suspend-tenant' as const,
      effectId: '44444444-4444-4444-8444-444444444444',
      previousHostEpoch: 8,
      completed: true,
    },
  }
  await writePrivateJson(f.options.etc, 'host.json', advanced, installedHostSchema, { uid })
  const result = await installManagedHost({
    ...f.options,
    config: { ...config, hostEpoch: 0, zone: 'moved.example.org' },
  })
  expect(result).toMatchObject({ created: false, hostEpoch: 9, hostState: 'suspended' })
  expect(await host(f)).toEqual({ ...advanced, zone: 'moved.example.org' })
})

test('the Platform-written tenant label is recorded and follows config on re-run (new vaults only)', async () => {
  const f = await fixture()
  expect((await host(f).catch(() => null))?.tenantLabel).toBeUndefined()
  await installManagedHost({ ...f.options, config: { ...config, tenantLabel: 'acme' } })
  expect((await host(f)).tenantLabel).toBe('acme')
  await installManagedHost({ ...f.options, config: { ...config, tenantLabel: 'acme-renamed' } })
  expect((await host(f)).tenantLabel).toBe('acme-renamed')
  await installManagedHost(f.options)
  expect((await host(f)).tenantLabel).toBeNull()
  await expect(installManagedHost({ ...f.options, config: { ...config, tenantLabel: 'bb-acme' } })).rejects.toThrow()
})

test('a different tenant/binding is never adopted and nothing is written; disabling an installed host refuses', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  const before = await readFile(join(f.options.etc, 'host.json'), 'utf8')
  for (const changed of [
    { physicalHostBinding: '55555555-5555-4555-8555-555555555555' },
    { tenantId: '66666666-6666-4666-8666-666666666666' },
  ])
    await expect(installManagedHost({ ...f.options, config: { ...config, ...changed } })).rejects.toThrow(
      'identity_mismatch'
    )
  await expect(installManagedHost({ ...f.options, config: { enabled: false } })).rejects.toThrow('forbidden')
  expect(await readFile(join(f.options.etc, 'host.json'), 'utf8')).toBe(before)
  expect(f.probes()).toBe(1)
})

test('destroyed host records are never revived by setup', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  await writePrivateJson(
    f.options.etc,
    'host.json',
    { ...(await host(f)), hostState: 'deleted' },
    installedHostSchema,
    { uid }
  )
  await expect(installManagedHost(f.options)).rejects.toThrow('forbidden')
})

test("a host Bun that differs from the artifact's recorded version installs nothing", async () => {
  const f = await fixture()
  await expect(
    installManagedHost({
      ...f.options,
      hostBun: async () => {
        throw new Error('unsupported_host')
      },
    })
  ).rejects.toThrow('unsupported_host')
  await expect(stat(f.options.opt)).rejects.toThrow()
  await expect(stat(join(f.options.etc, 'host.json'))).rejects.toThrow()
})

test('unsupported host or invalid artifact publishes no host record', async () => {
  const f = await fixture()
  await expect(
    installManagedHost({
      ...f.options,
      probeHost: async () => {
        throw new Error('unsupported_host')
      },
    })
  ).rejects.toThrow('unsupported_host')
  await writeFile(join(f.options.artifactRoot, 'bigbrain-shared.js'), 'tampered')
  await expect(installManagedHost(f.options)).rejects.toThrow('artifact_invalid')
  await expect(stat(join(f.options.etc, 'host.json'))).rejects.toThrow()
})

test('a tampered or group-writable existing release is never reused', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  const release = join(f.options.opt, 'releases', f.digest.slice(7))
  await chmod(join(release, 'LICENSE'), 0o664)
  await expect(installManagedHost(f.options)).rejects.toThrow('identity_mismatch')
  await chmod(join(release, 'LICENSE'), 0o644)
  await writeFile(join(release, 'bigbrain-owner-link.js'), 'swapped')
  await expect(installManagedHost(f.options)).rejects.toThrow('identity_mismatch')
})

test('an upgrade repairs vault server names after the new release is installed, and reports, not fails, a failed repair', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  const seen: { artifactDigest: string; hostEpoch: number }[] = []
  const upgraded = await installManagedHost({
    ...f.options,
    vaultNames: async (installed) => {
      // Runs last: the new release, launcher and gateway are in place and the host record is written.
      f.steps.push('names')
      seen.push(installed)
      expect(await host(f)).toEqual(installed)
      return { repaired: 1, failed: 1 }
    },
  })
  expect(f.steps.slice(-3)).toEqual(['ingress', `assets:${f.digest}`, 'names'])
  expect(seen[0]).toMatchObject({ artifactDigest: f.digest, hostEpoch: 3, hostState: 'active' })
  expect(upgraded).toMatchObject({ installed: true, created: false, vaultNames: { repaired: 1, failed: 1 } })
})

test('with a Core account: the host record and the read handoffs are shared read-only with its group', async () => {
  const f = await fixture()
  const gid = process.getgid!()
  // A host installed for a root Core, with a handoff written then (root-only): it becomes readable too.
  await installManagedHost(f.options)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(f.options.state, 'read-handoff'), { mode: 0o700 })
  await writeFile(join(f.options.state, 'read-handoff', '22222222-2222-4222-8222-222222222222.json'), '{}', {
    mode: 0o600,
  })
  await installManagedHost({ ...f.options, coreGid: gid })
  const etc = await stat(f.options.etc)
  expect([etc.mode & 0o7777, etc.gid]).toEqual([0o750, gid])
  const record = await stat(join(f.options.etc, 'host.json'))
  expect([record.mode & 0o777, record.gid]).toEqual([0o640, gid])
  const handoffs = await stat(join(f.options.state, 'read-handoff'))
  expect([handoffs.mode & 0o7777, handoffs.gid]).toEqual([0o750, gid])
  const old = await stat(join(f.options.state, 'read-handoff', '22222222-2222-4222-8222-222222222222.json'))
  expect([old.mode & 0o777, old.gid]).toEqual([0o640, gid])
  // Root-side readers accept the shared record; a later install without the account keeps it.
  expect((await host(f)).tenantId).toBe(config.tenantId)
  expect(await installManagedHost(f.options)).toMatchObject({ installed: true, created: false })
  expect((await stat(f.options.etc)).mode & 0o7777).toBe(0o750)
  expect((await stat(join(f.options.etc, 'host.json'))).mode & 0o777).toBe(0o640)
})

test('without a Core account the host record stays root-only (0700 / 0600)', async () => {
  const f = await fixture()
  await installManagedHost(f.options)
  expect((await stat(f.options.etc)).mode & 0o7777).toBe(0o700)
  expect((await stat(join(f.options.etc, 'host.json'))).mode & 0o777).toBe(0o600)
})

test('the installer takes no argument, or exactly --core-account <a non-root login name>', () => {
  expect(parseInstallArgs([])).toEqual({})
  expect(parseInstallArgs(['--core-account', 'ficus'])).toEqual({ coreAccount: 'ficus' })
  for (const bad of [
    ['--core-account'],
    ['--core-account', 'root'],
    ['--core-account', 'Ficus'],
    ['--core-account', '../x'],
    ['--core-account', 'ficus', 'extra'],
    ['--other', 'ficus'],
  ])
    expect(() => parseInstallArgs(bad)).toThrow('invalid_request')
})

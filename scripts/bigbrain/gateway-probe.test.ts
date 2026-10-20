import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedBigbrainVaultOrigin } from '@ficus/shared/managed-bigbrain'
import { createGatewayHandler, type GatewayManifest } from './gateway-policy'
import {
  gatewayScript,
  gatewaySocketRequest,
  vaultServeScript,
  verifyGatewayServes,
  verifyHostServing,
  verifyRunningRelease,
  waitForGatewayServing,
} from './gateway-probe'
import type { PrivateCommandRunner } from './process'
import type { ControlReceipt } from './receipts'

const A = '3294c8f0-f133-4a1b-8c2d-0123456789ab'
const B = '7b0a25fe-1d6a-4c3b-9d4e-abcdefabcdef'
const UPSTREAM = '77777777-7777-4777-8777-777777777777'
const D1 = `sha256:${'a'.repeat(64)}`
const D2 = `sha256:${'b'.repeat(64)}`
// The outage's shape: a tenant-prefixed hostname (<tenant>-bb-<12 hex>) beside a bb-<32 hex> one.
const ORIGIN_A = managedBigbrainVaultOrigin({ vaultId: A, zone: 'example.com', tenantLabel: 'noah' })
const ORIGIN_B = managedBigbrainVaultOrigin({ vaultId: B, zone: 'example.com', tenantLabel: null })
const manifest: GatewayManifest = {
  contractVersion: 1,
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '22222222-2222-4222-8222-222222222222',
  hostEpoch: 1,
  hostState: 'active',
  routes: [
    { vaultId: A, upstreamVaultId: UPSTREAM, origin: ORIGIN_A, state: 'ready' },
    { vaultId: B, upstreamVaultId: UPSTREAM, origin: ORIGIN_B, state: 'ready' },
  ],
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})
async function sockets() {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-gateway-probe-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}
/** Stand-in for the native vault: credential-free whoami is 401 with the shared protocol. */
function vault(socket: string, protocol: string | null = '1') {
  const seen: { authorization: string | null; cookie: string | null; host: string | null }[] = []
  const server = Bun.serve({
    unix: socket,
    fetch: (request) => {
      seen.push({
        authorization: request.headers.get('authorization'),
        cookie: request.headers.get('cookie'),
        host: request.headers.get('host'),
      })
      return Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: protocol ? { 'BigBrain-Protocol': protocol } : {} }
      )
    },
  })
  cleanup.push(() => server.stop(true))
  return seen
}
/** The SHIPPED gateway policy on a real Unix socket; `read` is what this gateway process gets
 * when it reads the route manifest. */
function gateway(socket: string, read: () => Promise<unknown>, vaultSocket: (id: string) => string) {
  const server = Bun.serve({
    unix: socket,
    fetch: createGatewayHandler({ manifest: read, socketPath: vaultSocket }),
  })
  cleanup.push(() => server.stop(true))
}

test('a gateway that serves the manifest passes: unrouted host 404, each ready route 401 + protocol, no credential sent', async () => {
  const root = await sockets()
  const seenA = vault(join(root, 'a.sock'))
  const seenB = vault(join(root, 'b.sock'))
  gateway(
    join(root, 'gw.sock'),
    async () => manifest,
    (id) => join(root, id === A ? 'a.sock' : 'b.sock')
  )
  await verifyGatewayServes(manifest, { request: gatewaySocketRequest(join(root, 'gw.sock')) })
  expect(seenA).toEqual([{ authorization: null, cookie: null, host: new URL(ORIGIN_A).hostname }])
  expect(seenB).toEqual([{ authorization: null, cookie: null, host: new URL(ORIGIN_B).hostname }])
  // Scoped: owner-invite checks only its own vault.
  await verifyGatewayServes(manifest, { vaultIds: [A], request: gatewaySocketRequest(join(root, 'gw.sock')) })
  expect(seenA).toHaveLength(2)
  expect(seenB).toHaveLength(1)
})

test('regression: an active gateway process that cannot load the manifest (stale release) is not serving', async () => {
  const root = await sockets()
  vault(join(root, 'a.sock'))
  // What the pre-upgrade gateway did with the tenant-prefixed manifest: its route schema rejected
  // it, so every vault host got 503 not_installed although the unit was active.
  gateway(
    join(root, 'gw.sock'),
    async () => {
      throw new Error('invalid_response')
    },
    () => join(root, 'a.sock')
  )
  const request = gatewaySocketRequest(join(root, 'gw.sock'))
  expect(await request(new URL(ORIGIN_A).hostname, '/v1/whoami')).toEqual({
    status: 503,
    code: 'not_installed',
    protocol: null,
  })
  await expect(verifyGatewayServes(manifest, { request })).rejects.toThrow('upstream_unavailable')
  await expect(waitForGatewayServing(manifest, { request, sleep: async () => {}, attempts: 3 })).rejects.toThrow(
    'upstream_unavailable'
  )
})

test('a ready route the gateway cannot serve, or that answers without the BigBrain protocol, is not serving', async () => {
  const root = await sockets()
  vault(join(root, 'a.sock'))
  vault(join(root, 'plain.sock'), null)
  // B's vault socket does not exist: the gateway answers 503 upstream_unavailable.
  gateway(
    join(root, 'gw.sock'),
    async () => manifest,
    (id) => join(root, id === A ? 'a.sock' : 'missing.sock')
  )
  const request = gatewaySocketRequest(join(root, 'gw.sock'))
  await expect(verifyGatewayServes(manifest, { request })).rejects.toThrow('upstream_unavailable')
  await verifyGatewayServes(manifest, { vaultIds: [A], request })
  // A route the RUNNING gateway does not know (published after it loaded an older manifest).
  const older = { ...manifest, routes: [manifest.routes[1]!] }
  gateway(
    join(root, 'gw-older.sock'),
    async () => older,
    () => join(root, 'a.sock')
  )
  await expect(
    verifyGatewayServes(manifest, { vaultIds: [A], request: gatewaySocketRequest(join(root, 'gw-older.sock')) })
  ).rejects.toThrow('upstream_unavailable')
  // A 401 without the shared protocol is not the vault.
  gateway(
    join(root, 'gw-plain.sock'),
    async () => manifest,
    () => join(root, 'plain.sock')
  )
  await expect(
    verifyGatewayServes(manifest, { vaultIds: [A], request: gatewaySocketRequest(join(root, 'gw-plain.sock')) })
  ).rejects.toThrow('upstream_unavailable')
  // No gateway process at all.
  await expect(
    verifyGatewayServes(manifest, { request: gatewaySocketRequest(join(root, 'absent.sock')) })
  ).rejects.toThrow('upstream_unavailable')
})

test('a suspended host: the gateway has loaded the manifest when it answers its own 503 maintenance', async () => {
  const root = await sockets()
  const suspended: GatewayManifest = {
    ...manifest,
    hostState: 'suspended',
    routes: manifest.routes.map((r) => ({ ...r, state: 'disabled' as const })),
  }
  gateway(
    join(root, 'gw.sock'),
    async () => suspended,
    () => join(root, 'none.sock')
  )
  const request = gatewaySocketRequest(join(root, 'gw.sock'))
  await verifyGatewayServes(suspended, { request })
  await waitForGatewayServing(suspended, { request, sleep: async () => {}, attempts: 1 })
  // ...but a 503 maintenance is not proof for an active host.
  await expect(verifyGatewayServes(manifest, { request })).rejects.toThrow('upstream_unavailable')
})

test('the gateway rate limit on a found route is not unavailability; disabled routes are skipped', async () => {
  const asked: string[] = []
  await verifyGatewayServes(
    { ...manifest, routes: [{ ...manifest.routes[0]!, state: 'disabled' }, manifest.routes[1]!] },
    {
      request: async (host) => {
        asked.push(host)
        return host === 'gateway-probe.invalid'
          ? { status: 404, code: 'not_found', protocol: null }
          : { status: 429, code: null, protocol: null }
      },
    }
  )
  expect(asked).toEqual(['gateway-probe.invalid', new URL(ORIGIN_B).hostname])
})

test('waiting for a just-restarted gateway retries until it serves, and needs only the manifest load', async () => {
  let calls = 0
  await waitForGatewayServing(manifest, {
    sleep: async () => {},
    request: async (host) => {
      calls++
      if (host !== 'gateway-probe.invalid') throw new Error('route checked during install')
      return calls < 3 ? { status: 0, code: null, protocol: null } : { status: 404, code: 'not_found', protocol: null }
    },
  })
  expect(calls).toBe(3)
})

function systemd(pids: Record<string, number>): PrivateCommandRunner {
  return async (argv) =>
    argv[1] === 'show' && argv.at(-2) === '--value'
      ? { code: 0, stdout: `${pids[argv.at(-1)!] ?? 0}\n` }
      : { code: 1, stdout: '' }
}
const bunArgv = (script: string, ...rest: string[]) => [
  '/usr/local/bin/bun',
  '--no-install',
  '--no-env-file',
  script,
  ...rest,
]

test('the running main process must execute the bound release, not merely the rewritten unit', async () => {
  const run = systemd({ 'ficus-bigbrain-gateway.service': 4242 })
  const cmdline = async (pid: number) => (pid === 4242 ? bunArgv(gatewayScript(D2), 'gateway') : [])
  await verifyRunningRelease('ficus-bigbrain-gateway.service', gatewayScript(D2), { run, cmdline })
  // The outage: the unit file names release B, the process still runs release A.
  await expect(
    verifyRunningRelease('ficus-bigbrain-gateway.service', gatewayScript(D2), {
      run,
      cmdline: async () => bunArgv(gatewayScript(D1), 'gateway'),
    })
  ).rejects.toThrow('upstream_unavailable')
  // No main process (stopped unit) or an unreadable process.
  await expect(verifyRunningRelease('other.service', gatewayScript(D2), { run, cmdline })).rejects.toThrow(
    'upstream_unavailable'
  )
  await expect(
    verifyRunningRelease('ficus-bigbrain-gateway.service', gatewayScript(D2), {
      run,
      cmdline: async () => {
        throw new Error('ENOENT')
      },
    })
  ).rejects.toThrow('upstream_unavailable')
})

test('host serving: gateway on the installed release, each ready vault on its recorded release, then the wire', async () => {
  const record = (vaultId: string, artifactDigest: string) =>
    ({ receipt: { vaultId, artifactDigest } }) as unknown as ControlReceipt
  const pids = {
    'ficus-bigbrain-gateway.service': 10,
    [`ficus-bigbrain@${A}.service`]: 11,
    [`ficus-bigbrain@${B}.service`]: 12,
  }
  const argv: Record<number, string[]> = {
    10: bunArgv(gatewayScript(D2), 'gateway'),
    11: bunArgv(vaultServeScript(D1), '--vault', '/x'), // vaults keep the release they were created on
    12: bunArgv(vaultServeScript(D2), '--vault', '/y'),
  }
  const wire: string[] = []
  const input = {
    artifactDigest: D2,
    records: [record(A, D1), record(B, D2)],
    manifest: async () => manifest,
    run: systemd(pids),
    cmdline: async (pid: number) => argv[pid] ?? [],
    request: async (host: string) => {
      wire.push(host)
      return host === 'gateway-probe.invalid'
        ? { status: 404, code: 'not_found', protocol: null }
        : { status: 401, code: null, protocol: '1' }
    },
  }
  await verifyHostServing(input)
  expect(wire).toHaveLength(3)
  await expect(verifyHostServing({ ...input, artifactDigest: D1 })).rejects.toThrow('upstream_unavailable')
  await expect(verifyHostServing({ ...input, records: [record(A, D2), record(B, D2)] })).rejects.toThrow(
    'upstream_unavailable'
  )
  await expect(verifyHostServing({ ...input, records: [record(B, D2)] })).rejects.toThrow('upstream_unavailable')
  await expect(
    verifyHostServing({
      ...input,
      manifest: async () => {
        throw new Error('storage_unavailable')
      },
    })
  ).rejects.toThrow('upstream_unavailable')
})

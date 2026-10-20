import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_SHARED_PROTOCOL } from '@ficus/shared/managed-bigbrain'
import { noteStage } from './diagnostics'
import { GATEWAY_SOCKET, gatewayManifestSchema, type GatewayManifest } from './gateway-policy'
import { GATEWAY_UNIT, managedPaths } from './paths'
import type { PrivateCommandRunner } from './process'
import type { ControlReceipt } from './receipts'
import { readPublicJson } from './secure-files'
import { artifactRoot } from './units'

/** Reserved by RFC 2606: no route manifest can ever name it, so the gateway's only correct answer
 * for it is its own 404 `not_found`, which it gives only after reading and parsing the manifest. */
const UNROUTED_HOST = 'gateway-probe.invalid'

/** One credential-free request to the RUNNING gateway, routed by Host only. Never carries an
 * Authorization header, cookie or body; only the status, the gateway's own refusal code and the
 * upstream protocol header are kept. */
export type GatewayRequest = (
  host: string,
  path: string
) => Promise<{ status: number; code: string | null; protocol: string | null }>

export function gatewaySocketRequest(socket = GATEWAY_SOCKET): GatewayRequest {
  return async (host, path) => {
    const response = await fetch(`http://${host}${path}`, {
      unix: socket,
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    })
    let code: string | null = null
    // Only the gateway's own fixed refusals are JSON {code}; anything else is discarded unread.
    if (response.status === 404 || response.status === 503) {
      const text = await response.text().catch(() => '')
      const match = text.length <= 64 ? /^\{"code":"([a-z_]{1,40})"\}$/.exec(text) : null
      code = match?.[1] ?? null
    } else await response.body?.cancel().catch(() => {})
    return { status: response.status, code, protocol: response.headers.get('BigBrain-Protocol') }
  }
}

/** The route manifest exactly as the gateway reads it (root-owned public file, nofollow walk). */
export function readPublishedManifest(etc: string, uid = 0): Promise<GatewayManifest> {
  return readPublicJson(join(etc, 'public'), 'routes.json', gatewayManifestSchema, { uid })
}

/** Proof the gateway PROCESS (not its unit state) serves: an `active` unit can still be a process
 * from an older release, or one that cannot read or parse the current manifest; either way it
 * answers every vault host 503 `not_installed`. Checks the unrouted host first (manifest loaded),
 * then each listed ready route end to end: a credential-free whoami must reach that vault and come
 * back 401 with the shared protocol. A 429 is the gateway's own rate limit on a parsed, found
 * route, so it is not unavailability. Throws `upstream_unavailable` and leaves a fixed diagnostic
 * stage naming which check failed; never request data. */
export async function verifyGatewayServes(
  manifest: GatewayManifest,
  options: { vaultIds?: readonly string[]; request?: GatewayRequest } = {}
): Promise<void> {
  const request = options.request ?? gatewaySocketRequest()
  const ask = (host: string, path: string) =>
    request(host, path).catch(() => ({ status: 0, code: null, protocol: null }))
  const unrouted = await ask(UNROUTED_HOST, '/v1/whoami')
  // A parsed manifest for a suspended host answers everything with its own 503 `maintenance`.
  const loaded =
    manifest.hostState === 'active'
      ? unrouted.status === 404 && unrouted.code === 'not_found'
      : unrouted.status === 503 && unrouted.code === 'maintenance'
  if (!loaded) {
    noteStage(
      unrouted.status === 0
        ? 'gateway_unreachable'
        : unrouted.code === 'not_installed'
          ? 'gateway_manifest_unreadable'
          : 'gateway_unexpected_reply'
    )
    throw new Error('upstream_unavailable')
  }
  if (manifest.hostState !== 'active') return
  for (const route of manifest.routes) {
    if (route.state !== 'ready' || (options.vaultIds && !options.vaultIds.includes(route.vaultId))) continue
    const reply = await ask(new URL(route.origin).hostname, '/v1/whoami')
    if (reply.status === 429) continue
    if (reply.status !== 401 || reply.protocol !== String(MANAGED_BIGBRAIN_SHARED_PROTOCOL)) {
      noteStage(reply.code === 'not_found' ? 'gateway_route_missing' : 'gateway_route_unserved')
      throw new Error('upstream_unavailable')
    }
  }
}

/** Reads a process's argv from procfs (default) — never its environment. */
export type CmdlineReader = (pid: number) => Promise<string[]>
const procCmdline: CmdlineReader = async (pid) =>
  (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter((part) => part !== '')

/** The unit's CURRENT main process must execute `script` from the bound release. A rewritten unit
 * file plus daemon-reload changes nothing for a running process, so the unit text alone is no
 * evidence of what serves. Throws `upstream_unavailable` (no process, or another release). */
export async function verifyRunningRelease(
  unit: string,
  script: string,
  options: { run: PrivateCommandRunner; cmdline?: CmdlineReader }
): Promise<void> {
  const shown = await options.run(['/usr/bin/systemctl', 'show', '--property', 'MainPID', '--value', unit])
  const pid = Number(shown.stdout.trim())
  if (shown.code !== 0 || !Number.isSafeInteger(pid) || pid <= 1) {
    noteStage('running_release_no_process')
    throw new Error('upstream_unavailable')
  }
  const argv = await (options.cmdline ?? procCmdline)(pid).catch(() => [] as string[])
  // Exact element match: a path from another release (or a prefix of this one) never counts.
  if (!argv.includes(script)) {
    noteStage('running_release_mismatch')
    throw new Error('upstream_unavailable')
  }
}

/** The fixed entry scripts the gateway and vault units run (setup/systemd templates). */
export const gatewayScript = (artifactDigest: string) => `${artifactRoot(artifactDigest)}/ficus-bigbrain-host.js`
export const vaultServeScript = (artifactDigest: string) => `${artifactRoot(artifactDigest)}/bigbrain-serve.js`

/** Probe-time proof that what is RUNNING serves what is published: the gateway process runs the
 * host's installed release, each ready vault's process runs its own recorded release, and the
 * gateway answers every ready route end to end (verifyGatewayServes). Any failure throws
 * `upstream_unavailable`; the caller reports the feature unavailable instead of ready. */
export async function verifyHostServing(input: {
  artifactDigest: string
  records: readonly ControlReceipt[]
  manifest: () => Promise<GatewayManifest>
  run: PrivateCommandRunner
  cmdline?: CmdlineReader
  request?: GatewayRequest
}): Promise<void> {
  const options = { run: input.run, cmdline: input.cmdline }
  await verifyRunningRelease(GATEWAY_UNIT, gatewayScript(input.artifactDigest), options)
  const manifest = await input.manifest().catch(() => {
    noteStage('gateway_manifest_unpublished')
    throw new Error('upstream_unavailable')
  })
  for (const route of manifest.routes) {
    if (route.state !== 'ready') continue
    const record = input.records.find((r) => r.receipt.vaultId === route.vaultId)
    if (!record) {
      noteStage('gateway_route_unrecorded')
      throw new Error('upstream_unavailable')
    }
    await verifyRunningRelease(
      managedPaths({ vaultId: route.vaultId }).unit,
      vaultServeScript(record.receipt.artifactDigest),
      options
    )
  }
  await verifyGatewayServes(manifest, { request: input.request })
}

/** Bounded wait (≈15 s) for a just-(re)started gateway: `Type=simple` reports started before Bun
 * binds its socket. Only the manifest load is required here, not every vault. */
export async function waitForGatewayServing(
  manifest: GatewayManifest,
  options: { request?: GatewayRequest; sleep?: (ms: number) => Promise<void>; attempts?: number } = {}
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const attempts = options.attempts ?? 30
  for (let attempt = 1; ; attempt++) {
    try {
      return await verifyGatewayServes({ ...manifest, routes: [] }, { request: options.request })
    } catch (error) {
      if (attempt >= attempts) throw error
      await sleep(500)
    }
  }
}

import { lstat, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { managedBigbrainOriginHasVault, parseManagedBigbrainOrigin } from '@ficus/shared/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { GATEWAY_SOCKET, gatewayManifestSchema, type GatewayManifest } from './gateway-policy'
import { BIGBRAIN_ETC } from './install'
import { BIGBRAIN_STATE_ROOT } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { readPrivateJson, readPublicText, writePublicJson, writePublicText } from './secure-files'
import { runPrivateCommand, type PrivateCommandRunner } from './process'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const SITE = new RegExp(`^${UUID}\\.caddy$`)
const VAULT_DIR = new RegExp(`^${UUID}$`)

export interface IngressOptions {
  root?: string
  etc?: string
  uid?: number
  run?: PrivateCommandRunner
  /** The origin certificate pair Core's own Caddy site already serves (setup-toolkit paths). */
  tlsCert?: string
  tlsKey?: string
}

/** The per-vault Caddy site directory: a sibling of the root-private etc directory, never inside
 * it. Caddy runs, validates and reloads as the unprivileged `caddy` user; an `import` glob over a
 * directory that user cannot traverse silently matches nothing, so Caddy would answer every vault
 * host with its empty 200 fallback (which the native client reads as a `null` body). */
export const caddySitesDirectory = (etc: string) => join(dirname(etc), 'bigbrain-caddy')

/** Fail closed unless an unprivileged user (Caddy) can reach and list the site directory and read
 * every site file: each ancestor must be other-searchable, the directory other-readable/searchable.
 * `caddy validate` runs as root and cannot detect this, so it is checked here explicitly. */
export async function assertCaddyCanReadSites(sites: string, names: Iterable<string>): Promise<void> {
  try {
    let path = dirname(sites)
    for (;;) {
      const info = await lstat(path)
      if (!info.isDirectory() || (info.mode & 0o001) === 0) throw new Error()
      if (path === '/') break
      path = dirname(path)
    }
    const dir = await lstat(sites)
    if (!dir.isDirectory() || (dir.mode & 0o005) !== 0o005) throw new Error()
    for (const name of names) {
      const file = await lstat(join(sites, name))
      if (!file.isFile() || (file.mode & 0o004) === 0) throw new Error()
    }
  } catch {
    throw new Error('tls_unavailable')
  }
}

async function receipts(root: string, uid: number): Promise<ControlReceipt[]> {
  const control = join(root, 'control')
  const ids = (await readdir(control)).sort().filter((n) => VAULT_DIR.test(n))
  return Promise.all(ids.map((id) => readPrivateJson(join(control, id), 'receipt.json', controlReceiptSchema, { uid })))
}

/** One exact-host site per ready vault; Caddy only terminates TLS and forwards to the
 * credential-free gateway, which owns all routing/admission decisions. */
export function renderVaultSite(origin: string, vaultId: string, cert: string, key: string): string {
  // Either recorded form (bb-<32 hex> or <tenant>-bb-<12 hex>) of THIS vault; the parsed
  // hostname is [a-z0-9.-] only, so it cannot inject Caddyfile syntax.
  const host = parseManagedBigbrainOrigin(origin)?.hostname
  if (
    !host ||
    !managedBigbrainOriginHasVault(origin, vaultId) ||
    !/^\/[\w./-]+$/.test(cert) ||
    !/^\/[\w./-]+$/.test(key)
  )
    throw new Error('invalid_request')
  return [
    `${host} {`,
    `    tls ${cert} ${key}`,
    '    request_body {',
    '        max_size 1114112',
    '    }',
    `    reverse_proxy unix/${GATEWAY_SOCKET} {`,
    '        header_up X-Forwarded-For {client_ip}',
    '        header_up X-Forwarded-Proto {scheme}',
    '    }',
    '}',
    '',
  ].join('\n')
}

/** Derive the credential-free route manifest and per-vault Caddy sites from the CURRENT
 * receipts and host record (never from a request), then validate and reload Caddy. A Caddy
 * rejection restores the previous site files. Idempotent: callers run it after every change.
 */
export async function publishIngress(options: IngressOptions = {}): Promise<GatewayManifest> {
  const root = options.root ?? BIGBRAIN_STATE_ROOT
  const etc = options.etc ?? BIGBRAIN_ETC
  const uid = options.uid ?? 0
  const run = options.run ?? runPrivateCommand
  const fs = { uid }
  const host = await readPrivateJson(etc, 'host.json', installedHostSchema, fs)
  const ready = (await receipts(root, uid)).filter(
    (r) =>
      r.phase === 'ready' &&
      r.receipt.state !== 'deleted' &&
      r.receipt.upstreamVaultId !== null &&
      r.receipt.origin !== null &&
      r.receipt.tenantId === host.tenantId &&
      r.receipt.physicalHostBinding === host.physicalHostBinding
  )
  const manifest = gatewayManifestSchema.parse({
    contractVersion: 1,
    tenantId: host.tenantId,
    physicalHostBinding: host.physicalHostBinding,
    hostEpoch: host.hostEpoch,
    hostState: host.hostState,
    routes: ready.map((r) => ({
      vaultId: r.receipt.vaultId,
      upstreamVaultId: r.receipt.upstreamVaultId!,
      origin: r.receipt.origin!,
      state: host.hostState === 'active' ? 'ready' : 'disabled',
    })),
  })
  await writePublicJson(join(etc, 'public'), 'routes.json', manifest, gatewayManifestSchema, fs)

  // Sites follow the same set; a suspended/terminated host serves none.
  const caddy = caddySitesDirectory(etc)
  const cert = options.tlsCert ?? '/etc/caddy/tls/origin.crt'
  const key = options.tlsKey ?? '/etc/caddy/tls/origin.key'
  const desired = new Map(
    (host.hostState === 'active' ? ready : []).map((r) => [
      `${r.receipt.vaultId}.caddy`,
      renderVaultSite(r.receipt.origin!, r.receipt.vaultId, cert, key),
    ])
  )
  const previous = new Map<string, string>()
  for (const name of await readdir(caddy)) {
    if (!SITE.test(name)) throw new Error('identity_mismatch')
    previous.set(name, await readPublicText(caddy, name, fs))
  }
  const changed = previous.size !== desired.size || [...desired].some(([name, text]) => previous.get(name) !== text)
  if (!changed) {
    // Unchanged files are not proof they are served: re-check what Caddy itself can read.
    if (desired.size) await assertCaddyCanReadSites(caddy, desired.keys())
    return manifest
  }
  const apply = async (files: Map<string, string>) => {
    for (const name of await readdir(caddy)) if (!files.has(name)) await unlink(join(caddy, name))
    for (const [name, text] of files) await writePublicText(caddy, name, text, fs)
  }
  await apply(desired)
  try {
    await assertCaddyCanReadSites(caddy, desired.keys())
  } catch (error) {
    await apply(previous)
    throw error
  }
  const validate = await run(
    ['/usr/bin/caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    {
      timeoutMs: 30000,
    }
  )
  if (validate.code !== 0 || (await run(['/usr/bin/systemctl', 'reload', 'caddy'], { timeoutMs: 30000 })).code !== 0) {
    await apply(previous)
    throw new Error('tls_unavailable')
  }
  return manifest
}

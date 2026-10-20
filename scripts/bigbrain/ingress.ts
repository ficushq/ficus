import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { installedHostSchema } from './control-input'
import { gatewayManifestSchema, type GatewayManifest } from './gateway-policy'
import { BIGBRAIN_ETC } from './install'
import { BIGBRAIN_STATE_ROOT } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { readPrivateJson, readPublicText, writePublicJson, writePublicText } from './secure-files'
import { runPrivateCommand, type PrivateCommandRunner } from './process'

export const GATEWAY_PORT = 34792
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

async function receipts(root: string, uid: number): Promise<ControlReceipt[]> {
  const control = join(root, 'control')
  const ids = (await readdir(control)).sort().filter((n) => VAULT_DIR.test(n))
  return Promise.all(ids.map((id) => readPrivateJson(join(control, id), 'receipt.json', controlReceiptSchema, { uid })))
}

/** One exact-host site per ready vault; Caddy only terminates TLS and forwards to the
 * credential-free gateway, which owns all routing/admission decisions. */
export function renderVaultSite(origin: string, cert: string, key: string): string {
  const host = new URL(origin).host
  if (!/^bb-[0-9a-f]{32}\.[a-z0-9.-]+$/.test(host) || !/^\/[\w./-]+$/.test(cert) || !/^\/[\w./-]+$/.test(key))
    throw new Error('invalid_request')
  return [
    `${host} {`,
    `    tls ${cert} ${key}`,
    '    request_body {',
    '        max_size 1114112',
    '    }',
    `    reverse_proxy 127.0.0.1:${GATEWAY_PORT} {`,
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
      localPort: r.storage.port,
      state: host.hostState === 'active' ? 'ready' : 'disabled',
    })),
  })
  await writePublicJson(join(etc, 'public'), 'routes.json', manifest, gatewayManifestSchema, fs)

  // Sites follow the same set; a suspended/terminated host serves none.
  const caddy = join(etc, 'caddy')
  const cert = options.tlsCert ?? '/etc/caddy/tls/origin.crt'
  const key = options.tlsKey ?? '/etc/caddy/tls/origin.key'
  const desired = new Map(
    (host.hostState === 'active' ? ready : []).map((r) => [
      `${r.receipt.vaultId}.caddy`,
      renderVaultSite(r.receipt.origin!, cert, key),
    ])
  )
  const previous = new Map<string, string>()
  for (const name of await readdir(caddy)) {
    if (!SITE.test(name)) throw new Error('identity_mismatch')
    previous.set(name, await readPublicText(caddy, name, fs))
  }
  const changed = previous.size !== desired.size || [...desired].some(([name, text]) => previous.get(name) !== text)
  if (!changed) return manifest
  const apply = async (files: Map<string, string>) => {
    for (const name of await readdir(caddy)) if (!files.has(name)) await unlink(join(caddy, name))
    for (const [name, text] of files) await writePublicText(caddy, name, text, fs)
  }
  await apply(desired)
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

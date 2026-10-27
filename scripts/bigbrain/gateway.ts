#!/usr/bin/env bun
import { isAbsolute, resolve, dirname, basename } from 'node:path'
import { readPublicJson } from './secure-files'
import { createGatewayHandler, GATEWAY_SOCKET, gatewayManifestSchema, type GatewayManifest } from './gateway-policy'

const ROUTES_PATH = '/etc/ficus/bigbrain/public/routes.json'
/** Safe public route manifest, not a secret store. The installed parent is root-owned and
 * cannot be replaced by the gateway UID. File descriptor checks reject links/special files.
 * Path/owner arguments are test seams, not environment or CLI configuration.
 */
export async function readGatewayManifest(path = ROUTES_PATH, ownerUid = 0): Promise<GatewayManifest> {
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error()
    return await readPublicJson(dirname(path), basename(path), gatewayManifestSchema, { uid: ownerUid })
  } catch {
    throw new Error('invalid_response')
  }
}

export async function gatewayMain(args: string[]): Promise<void> {
  try {
    if (process.platform !== 'linux' || process.getuid?.() === 0 || args.length !== 0) throw new Error()
    await readGatewayManifest()
    // Root prepared the directory (owner gateway, group ficus-bigbrain-client, 2750) and removed any stale
    // socket before this start; Caddy reaches us only through this socket.
    const server = Bun.serve({
      unix: GATEWAY_SOCKET,
      development: false,
      maxRequestBodySize: 1024 * 1024 + 64 * 1024,
      fetch: createGatewayHandler({ manifest: readGatewayManifest }),
      error: () => Response.json({ code: 'upstream_unavailable' }, { status: 503 }),
    })
    const { chmod } = await import('node:fs/promises')
    await chmod(GATEWAY_SOCKET, 0o660)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      // Drains the bounded accepted streams before the root backup hook stops vault units.
      await server.stop(false)
    }
    process.once('SIGTERM', () => {
      void stop()
    })
    process.once('SIGINT', () => {
      void stop()
    })
  } catch (error) {
    console.error('Managed BigBrain gateway unavailable')
    // stdio is discarded by the unit; leave a fixed-alphabet token in our own socket directory.
    const token =
      error instanceof Error
        ? (error.message || error.name)
            .toLowerCase()
            .replace(/[^a-z]+/g, '_')
            .slice(0, 60)
        : 'unknown'
    const { writeFile } = await import('node:fs/promises')
    await writeFile('/run/ficus-bigbrain/gateway/start.reason', `${token}\n`, { mode: 0o600 }).catch(() => {})
    process.exitCode = 1
  }
}

if (import.meta.main) await gatewayMain(process.argv.slice(2))

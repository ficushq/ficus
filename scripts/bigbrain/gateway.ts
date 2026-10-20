#!/usr/bin/env bun
import { isAbsolute, resolve, dirname, basename } from 'node:path'
import { readPublicJson } from './secure-files'
import { createGatewayHandler, gatewayManifestSchema, type GatewayManifest } from './gateway-policy'

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
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 34792,
      development: false,
      maxRequestBodySize: 1024 * 1024 + 64 * 1024,
      idleTimeout: 15,
      fetch: createGatewayHandler({ manifest: readGatewayManifest }),
      error: () => Response.json({ code: 'upstream_unavailable' }, { status: 503 }),
    })
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
  } catch {
    console.error('Managed BigBrain gateway unavailable')
    process.exitCode = 1
  }
}

if (import.meta.main) await gatewayMain(process.argv.slice(2))

#!/usr/bin/env bun
import { constants as C } from 'node:fs'
import { open } from 'node:fs/promises'
import { createGatewayHandler, gatewayManifestSchema, type GatewayManifest } from './gateway-policy'

const ROUTES_PATH = '/etc/ficus/bigbrain/routes.json'
/** Safe public route manifest, not a secret store. The installed parent is root-owned and
 * cannot be replaced by the gateway UID. File descriptor checks reject links/special files.
 * Path/owner arguments are test seams, not environment or CLI configuration.
 */
export async function readGatewayManifest(path = ROUTES_PATH, ownerUid = 0): Promise<GatewayManifest> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK)
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== ownerUid ||
      (info.mode & 0o777) !== 0o644 ||
      info.size > 16384
    )
      throw new Error()
    const buffer = Buffer.alloc(16385)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > 16384) throw new Error()
    return gatewayManifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    )
  } catch {
    throw new Error('invalid_response')
  } finally {
    await file?.close().catch(() => {})
  }
}

if (import.meta.main) {
  try {
    if (process.platform !== 'linux' || process.getuid?.() === 0 || process.argv.length !== 2) throw new Error()
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

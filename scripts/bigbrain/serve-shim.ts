import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** The exported pinned-upstream APIs the shim is allowed to use, injected by the generated
 * entry that imports them from the corresponding upstream source (see artifact.ts). */
export interface UpstreamServeApi {
  holdSharedVault(root: string, purpose: string): { release(): void } | null
  SharedVault: new (root: string) => { recoverPending(): void; head(): unknown }
  makeSharedApiHandler(deps: {
    root: string
    storePath: string
    vault: unknown
    connector?: { publicUrl: string }
  }): (req: Request) => Promise<Response>
  MAX_SHARED_REQUEST_BYTES: number
  ensureDir(dir: string): void
  parseYaml(text: string): unknown
  parsePublicUrl(raw: string): string
}

function flag(args: string[], name: string): string {
  const at = args.indexOf(`--${name}`)
  const value = at >= 0 ? args[at + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error('invalid_request')
  return value
}
function absolute(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /\p{Cc}/u.test(path)) throw new Error('invalid_request')
  return path
}

/** Upstream `bigbrain shared serve`, in the same order with the same guards (shared-vault
 * marker, members store outside the vault, single-writer lock, pending-feed recovery, request
 * size cap, idle timeout, connector from the public URL), except that it listens ONLY on a
 * Unix socket in the root-prepared per-vault directory. No TCP listener exists, so a vault
 * cannot impersonate another vault or the gateway by squatting a port. The socket is made
 * group-accessible (the directory's group is the gateway's) and nothing else.
 */
export function serveSharedOnUnix(api: UpstreamServeApi, args: string[], onListening?: (path: string) => void) {
  if (args.length !== 8) throw new Error('invalid_request')
  const root = absolute(flag(args, 'vault'))
  const store = absolute(flag(args, 'members'))
  const socket = absolute(flag(args, 'socket'))
  const publicUrl = api.parsePublicUrl(flag(args, 'public-url'))
  // argv comes only from the root-rendered unit; the socket's directory is root-prepared.
  if (!socket.endsWith('/http.sock')) throw new Error('invalid_request')
  // Upstream requireSharedMarker: only a vault created by `shared init` may be served.
  const marker = api.parseYaml(readFileSync(`${root}/vault.yaml`, 'utf8'))
  if (!(typeof marker === 'object' && marker !== null && (marker as Record<string, unknown>).shared === true))
    throw new Error('invalid_request')
  // Upstream storePath(): the member store must live outside the vault.
  if (store === root || store.startsWith(`${root}/`)) throw new Error('invalid_request')
  if (!existsSync(store)) throw new Error('invalid_request')
  // A stale socket from a crashed previous start is ours to replace; anything else is not.
  if (existsSync(socket)) {
    if (!lstatSync(socket).isSocket()) throw new Error('invalid_request')
    unlinkSync(socket)
  }
  if (!existsSync(dirname(socket))) throw new Error('invalid_request')
  api.ensureDir(`${root}/.state`)
  const lock = api.holdSharedVault(root, 'shared')
  if (!lock) throw new Error('busy')
  const vault = new api.SharedVault(root)
  vault.recoverPending()
  const handler = api.makeSharedApiHandler({ root, storePath: store, vault, connector: { publicUrl } })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      unix: socket,
      maxRequestBodySize: api.MAX_SHARED_REQUEST_BYTES,
      // Bun has no idle timeout for Unix-socket servers; the gateway bounds every request instead.
      fetch: handler,
    })
  } catch (error) {
    lock.release()
    throw error
  }
  chmodSync(socket, 0o660)
  const stop = () => {
    server.stop(true)
    lock.release()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  onListening?.(socket)
  return server
}

/** Entry used by the generated upstream-side bundle entry. Fixed argv shape, no environment. */
export function serveShimMain(api: UpstreamServeApi): void {
  try {
    serveSharedOnUnix(api, process.argv.slice(2), (path) =>
      console.log(JSON.stringify({ shared: 'listening', unix: path }))
    )
  } catch {
    console.error('Managed BigBrain vault server refused to start')
    process.exit(1)
  }
}

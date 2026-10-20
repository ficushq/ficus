import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyBigbrainArtifact } from './artifact'
import { MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS } from '@ficus/shared/managed-bigbrain'

/** Synthetic-only harness: no account/mount/systemd changes, no inherited provider env. */
export async function nativeFixtures(root: string, artifact: string, dependencyRoot: string) {
  const provenance = await verifyBigbrainArtifact(artifact)
  const lockHash = `sha256:${createHash('sha256')
    .update(await readFile(join(dependencyRoot, 'bun.lock')))
    .digest('hex')}`
  if (lockHash !== provenance.files['upstream-bun.lock']) throw new Error('synthetic_dependency_mismatch')
  const env = { PATH: process.env.PATH!, HOME: join(root, 'home'), LANG: 'C.UTF-8' }
  await mkdir(env.HOME, { mode: 0o700 })
  const servers = new Set<{ stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void> }>()
  async function command(argv: string[], input?: unknown): Promise<string> {
    const child = Bun.spawn(argv, { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    if (input !== undefined) child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    let failed = false
    const timer = setTimeout(() => {
      failed = true
      child.kill('SIGKILL')
    }, 10000)
    const consume = async (stream: ReadableStream<Uint8Array>, retain: boolean) => {
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 16384) {
            failed = true
            child.kill('SIGKILL')
          } else if (retain) chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    try {
      const [stdout] = await Promise.all([consume(child.stdout, true), consume(child.stderr, false)])
      if ((await child.exited) !== 0 || failed) throw new Error('synthetic_command_failed')
      return stdout
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  }
  const source = join(root, 'source')
  await mkdir(source, { mode: 0o700 })
  await command(['tar', '-xf', join(artifact, 'source.tar'), '-C', source])
  await symlink(join(dependencyRoot, 'node_modules'), join(source, 'node_modules'))
  // Import the actual pinned native implementation from the corresponding source archive.
  const native = (await import(pathToFileURL(join(source, 'lib/sharedConnections.ts')).href)) as {
    connectInvite(path: string, invite: string): Promise<{ id: string; identity: { vault: { id: string } } }>
    readConnections(path: string): Array<{ id: string; name: string; endpoint: string; token: string }>
    sharedRequest<T>(connection: { endpoint: string; token: string }, path: string, body?: unknown): Promise<T>
  }
  // The shipped bundles under this (pinned, version-checked) Bun, exactly as the units run them.
  if (Bun.version !== provenance.bunVersion) throw new Error('synthetic_bun_version_mismatch')
  const bun = [process.execPath, '--no-install', '--no-env-file']
  const binary = join(artifact, 'bigbrain-shared.js')
  async function vault(name: string) {
    const base = join(root, name)
    await mkdir(base, { mode: 0o700 })
    const data = join(base, 'vault')
    const members = join(base, 'members.json')
    const cli = (args: string[]) => command([...bun, binary, ...args, '--vault', data, '--members', members, '--json'])
    await cli(['init', '--owner', 'ada', '--display', 'Ada'])
    await cli(['member', 'add', 'ficus-reader', '--permissions', 'read'])
    const minted = JSON.parse(
      await cli([
        'credential',
        'mint',
        'ficus-reader',
        '--name',
        'Ficus read access',
        '--kind',
        'agent',
        '--scopes',
        'read',
      ])
    ) as {
      credential: { id: string; kind: string; scopes: string[]; followsMember?: boolean }
      token: string
    }
    if (
      minted.credential.kind !== 'agent' ||
      minted.credential.scopes.join(',') !== 'read' ||
      minted.credential.followsMember === true
    )
      throw new Error('synthetic_scope_mismatch')
    let endpoint = ''
    let running: { stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void> } | undefined
    async function start() {
      // The shipped vault server: pinned upstream handler on a Unix socket (no TCP listener).
      const socket = join(base, 'run', 'http.sock')
      await mkdir(join(base, 'run'), { recursive: true, mode: 0o750 })
      const child = Bun.spawn(
        [
          ...bun,
          join(artifact, 'bigbrain-serve.js'),
          '--vault',
          data,
          '--members',
          members,
          '--socket',
          socket,
          '--public-url',
          'http://127.0.0.1',
        ],
        // Like the unit's WorkingDirectory: assets resolve inside the immutable release only.
        { cwd: artifact, env, stdout: 'pipe', stderr: 'pipe' }
      )
      let resolveReady!: (path: string) => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<string>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const timeout = setTimeout(() => {
        rejectReady(new Error('synthetic_server_not_ready'))
        child.kill('SIGKILL')
      }, 10000)
      const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
        const reader = stream.getReader()
        let first = ''
        let parsed = !stdout
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            if (!parsed) {
              first += new TextDecoder().decode(next.value)
              if (first.length > 16384) {
                rejectReady(new Error('synthetic_server_output_limit'))
                child.kill('SIGKILL')
                parsed = true
              } else if (first.includes('\n')) {
                parsed = true
                try {
                  const value = JSON.parse(first.split('\n')[0]!)
                  if (value.shared !== 'listening' || value.unix !== socket) throw new Error()
                  resolveReady(value.unix)
                } catch {
                  rejectReady(new Error('synthetic_server_not_ready'))
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
        }
      }
      const drained = Promise.all([drain(child.stdout, true), drain(child.stderr, false)])
      const server = {
        async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
          if (child.exitCode === null) child.kill(signal)
          const escalation = setTimeout(() => child.kill('SIGKILL'), 2000)
          try {
            await child.exited
            await drained
          } finally {
            clearTimeout(escalation)
            clearTimeout(timeout)
            servers.delete(server)
          }
        },
      }
      servers.add(server)
      running = server
      void child.exited.then(() => rejectReady(new Error('synthetic_server_exited')))
      try {
        const path = await ready
        // Test-only TCP front for the native client (production: Caddy -> gateway -> socket).
        // It forwards bytes to the vault socket and adds nothing of its own.
        const front = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: async (request) => {
            const url = new URL(request.url)
            return fetch(`http://127.0.0.1${url.pathname}${url.search}`, {
              unix: path,
              method: request.method,
              headers: request.headers,
              body: request.body,
              redirect: 'manual',
            })
          },
        })
        const stopServer = server.stop
        server.stop = async (signal) => {
          front.stop(true)
          await stopServer(signal)
        }
        endpoint = `http://127.0.0.1:${front.port}`
      } finally {
        clearTimeout(timeout)
      }
    }
    await start()
    const identity = (await fetch(endpoint + '/v1/whoami', {
      headers: { Authorization: `Bearer ${minted.token}` },
    }).then((r) => r.json())) as { vault: { id: string } }
    const issueAppLink = async (window: { issuedAt: string; expiresAt: string }) =>
      JSON.parse(
        await command([...bun, join(artifact, 'bigbrain-owner-link.js')], {
          membersPath: members,
          handle: 'ada',
          ...window,
        })
      ) as { secret: string; expiresAt: string }
    const issuedAt = new Date().toISOString()
    const window = {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
    }
    const link = await issueAppLink(window)
    if (link.expiresAt !== window.expiresAt) throw new Error('synthetic_invite_expiry_mismatch')
    const invite = `${endpoint}/invite#${link.secret}`
    return {
      cli,
      identity,
      minted,
      invite,
      issueAppLink,
      get endpoint() {
        return endpoint
      },
      async restart() {
        await running!.stop('SIGKILL')
        await start()
      },
      async stop() {
        await running?.stop()
      },
    }
  }
  return {
    native,
    vault,
    provenance,
    async dispose() {
      await Promise.all([...servers].map((server) => server.stop()))
    },
  }
}

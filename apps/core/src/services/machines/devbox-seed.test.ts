import { describe, test, expect, spyOn } from 'bun:test'
import { EventEmitter } from 'events'
import { readFileSync } from 'node:fs'
import {
  seedBoxDevbox,
  renderDevboxJson,
  computeDevboxSeedHash,
  AGENT_COMFORT_PACKAGES,
  SQUAD_COMFORT_PACKAGES,
  mergeDevboxJson,
  type SeedBoxRole,
} from './devbox-seed'
import { SandboxHttpError } from '../sandbox/client/http-client'
import { boxUnixUser } from './box-manager'

// ---------------------------------------------------------------------------
// Fake SandboxClient — records /write + /bash and serves /read from a file map.
// ---------------------------------------------------------------------------

function makeBashStream(exitCode: number, error?: string) {
  const stream = new EventEmitter() as any
  stream.cancel = () => {}
  queueMicrotask(() => {
    stream.emit('data', { exitCode, error })
    stream.emit('end')
  })
  return stream
}

/** A bash stream that emits scripted stdout/stderr chunks (one microtask apart,
 *  so each lands as a separate 'data' event — modeling devbox install's real
 *  multi-line streamed output) before the final exitCode + end. */
function makeChunkedBashStream(chunks: Array<{ stdout?: string; stderr?: string }>, exitCode: number) {
  const stream = new EventEmitter() as any
  stream.cancel = () => {}
  async function run() {
    for (const c of chunks) {
      await Promise.resolve()
      stream.emit('data', {
        stdout: c.stdout !== undefined ? Buffer.from(c.stdout).toString('base64') : undefined,
        stderr: c.stderr !== undefined ? Buffer.from(c.stderr).toString('base64') : undefined,
      })
    }
    await Promise.resolve()
    stream.emit('data', { exitCode })
    stream.emit('end')
  }
  void run()
  return stream
}

/** A stream that ends WITHOUT ever emitting an exitCode — models a server-side
 *  regression (or a truncated SSE stream) where the exit code never arrives. */
function makeExitlessBashStream(error?: string) {
  const stream = new EventEmitter() as any
  stream.cancel = () => {}
  queueMicrotask(() => {
    if (error) stream.emit('data', { error })
    stream.emit('end')
  })
  return stream
}

type WriteReq = { path: string; content: string; createDirs?: boolean; mode?: string }
type BashReq = { command: string; timeoutSeconds?: number; invocationId?: string }

/** Stand-in for what a real `devbox install` writes to devbox.lock on success. */
const DEFAULT_GENERATED_LOCK = '{"lockfile_version":"1","packages":{}}\n'

class FakeClient {
  writes: WriteReq[] = []
  bashCommands: BashReq[] = []
  /** Non-zero → `devbox install` fails (drives the failure-path assertions). */
  bashExit = 0
  bashError: string | undefined = undefined
  /** When true, the bash stream ends WITHOUT any exitCode (server regression). */
  bashExitless = false
  /** When set, the `devbox install` bash call streams these chunks (one per
   *  microtask) before the final exit — models devbox's real multi-line output
   *  so the resolve/realize marker-split can be exercised. */
  installChunks: Array<{ stdout?: string; stderr?: string }> | undefined = undefined
  /** path → base64 content, populated by /write and served back by /read. */
  files = new Map<string, string>()
  readError: Error | undefined
  /** Fired synchronously at the top of every `bash()` call, BEFORE the stream
   *  is created — lets a test snapshot file-map state at the exact moment a
   *  given command (e.g. `devbox install`) was invoked, to prove ordering
   *  (e.g. "the cached lock was written before install ran"). */
  onBashCall?: (command: string) => void

  setText(path: string, content: string): void {
    this.files.set(path, Buffer.from(content, 'utf8').toString('base64'))
  }

  text(path: string): string | undefined {
    const content = this.files.get(path)
    return content === undefined ? undefined : Buffer.from(content, 'base64').toString('utf8')
  }

  async write(req: WriteReq) {
    this.writes.push(req)
    this.files.set(req.path, req.content)
    return { bytesWritten: Buffer.from(req.content, 'base64').length }
  }

  async read(req: { path: string }) {
    if (this.readError) throw this.readError
    const content = this.files.get(req.path)
    if (content === undefined) {
      throw new SandboxHttpError('read failed: 404', 404)
    }
    return { content, totalSize: 0, isBinary: false }
  }

  bash(req: BashReq) {
    this.bashCommands.push({ command: req.command, timeoutSeconds: req.timeoutSeconds, invocationId: req.invocationId })
    this.onBashCall?.(req.command)
    // Model devbox's real behavior: a SUCCESSFUL `devbox install` generates
    // (or leaves untouched, if already present — e.g. a cache-hit seeded lock)
    // a devbox.lock file next to devbox.json. Without this, every pristine-role
    // test that doesn't manually stage a devbox.lock would 404 on the seeder's
    // post-install read-back — a "cache miss" that isn't really testing a
    // miss, it's testing an unrealistic fake, and it spams a WARN on every
    // such test. Only write when a lock isn't already there, so tests that
    // stage specific content (a cache hit's seeded lock, or a deliberately
    // customized/empty lock) are never clobbered.
    if (req.command.includes('devbox install') && this.bashExit === 0 && !this.bashExitless) {
      const match = req.command.match(/^cd '([^']*)' &&/)
      const lockPath = match ? `${match[1]}/devbox.lock` : undefined
      if (lockPath && !this.files.has(lockPath)) {
        this.setText(lockPath, DEFAULT_GENERATED_LOCK)
      }
    }
    if (this.installChunks && req.command.includes('devbox install')) {
      return makeChunkedBashStream(this.installChunks, this.bashExit)
    }
    return this.bashExitless ? makeExitlessBashStream(this.bashError) : makeBashStream(this.bashExit, this.bashError)
  }

  installCommands(): BashReq[] {
    return this.bashCommands.filter((b) => b.command.includes('devbox install'))
  }
  writtenDevboxJson(devboxDir: string): any | undefined {
    const content = this.text(`${devboxDir}/devbox.json`)
    return content === undefined ? undefined : JSON.parse(content)
  }
  markerContent(devboxDir: string): string | undefined {
    return this.text(`${devboxDir}/.seeded`)
  }
  lockContent(devboxDir: string): string | undefined {
    return this.text(`${devboxDir}/devbox.lock`)
  }
}

// ---------------------------------------------------------------------------
// Fake devbox.lock cache — an in-memory get/put pair, recording every call so
// tests can assert whether the cache was consulted at all (must be skipped
// entirely for a user-customized devbox.json).
// ---------------------------------------------------------------------------

function makeFakeCache(opts: { getError?: Error; putError?: Error } = {}) {
  const store = new Map<string, string>()
  const getCalls: string[] = []
  const putCalls: Array<{ hash: string; content: string }> = []

  return {
    store,
    getCalls,
    putCalls,
    async cacheGet(hash: string): Promise<string | null> {
      getCalls.push(hash)
      if (opts.getError) throw opts.getError
      return store.get(hash) ?? null
    },
    async cachePut(hash: string, content: string): Promise<void> {
      putCalls.push({ hash, content })
      if (opts.putError) throw opts.putError
      if (!store.has(hash)) store.set(hash, content) // first write wins, mirrors DevboxLockCache.storeIfAbsent
    },
  }
}

const HOME = (id: string) => `/home/${boxUnixUser(id)}`
const DEVBOX_DIR = (id: string) => `${HOME(id)}/.tau/devbox`

// ---------------------------------------------------------------------------
// No-op devbox.lock cache — the DEFAULT for every test below that isn't
// specifically exercising the cache (see the "devbox.lock cache" describe
// block). Without this, a test that calls seedBoxDevbox without overriding
// cacheGet/cachePut falls through to its REAL DB-backed default, silently
// making an otherwise-pure unit test depend on the shared test Postgres —
// and since the seed hash is content-derived (hence GLOBAL, not per-test),
// a row written by anything else sharing that DB could flip a pristine-role
// test from a cache miss to a cache hit and change its asserted behavior.
// `seed()` wraps seedBoxDevbox with this as the default so plain tests never
// touch the real DB; pass cacheGet/cachePut in `deps` to override.
// ---------------------------------------------------------------------------

async function noopCacheGet(): Promise<string | null> {
  return null
}
async function noopCachePut(): Promise<void> {}

function seed(
  client: unknown,
  sandboxId: string,
  role: SeedBoxRole,
  deps: Parameters<typeof seedBoxDevbox>[3] = {}
): ReturnType<typeof seedBoxDevbox> {
  return seedBoxDevbox(client as Parameters<typeof seedBoxDevbox>[0], sandboxId, role, {
    cacheGet: noopCacheGet,
    cachePut: noopCachePut,
    ...deps,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('devbox comfort-set package lists mirror the Dockerfile stages', () => {
  test('machine and image gh pins stay aligned without the Jetify version index', () => {
    const ghRef = AGENT_COMFORT_PACKAGES.find((pkg) => pkg.endsWith('#gh'))
    if (!ghRef) throw new Error('Agent comfort set must pin gh directly to Nixpkgs')
    expect(ghRef).toMatch(/^github:NixOS\/nixpkgs\/[a-f0-9]{40}#gh$/)
    expect(SQUAD_COMFORT_PACKAGES).toContain(ghRef)
    const sandboxRoot = new URL('../../../../../packages/sandbox-server/', import.meta.url)
    const template = JSON.parse(readFileSync(new URL('sandbox/devbox.json', sandboxRoot), 'utf8'))
    expect(template.packages).toEqual(SQUAD_COMFORT_PACKAGES)
    const dockerfile = readFileSync(new URL('Dockerfile', sandboxRoot), 'utf8')
    expect(dockerfile).toContain(ghRef)
    expect(dockerfile).not.toContain('nixpkgs#gh')
  })

  test('agent light set matches the k8s agent-stage global nix profile comfort set', () => {
    // Dockerfile `agent` stage: nix profile install of node/python + the ergonomic
    // CLI tools. Kept in lockstep with packages/sandbox-server/Dockerfile.
    expect(AGENT_COMFORT_PACKAGES).toEqual([
      'nodejs_24@latest',
      'python3@latest',
      'ripgrep@latest',
      'fd@latest',
      'tree@latest',
      'less@latest',
      'github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh',
      'tmux@latest',
      'procps@latest',
    ])
  })

  test('squad bun is pinned to Nixpkgs rather than the lagging Jetify index', () => {
    const bunRef = SQUAD_COMFORT_PACKAGES.find((pkg) => pkg.endsWith('#bun'))
    if (!bunRef) throw new Error('Squad comfort set must pin bun directly to Nixpkgs')
    expect(bunRef).toMatch(/^github:NixOS\/nixpkgs\/[a-f0-9]{40}#bun$/)
    expect(SQUAD_COMFORT_PACKAGES.some((pkg) => pkg.startsWith('bun@'))).toBe(false)
  })

  test('squad heavier set matches the k8s squad-stage baked devbox.json packages', () => {
    // Mirrors packages/sandbox-server/sandbox/devbox.json exactly.
    expect(SQUAD_COMFORT_PACKAGES).toEqual([
      'nodejs_24@latest',
      'github:NixOS/nixpkgs/8825bebf6324e0579d012936eff73379af284b6d#bun',
      'python3@latest',
      'ripgrep@latest',
      'fd@latest',
      'jq@latest',
      'tree@latest',
      'less@latest',
      'github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh',
      'gnumake@latest',
      'gcc@latest',
      'diffutils@latest',
      'patch@latest',
      'perl@latest',
      'procps@latest',
      'tmux@latest',
    ])
  })
})

describe('seedBoxDevbox', () => {
  test('agent role writes a devbox.json with the light comfort set, installs once, then marks seeded', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')

    await seed(client, 'agent_a1', 'agent')

    const json = client.writtenDevboxJson(dir)
    expect(json).toBeDefined()
    expect(json.packages).toEqual(AGENT_COMFORT_PACKAGES)

    // `devbox install` ran exactly once, in the devbox dir, bounded by a timeout.
    const installs = client.installCommands()
    expect(installs).toHaveLength(1)
    expect(installs[0].command).toContain(dir)
    expect(installs[0].timeoutSeconds).toBeGreaterThanOrEqual(600)

    // Marker written AFTER install, holding the intended-content hash.
    expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('agent'))
  })

  test('squad role writes the heavier comfort set', async () => {
    const client = new FakeClient()
    await seed(client, 'squad_s1', 'squad')
    expect(client.writtenDevboxJson(DEVBOX_DIR('squad_s1')).packages).toEqual(SQUAD_COMFORT_PACKAGES)
  })

  test('system-manager role gets the heavier squad comfort set (mirrors the Dockerfile split)', async () => {
    const client = new FakeClient()
    await seed(client, 'system_manager_x', 'system-manager')
    expect(client.writtenDevboxJson(DEVBOX_DIR('system_manager_x')).packages).toEqual(SQUAD_COMFORT_PACKAGES)
  })

  test('runs entirely as the box user — no sudo / root escalation in the install command', async () => {
    const client = new FakeClient()
    await seed(client, 'squad_s1', 'squad')
    // The sandbox-server executes /write and /bash AS THE BOX USER; the seeder must
    // never shell out to sudo or target root.
    for (const b of client.bashCommands) {
      expect(b.command).not.toContain('sudo')
      expect(b.command).not.toContain('root')
    }
  })

  test('idempotent: a re-seed with the marker already at the current hash SKIPS the install', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    // Pre-seed the marker with the CURRENT content hash.
    client.files.set(`${dir}/.seeded`, Buffer.from(computeDevboxSeedHash('agent'), 'utf8').toString('base64'))

    await seed(client, 'agent_a1', 'agent')

    // No devbox.json rewrite, no install — the 10-min tax is avoided.
    expect(client.writes).toHaveLength(0)
    expect(client.installCommands()).toHaveLength(0)
  })

  test('re-seeds when the comfort set changed: a stale marker hash forces a fresh install', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    // Marker holds a hash from an OLDER comfort set — content drift → must re-seed.
    client.files.set(`${dir}/.seeded`, Buffer.from('deadbeefdeadbeef', 'utf8').toString('base64'))

    await seed(client, 'agent_a1', 'agent')

    expect(client.installCommands()).toHaveLength(1)
    // Marker refreshed to the new content hash.
    expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('agent'))
  })

  test('merges missing comfort packages without replacing user devbox configuration', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    client.setText(`${dir}/.seeded`, 'stale')
    client.setText(
      `${dir}/devbox.json`,
      JSON.stringify({
        $schema: 'user-schema',
        packages: ['ripgrep@14.1.0', 'cowsay@latest'],
        shell: { init_hook: ['export OWNED=1'], scripts: { hello: 'echo hello' } },
        env: { OWNED_ENV: 'yes' },
        futureKey: { keep: true },
      })
    )

    await seed(client, 'agent_a1', 'agent')

    const merged = client.writtenDevboxJson(dir)
    expect(merged.packages).toEqual([
      'ripgrep@14.1.0',
      'cowsay@latest',
      'nodejs_24@latest',
      'python3@latest',
      'fd@latest',
      'tree@latest',
      'less@latest',
      'github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh',
      'tmux@latest',
      'procps@latest',
    ])
    expect(merged.shell).toEqual({ init_hook: ['export OWNED=1'], scripts: { hello: 'echo hello' } })
    expect(merged.env).toEqual({ OWNED_ENV: 'yes' })
    expect(merged.futureKey).toEqual({ keep: true })
    expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('agent'))
  })

  test('merges missing comfort packages into a MAP-form devbox.json without flattening it', async () => {
    // devbox itself rewrites `packages` into map form once any package carries
    // options (`devbox add zlib --outputs dev`). The map is the user's
    // configuration too: keep it a map, keep every entry, append only what is
    // missing as `name: version` pairs.
    const client = new FakeClient()
    const dir = DEVBOX_DIR('squad_s1')
    client.setText(`${dir}/.seeded`, 'stale')
    client.setText(
      `${dir}/devbox.json`,
      JSON.stringify({
        packages: {
          nodejs_24: 'latest',
          ripgrep: '14.1.0',
          'github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh': '',
          zlib: { version: 'latest', outputs: ['dev'] },
          'pkg-config': 'latest',
        },
        shell: { init_hook: ['export OWNED=1'], scripts: {} },
      })
    )

    await seed(client, 'squad_s1', 'squad')

    const merged = client.writtenDevboxJson(dir)
    expect(Array.isArray(merged.packages)).toBe(false)
    expect(merged.packages).toEqual({
      nodejs_24: 'latest',
      ripgrep: '14.1.0',
      'github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh': '',
      zlib: { version: 'latest', outputs: ['dev'] },
      'pkg-config': 'latest',
      'github:NixOS/nixpkgs/8825bebf6324e0579d012936eff73379af284b6d#bun': '',
      python3: 'latest',
      fd: 'latest',
      jq: 'latest',
      tree: 'latest',
      less: 'latest',
      gnumake: 'latest',
      gcc: 'latest',
      diffutils: 'latest',
      patch: 'latest',
      perl: 'latest',
      procps: 'latest',
      tmux: 'latest',
    })
    expect(merged.shell).toEqual({ init_hook: ['export OWNED=1'], scripts: {} })
    // Customized → never touches the pristine lock cache, install still runs, marker written.
    expect(client.installCommands()).toHaveLength(1)
    expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('squad'))
  })

  test("Core's superseded bun@latest is replaced in place, list or map, without a second bun", () => {
    const list = JSON.parse(
      mergeDevboxJson('squad', JSON.stringify({ packages: ['bun@latest', 'postgresql@latest'] })).content
    ).packages as string[]
    expect(list.slice(0, 2)).toEqual([
      'github:NixOS/nixpkgs/8825bebf6324e0579d012936eff73379af284b6d#bun',
      'postgresql@latest',
    ])
    expect(list.filter((spec) => spec.endsWith('#bun') || spec.startsWith('bun@'))).toHaveLength(1)

    const map = JSON.parse(
      mergeDevboxJson('squad', JSON.stringify({ packages: { bun: 'latest', postgresql: 'latest' } })).content
    ).packages as Record<string, unknown>
    expect(map).not.toHaveProperty('bun')
    expect(Object.keys(map).slice(0, 2)).toEqual([
      'github:NixOS/nixpkgs/8825bebf6324e0579d012936eff73379af284b6d#bun',
      'postgresql',
    ])
  })

  test('a bun version the user chose is kept, and no pinned bun is added beside it', () => {
    const merged = mergeDevboxJson('squad', JSON.stringify({ packages: ['bun@1.2.0'] }))
    const packages = JSON.parse(merged.content).packages as string[]
    expect(packages).toContain('bun@1.2.0')
    expect(packages.some((spec) => spec.endsWith('#bun'))).toBe(false)
  })

  test('a MAP-form devbox.json that already holds the whole comfort set is left untouched', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('squad_s1')
    client.setText(`${dir}/.seeded`, 'stale')
    const packages: Record<string, unknown> = {}
    for (const spec of SQUAD_COMFORT_PACKAGES) {
      const at = spec.lastIndexOf('@')
      if (at > 0) packages[spec.slice(0, at)] = spec.slice(at + 1)
      else packages[spec] = ''
    }
    packages.zlib = { version: 'latest', outputs: ['dev'] }
    const existing = JSON.stringify({ packages })
    client.setText(`${dir}/devbox.json`, existing)

    await seed(client, 'squad_s1', 'squad')

    expect(client.writes.filter((w) => w.path === `${dir}/devbox.json`)).toHaveLength(0)
    expect(client.text(`${dir}/devbox.json`)).toBe(existing)
  })

  test.each(['{"packages":{"nodejs_24":42}}', '{"packages":{"nodejs_24":null}}'])(
    'falls back to the pristine role template for a map with non-spec entries %s',
    async (existing) => {
      const client = new FakeClient()
      const dir = DEVBOX_DIR('agent_a1')
      client.setText(`${dir}/.seeded`, 'stale')
      client.setText(`${dir}/devbox.json`, existing)

      await seed(client, 'agent_a1', 'agent')

      expect(client.text(`${dir}/devbox.json`)).toBe(renderDevboxJson('agent'))
    }
  )

  test.each(['{broken', 'null', '[]', '{"packages":"invalid"}'])(
    'falls back to the pristine role template for unusable devbox JSON %s',
    async (existing) => {
      const client = new FakeClient()
      const dir = DEVBOX_DIR('agent_a1')
      client.setText(`${dir}/.seeded`, 'stale')
      client.setText(`${dir}/devbox.json`, existing)

      await seed(client, 'agent_a1', 'agent')

      expect(client.text(`${dir}/devbox.json`)).toBe(renderDevboxJson('agent'))
    }
  )

  test('does not overwrite devbox JSON when reading it fails other than 404', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    client.setText(`${dir}/.seeded`, 'stale')
    client.setText(`${dir}/devbox.json`, '{"packages":["cowsay@latest"]}')
    client.readError = new SandboxHttpError('permission denied', 500)

    await expect(seed(client, 'agent_a1', 'agent')).rejects.toThrow('permission denied')

    expect(client.writes).toHaveLength(0)
    expect(client.installCommands()).toHaveLength(0)
  })

  test('does not reinstall after merging because the marker tracks the pristine template', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    client.setText(`${dir}/.seeded`, 'stale')
    client.setText(`${dir}/devbox.json`, JSON.stringify({ packages: ['cowsay@latest'] }))

    await seed(client, 'agent_a1', 'agent')
    client.writes = []
    client.bashCommands = []
    await seed(client, 'agent_a1', 'agent')

    expect(client.writes).toHaveLength(0)
    expect(client.installCommands()).toHaveLength(0)
  })

  test('a failed `devbox install` rejects and does NOT write the seeded marker', async () => {
    const client = new FakeClient()
    client.bashExit = 1
    client.bashError = 'devbox: network error'

    await expect(seed(client, 'agent_a1', 'agent')).rejects.toThrow()

    // devbox.json may have been written, but the marker must NOT be — so the next
    // ensure retries the install rather than trusting a half-done seed.
    expect(client.markerContent(DEVBOX_DIR('agent_a1'))).toBeUndefined()
  })

  test('a timed-out `devbox install` (non-zero 124 exit) rejects and does NOT write the seeded marker', async () => {
    const client = new FakeClient()
    // The server carries an explicit non-zero exit (124) alongside the timeout
    // error, so the seeder must treat it as a failure — no marker, retry next ensure.
    client.bashExit = 124
    client.bashError = 'Command timed out after 600s'

    await expect(seed(client, 'agent_a1', 'agent')).rejects.toThrow()

    expect(client.markerContent(DEVBOX_DIR('agent_a1'))).toBeUndefined()
  })

  test('devbox install uses a stable invocation identity across later repair cycles', async () => {
    const first = new FakeClient()
    first.bashExit = 1
    await expect(seedBoxDevbox(first as any, 'squad_stable', 'squad', { cacheGet: async () => null })).rejects.toThrow()
    const second = new FakeClient()
    second.bashExit = 1
    await expect(
      seedBoxDevbox(second as any, 'squad_stable', 'squad', { cacheGet: async () => null })
    ).rejects.toThrow()

    expect(first.bashCommands).toHaveLength(1)
    expect(first.bashCommands[0].invocationId).toBeTruthy()
    expect(second.bashCommands[0].invocationId).toBe(first.bashCommands[0].invocationId)
  })

  test('a bash stream that ends without ANY exitCode is treated as a FAILURE (defensive; no marker)', async () => {
    const client = new FakeClient()
    // Even if a future server regression closed the stream WITHOUT an exit code,
    // the seeder must NOT default the missing code to success and mark seeded.
    client.bashExitless = true

    await expect(seed(client, 'agent_a1', 'agent')).rejects.toThrow()

    expect(client.markerContent(DEVBOX_DIR('agent_a1'))).toBeUndefined()
  })

  test('returns a devbox-resolve/devbox-realize split when the install stream crosses devbox\'s "installing to the nix store" marker', async () => {
    const client = new FakeClient()
    // Real devbox output: "Ensuring packages are installed." (stderr) precedes
    // resolution; "Installing the following packages to the nix store: ..."
    // (stderr) is emitted immediately before the actual nix fetch/build/link —
    // see jetify-com/devbox internal/devbox/packages.go. Timestamps below are
    // CORE'S OWN clock (chunk-arrival order), never a remote one.
    client.installChunks = [
      { stderr: 'Ensuring packages are installed.\n' },
      { stderr: 'Installing the following packages to the nix store: ripgrep, fd\n' },
      { stdout: 'done\n' },
    ]
    // now() is called at: install-start, then once per stream 'data' event (chunk1,
    // chunk2-with-marker, chunk3, the final exit-code-only event), then at 'end'.
    const ticks = [1_000, 1_010, 1_300, 1_305, 1_310, 1_900]
    let i = 0
    const fakeNow = () => ticks[i++] ?? ticks[ticks.length - 1]

    const timings = await seed(client, 'agent_a1', 'agent', { now: fakeNow })

    expect(timings['devbox-resolve']).toBeGreaterThan(0)
    expect(timings['devbox-realize']).toBeGreaterThan(0)
    // resolve covers [start..marker-seen], realize covers [marker-seen..end] — no gap/overlap.
    expect((timings['devbox-resolve'] ?? 0) + (timings['devbox-realize'] ?? 0)).toBe(1_900 - 1_000)
  })

  test('falls back to reporting the FULL duration as devbox-resolve (no devbox-realize) when the marker never appears', async () => {
    const client = new FakeClient()
    client.installChunks = [{ stdout: 'some devbox output with no recognizable phase marker\n' }]
    // now() is called at: install-start, the scripted chunk's 'data' event, the
    // final exit-code-only 'data' event, then 'end'. Only start/end matter here.
    const ticks = [1_000, 1_050, 1_090, 1_400]
    let i = 0
    const fakeNow = () => ticks[i++] ?? ticks[ticks.length - 1]

    const timings = await seed(client, 'agent_a1', 'agent', { now: fakeNow })

    expect(timings['devbox-resolve']).toBe(400)
    expect(timings['devbox-realize']).toBeUndefined()
  })

  test('a skipped install (marker already current) returns empty timings — no fabricated resolve/realize split', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    client.files.set(`${dir}/.seeded`, Buffer.from(computeDevboxSeedHash('agent'), 'utf8').toString('base64'))

    const timings = await seed(client, 'agent_a1', 'agent')

    expect(timings).toEqual({})
  })

  test('renderDevboxJson is stable/deterministic (drives the content hash)', () => {
    const roles: SeedBoxRole[] = ['agent', 'squad', 'system-manager']
    for (const role of roles) {
      expect(renderDevboxJson(role)).toBe(renderDevboxJson(role))
      expect(computeDevboxSeedHash(role)).toBe(computeDevboxSeedHash(role))
    }
    // Agent (light) and squad (heavy) produce different content → different hash.
    expect(computeDevboxSeedHash('agent')).not.toBe(computeDevboxSeedHash('squad'))
    // system-manager shares the squad set → same hash.
    expect(computeDevboxSeedHash('system-manager')).toBe(computeDevboxSeedHash('squad'))
  })
})

describe('seedBoxDevbox devbox.lock cache (kills the 48s Nixhub resolve on new boxes)', () => {
  test('cache hit: seeds the cached lock BEFORE install runs, install still runs, marker written', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    const hash = computeDevboxSeedHash('agent')
    const cache = makeFakeCache()
    cache.store.set(hash, '{"cached":"lock"}')

    let lockContentAtInstallTime: string | undefined
    client.onBashCall = (command) => {
      if (command.includes('devbox install')) lockContentAtInstallTime = client.lockContent(dir)
    }

    const timings = await seedBoxDevbox(client as any, 'agent_a1', 'agent', {
      cacheGet: cache.cacheGet,
      cachePut: cache.cachePut,
    })

    // The cached lock was ALREADY on disk by the time `devbox install` ran.
    expect(lockContentAtInstallTime).toBe('{"cached":"lock"}')
    expect(client.installCommands()).toHaveLength(1)
    expect(client.markerContent(dir)).toBe(hash)
    expect(timings['devbox-resolve']).toBeDefined()
    // A cache hit never needs to re-store (FakeClient's install doesn't
    // regenerate a lock; even if it did, the entry already exists).
    expect(cache.putCalls).toHaveLength(0)
  })

  test('cache miss + successful install: the generated lock is read back and stored under the seed hash', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    const hash = computeDevboxSeedHash('agent')
    const cache = makeFakeCache()
    // Model `devbox install` generating a devbox.lock as a side effect — the
    // fake bash stub doesn't simulate devbox's real filesystem writes, so we
    // seed the file it would have produced by the time install completes.
    client.setText(`${dir}/devbox.lock`, '{"generated":"lock"}')

    await seedBoxDevbox(client as any, 'agent_a1', 'agent', {
      cacheGet: cache.cacheGet,
      cachePut: cache.cachePut,
    })

    expect(cache.getCalls).toEqual([hash])
    expect(cache.putCalls).toEqual([{ hash, content: '{"generated":"lock"}' }])
    expect(cache.store.get(hash)).toBe('{"generated":"lock"}')
    expect(client.markerContent(dir)).toBe(hash)
  })

  test('cache miss + an empty/blank generated lock read-back is never cached', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    // Model a truncated/not-yet-flushed devbox.lock — present but blank.
    client.setText(`${dir}/devbox.lock`, '   \n')
    const cache = makeFakeCache()

    await seedBoxDevbox(client as any, 'agent_a1', 'agent', {
      cacheGet: cache.cacheGet,
      cachePut: cache.cachePut,
    })

    expect(cache.putCalls).toHaveLength(0)
    // The seed itself still succeeds (best-effort caching, never blocking).
    expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('agent'))
  })

  test('user-customized devbox.json (merge result is not the pristine render) never reads or writes the lock cache', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    // Existing file has ONE extra user package; merge appends the missing
    // comfort packages, so the merged content differs from the pristine render.
    client.setText(`${dir}/devbox.json`, JSON.stringify({ packages: ['cowsay@latest'] }))
    // Present on disk (as if a prior install produced it) but must be ignored:
    // an unrelated lock must never be seeded into — or read out of — a
    // customized project.
    client.setText(`${dir}/devbox.lock`, '{"generated":"lock"}')
    const cache = makeFakeCache()

    await seedBoxDevbox(client as any, 'agent_a1', 'agent', {
      cacheGet: cache.cacheGet,
      cachePut: cache.cachePut,
    })

    expect(cache.getCalls).toHaveLength(0)
    expect(cache.putCalls).toHaveLength(0)
    // The pre-existing lock content is untouched (we never overwrote it).
    expect(client.lockContent(dir)).toBe('{"generated":"lock"}')
  })

  test('a failed `devbox install` stores nothing in the lock cache', async () => {
    const client = new FakeClient()
    client.bashExit = 1
    client.bashError = 'devbox: network error'
    const cache = makeFakeCache()

    await expect(
      seedBoxDevbox(client as any, 'agent_a1', 'agent', { cacheGet: cache.cacheGet, cachePut: cache.cachePut })
    ).rejects.toThrow()

    expect(cache.putCalls).toHaveLength(0)
  })

  test('cache get/put throwing never fails the seed — it just logs a WARN and behaves as a miss', async () => {
    const client = new FakeClient()
    const dir = DEVBOX_DIR('agent_a1')
    // So the post-install read-back succeeds even though storing it will throw.
    client.setText(`${dir}/devbox.lock`, '{"generated":"lock"}')
    const cacheGet = async (): Promise<string | null> => {
      throw new Error('cache store unreachable')
    }
    const cachePut = async (): Promise<void> => {
      throw new Error('cache store unreachable')
    }

    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const timings = await seedBoxDevbox(client as any, 'agent_a1', 'agent', { cacheGet, cachePut })

      // Seed succeeded end-to-end despite both cache calls throwing.
      expect(client.installCommands()).toHaveLength(1)
      expect(client.markerContent(dir)).toBe(computeDevboxSeedHash('agent'))
      expect(timings['devbox-resolve']).toBeDefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

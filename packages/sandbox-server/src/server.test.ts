import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * Boots the REAL server (bun src/server.ts) as a subprocess and exercises the
 * auth gate + bind address end-to-end over HTTP:
 *  - token configured → 401 without/with-wrong bearer, 200 with the right one,
 *    GET /healthz stays exempt;
 *  - no token configured → no enforcement (the k8s runtime / legacy VM boxes);
 *  - EXECUTOR_BIND honored (server answers on 127.0.0.1 when bound there);
 *  - VM boot without a token (EXECUTOR_BIND or FICUS_BOX_PORT set, no
 *    EXECUTOR_AUTH_TOKEN) → fails closed: exit 1, never binds.
 *
 * FICUS_SANDBOX_ROLE=agent keeps boot light (no dockerd bring-up), mirroring how
 * integration-vm.test.ts starts the box server unit-free.
 */

const SERVER_ENTRY = join(import.meta.dir, 'server.ts')

interface RunningServer {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  base: string
  workspace: string
  outputClosed: Promise<void>
}

const running: RunningServer[] = []

async function waitForExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

async function stopServer(server: RunningServer): Promise<boolean> {
  server.proc.kill()
  let exited = await waitForExit(server.proc, 2_000)
  if (!exited) {
    server.proc.kill('SIGKILL')
    exited = await waitForExit(server.proc, 2_000)
  }
  if (exited) await server.outputClosed
  return exited
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-server-test-'))
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['bun', SERVER_ENTRY], {
      env: {
        ...process.env,
        EXECUTOR_SOCKET: '',
        EXECUTOR_SERVICE_CGROUP: '',
        EXECUTOR_AUTH_TOKEN: '',
        EXECUTOR_BIND: '',
        FICUS_BOX_PORT: '',
        EXECUTOR_DOCKER_RUNTIME: '',
        EXECUTOR_PORT: '0',
        FICUS_SANDBOX_ROLE: 'agent',
        FICUS_BOX_HOME: workspace,
        HOME: workspace,
        // Runtime cache files must not populate this fixture's empty workspace.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        WORKSPACE_PATH: workspace,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true })
    throw error
  }
  let stdout = ''
  let stderr = ''
  // Drain both pipes immediately. The startup message gives us the actual
  // OS-assigned port without a reserve/release race or a random-port collision.
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }))
    append(decoder.decode())
  }
  const outputClosed = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (text) => (stdout += text)),
    drain(proc.stderr as ReadableStream<Uint8Array>, (text) => (stderr += text)),
  ]).then(() => {})
  const server: RunningServer = { proc, port: 0, base: '', workspace, outputClosed }
  running.push(server)

  // Wait for the bound port, then /healthz (before anything slow).
  const deadline = Date.now() + 15_000
  for (;;) {
    const match = stdout.match(/HTTP server listening on [^\n]+:(\d+)/)
    if (match) {
      server.port = Number(match[1])
      server.base = `http://127.0.0.1:${server.port}`
    }
    try {
      if (server.port > 0) {
        const res = await fetch(`${server.base}/healthz`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return server
      }
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null || Date.now() > deadline) {
      const stopped = await stopServer(server)
      if (!stopped) {
        // Keep the entry and workspace registered so afterAll can retry and
        // operator diagnostics retain the owned process context.
        throw new Error(`server never became healthy on ${server.base}; process did not exit after SIGTERM/SIGKILL`)
      }
      const index = running.indexOf(server)
      if (index >= 0) running.splice(index, 1)
      rmSync(workspace, { recursive: true, force: true })
      throw new Error(`server never became healthy on ${server.base}\n${stderr.slice(0, 1_024)}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

afterAll(async () => {
  const leaked: RunningServer[] = []
  for (const server of [...running]) {
    if (!(await stopServer(server))) {
      leaked.push(server)
      continue
    }
    const index = running.indexOf(server)
    if (index >= 0) running.splice(index, 1)
    rmSync(server.workspace, { recursive: true, force: true })
  }
  if (leaked.length > 0) {
    throw new Error(`failed to stop ${leaked.length} owned sandbox server process(es) after SIGKILL escalation`)
  }
})

describe('server auth gate (subprocess)', () => {
  it('enforces the bearer token when EXECUTOR_AUTH_TOKEN is set; /healthz stays exempt', async () => {
    const token = 'test-token-123'
    const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_BIND: '127.0.0.1' })

    expect(server.port).toBeGreaterThan(0)
    // /healthz is exempt (readiness probes are unauthenticated).
    const health = await fetch(`${server.base}/healthz`)
    expect(health.status).toBe(200)

    // No token → 401 on an execution route.
    const noAuth = await fetch(`${server.base}/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(noAuth.status).toBe(401)

    // Wrong token → 401.
    const wrongAuth = await fetch(`${server.base}/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(wrongAuth.status).toBe(401)

    // Right token → served.
    const okAuth = await fetch(`${server.base}/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(okAuth.status).toBe(200)

    // The gate also covers the /shell WS upgrade path (same fetch handler).
    const shellNoAuth = await fetch(`${server.base}/shell`)
    expect(shellNoAuth.status).toBe(401)

    // Process listing and control are execution surface: always authenticated.
    for (const path of ['/processes', '/processes/signal', '/containers/stop']) {
      const response = await fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 2, id: 'x' }),
      })
      expect(response.status).toBe(401)
    }
  }, 30_000)

  // The process view reads /proc, which only Linux (where boxes run) provides.
  it.skipIf(process.platform !== 'linux')(
    'stops an owned process and refuses to signal the server itself',
    async () => {
      const token = 'process-token'
      const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_BIND: '127.0.0.1' })
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
      const target = Bun.spawn(['sleep', '60'])
      try {
        const listed = (await (
          await fetch(`${server.base}/processes`, { method: 'POST', headers, body: '{}' })
        ).json()) as { processes: Array<{ pid: number; protected: boolean }>; pressure: unknown }
        expect(listed.pressure).toBeTruthy()
        expect(listed.processes.some((p) => p.pid === target.pid && !p.protected)).toBe(true)

        const signalled = await fetch(`${server.base}/processes/signal`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ pid: target.pid, signal: 'TERM' }),
        })
        expect(signalled.status).toBe(200)
        expect(await target.exited).not.toBe(0)

        const self = listed.processes.find((p) => p.protected)!
        const refused = await fetch(`${server.base}/processes/signal`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ pid: self.pid }),
        })
        expect(refused.status).toBe(403)
      } finally {
        target.kill()
      }
    },
    30_000
  )

  it('fails closed on malformed JSON only for authenticated body-consuming routes', async () => {
    const token = 'malformed-json-token'
    const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_BIND: '127.0.0.1' })
    const marker = 'sandbox-secret-marker'
    const malformedBody = `{"path":"${marker}"`
    const authorizedHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }

    for (const path of ['/toolchain-ready', '/stat', '/browser/open']) {
      const response = await fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: authorizedHeaders,
        body: malformedBody,
      })
      const text = await response.text()
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(JSON.parse(text)).toEqual({ error: 'Invalid JSON body' })
      expect(text).not.toContain(marker)
    }

    for (const authorization of [undefined, 'Bearer wrong']) {
      const response = await fetch(`${server.base}/stat`, {
        method: 'POST',
        headers: {
          ...(authorization ? { authorization } : {}),
          'content-type': 'application/json',
        },
        body: malformedBody,
      })
      expect(response.status).toBe(401)
    }

    const stoppedRescan = await fetch(`${server.base}/watch/rescan`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: malformedBody,
    })
    const stoppedRescanText = await stoppedRescan.text()
    expect(stoppedRescan.status).toBe(400)
    expect(stoppedRescan.headers.get('content-type')).toBe('text/plain;charset=utf-8')
    expect(stoppedRescanText).toBe('Watcher not started')
    expect(stoppedRescanText).not.toContain('<html')
    expect(stoppedRescanText).not.toContain('server.ts')

    const watch = await fetch(`${server.base}/watch`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({ include: ['**/*'], exclude: [], squadId: 'rescan-test' }),
    })
    expect(watch.status).toBe(200)

    const rescan = await fetch(`${server.base}/watch/rescan`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: malformedBody,
    })
    expect(rescan.status).toBe(200)
    expect(await rescan.json()).toEqual({ ok: true, fileCount: 0, skipped: [] })

    const unknown = await fetch(`${server.base}/unknown`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: malformedBody,
    })
    expect(unknown.status).toBe(404)
  }, 30_000)

  it('every switch-dispatched POST path is in JSON_BODY_PATHS — /bash/cancel regression', async () => {
    // /bash/cancel had a switch case but was missing from the allow-list, so
    // the server 404'd it before dispatch and EVERY bash cancellation failed
    // with BashCleanupUnprovenError. The client-side test mocked fetch and
    // could not see it; this one asks the real server.
    const server = await startServer({ EXECUTOR_AUTH_TOKEN: 'tok' })
    const res = await fetch(`${server.base}/bash/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    })
    // Reaching the handler means a JSON 400 (invocationId required) — never a
    // plain-text 404 from the allow-list gate.
    expect(res.status).toBe(400)
    expect((await res.json()) as { error?: string }).toEqual({ error: 'invocationId is required' })

    // Source-level inventory: every `case '/x':` in the dispatch switch must
    // be in JSON_BODY_PATHS, or the case is unreachable dead code and its
    // route 404s — the exact shape of this regression.
    const src = readFileSync(SERVER_ENTRY, 'utf8')
    const allowList = new Set(
      [...(src.match(/JSON_BODY_PATHS = new Set\(\[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    )
    expect(allowList.size).toBeGreaterThan(0)
    const cases = [...src.matchAll(/case '(\/[^']+)':/g)].map((m) => m[1])
    expect(cases.length).toBeGreaterThan(0)
    for (const path of cases) {
      expect(allowList.has(path)).toBe(true)
    }
  })

  it('does not enforce when EXECUTOR_AUTH_TOKEN is unset (k8s / legacy boxes)', async () => {
    const server = await startServer({})

    const res = await fetch(`${server.base}/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(res.status).toBe(200)

    // A stray bearer header against an unenforcing server stays harmless
    // (rollout: new core client + old server).
    const withHeader = await fetch(`${server.base}/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(withHeader.status).toBe(200)
  }, 30_000)
})

/**
 * Apply systemd `EnvironmentFile=` content the way systemd applies it at
 * exec time: over the given seed environment (the unit's `Environment=`
 * values), in the order the unit lists the files — later files replace earlier
 * ones, and BOTH replace `Environment=` lines regardless of unit order
 * (systemd.exec(5): settings from these files override settings made with
 * `Environment=`). Only the `KEY=value` subset box-manager's writer emits is
 * parsed; comments and blank lines are ignored like systemd ignores them.
 */
function applyEnvironmentFiles(seed: Record<string, string>, files: string[]): Record<string, string> {
  const env = { ...seed }
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (match) env[match[1]!] = match[2]!
    }
  }
  return env
}

describe('server fail-closed on a token-less VM boot (subprocess)', () => {
  /** Spawn the server expecting it to refuse to start; returns exit code + stderr. */
  async function spawnExpectingRefusal(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-server-test-'))
    const proc = Bun.spawn(['bun', SERVER_ENTRY], {
      env: {
        ...process.env,
        EXECUTOR_SOCKET: '',
        EXECUTOR_SERVICE_CGROUP: '',
        EXECUTOR_AUTH_TOKEN: '',
        EXECUTOR_BIND: '',
        FICUS_BOX_PORT: '',
        EXECUTOR_DOCKER_RUNTIME: '',
        EXECUTOR_PORT: String(port),
        FICUS_SANDBOX_ROLE: 'agent',
        FICUS_BOX_HOME: workspace,
        HOME: workspace,
        WORKSPACE_PATH: workspace,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    // The port was never bound (the refusal happens before Bun.serve).
    await expect(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
    rmSync(workspace, { recursive: true, force: true })
    return { code, stderr }
  }

  it('EXECUTOR_BIND set without a token → exit 1, never binds (partial server.env)', async () => {
    const { code, stderr } = await spawnExpectingRefusal({ EXECUTOR_BIND: '127.0.0.1' })
    expect(code).toBe(1)
    expect(stderr).toContain('refusing to start unauthenticated')
  }, 30_000)

  it('FICUS_BOX_PORT set without a token → exit 1 (fresh-provision window: unit env only, no server.env)', async () => {
    // FICUS_BOX_PORT is baked into the box's systemd unit itself, so it is the
    // marker that catches a unit activated BEFORE server.env lands. An empty
    // token counts as unset.
    const { code, stderr } = await spawnExpectingRefusal({ FICUS_BOX_PORT: '50100', EXECUTOR_AUTH_TOKEN: '' })
    expect(code).toBe(1)
    expect(stderr).toContain('refusing to start unauthenticated')
  }, 30_000)

  // The positive case — EXECUTOR_BIND + a token → boots and serves — is the
  // first auth-gate test above.
})

describe('verified atomic write transport', () => {
  it('routes the dedicated verified endpoint through the bearer auth gate and verified handler', async () => {
    const token = 'verified-route-token'
    const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_BIND: '127.0.0.1' })
    const path = join(server.workspace, 'verified-route.txt')
    const original = Buffer.from('SERVER-ORIGINAL')
    const result = Buffer.from('SERVER-RESULT')
    const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
    writeFileSync(path, original)
    const body = JSON.stringify({
      path,
      content: result.toString('base64'),
      expectedOriginal: { bytes: original.byteLength, sha256: sha256(original) },
      expectedResult: { bytes: result.byteLength, sha256: sha256(result) },
    })

    const unauthenticated = await fetch(`${server.base}/write-verified`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const unauthenticatedText = await unauthenticated.text()
    expect(Buffer.byteLength(unauthenticatedText)).toBeLessThanOrEqual(512)
    expect(unauthenticatedText).not.toContain(path)
    expect(unauthenticated.status).toBe(401)
    expect(readFileSync(path)).toEqual(original)

    const verified = await fetch(`${server.base}/write-verified`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    })

    if (!verified.ok) {
      const error = await verified.clone().text()
      expect(Buffer.byteLength(error)).toBeLessThanOrEqual(512)
      for (const forbidden of [path, 'SERVER-ORIGINAL', 'SERVER-RESULT', '.tmp']) {
        expect(error).not.toContain(forbidden)
      }
    }
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ bytesWritten: result.byteLength, sha256: sha256(result) })
    expect(readFileSync(path)).toEqual(result)
  }, 30_000)
})

describe('/browser/* pass-through to the machine ficus-browser socket', () => {
  interface CapturedRequest {
    pathname: string
    method: string
    headers: Record<string, string>
    body: unknown
  }

  /** A fake ficus-browser peer listening on a unix socket, recording what it received. */
  function startFakePeer(sockPath: string, respond: (req: CapturedRequest) => { status: number; body: unknown }) {
    const received: CapturedRequest[] = []
    const peer = Bun.serve({
      unix: sockPath,
      async fetch(req) {
        const url = new URL(req.url)
        const captured: CapturedRequest = {
          pathname: url.pathname,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body: await req.json().catch(() => undefined),
        }
        received.push(captured)
        const { status, body } = respond(captured)
        return Response.json(body, { status })
      },
    })
    return { peer, received }
  }

  it('forwards the box-user + bearer headers and the body, and mirrors the peer status+JSON verbatim', async () => {
    const token = 'browser-proxy-token'
    const sockDir = mkdtempSync(join(tmpdir(), 'ficus-browser-sock-'))
    const sockPath = join(sockDir, 'sock')
    const { peer, received } = startFakePeer(sockPath, () => ({
      status: 200,
      body: { title: 'Example Domain', screenshotBase64: 'ZmFrZS1zY3JlZW5zaG90' },
    }))
    try {
      const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, FICUS_BROWSER_SOCK: sockPath })
      const requestBody = { runId: 'run-1', url: 'https://example.com' }
      const res = await fetch(`${server.base}/browser/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(requestBody),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ title: 'Example Domain', screenshotBase64: 'ZmFrZS1zY3JlZW5zaG90' })

      expect(received.length).toBe(1)
      expect(received[0].pathname).toBe('/open')
      expect(received[0].headers['x-ficus-box-user']).toBe(userInfo().username)
      expect(Object.keys(received[0].headers).filter((name) => name.endsWith('-box-user'))).toEqual([
        'x-ficus-box-user',
      ])
      expect(received[0].headers['authorization']).toBe(`Bearer ${token}`)
      expect(received[0].body).toEqual(requestBody)
    } finally {
      peer.stop(true)
      rmSync(sockDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('passes through a non-200 peer response (429 at machine capacity) verbatim', async () => {
    const token = 'browser-proxy-429-token'
    const sockDir = mkdtempSync(join(tmpdir(), 'ficus-browser-sock-'))
    const sockPath = join(sockDir, 'sock')
    const { peer } = startFakePeer(sockPath, () => ({
      status: 429,
      body: { error: 'browser at capacity on this machine, retry shortly' },
    }))
    try {
      const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, FICUS_BROWSER_SOCK: sockPath })
      const res = await fetch(`${server.base}/browser/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ runId: 'run-2', url: 'https://example.com' }),
      })
      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ error: 'browser at capacity on this machine, retry shortly' })
    } finally {
      peer.stop(true)
      rmSync(sockDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns 503 BROWSER_UNAVAILABLE when the ficus-browser socket is absent', async () => {
    const token = 'browser-proxy-503-token'
    const sockDir = mkdtempSync(join(tmpdir(), 'ficus-browser-sock-'))
    const missingSock = join(sockDir, 'no-such-socket')
    try {
      const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, FICUS_BROWSER_SOCK: missingSock })
      const res = await fetch(`${server.base}/browser/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ runId: 'run-3', url: 'https://example.com' }),
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'browser unavailable on this machine', code: 'BROWSER_UNAVAILABLE' })
    } finally {
      rmSync(sockDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects an unauthenticated /browser/open request through the same auth gate as every other route', async () => {
    const token = 'browser-proxy-auth-token'
    const sockDir = mkdtempSync(join(tmpdir(), 'ficus-browser-sock-'))
    const sockPath = join(sockDir, 'sock')
    const { peer, received } = startFakePeer(sockPath, () => ({ status: 200, body: { ok: true } }))
    try {
      const server = await startServer({ EXECUTOR_AUTH_TOKEN: token, FICUS_BROWSER_SOCK: sockPath })
      const res = await fetch(`${server.base}/browser/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-4', url: 'https://example.com' }),
      })
      expect(res.status).toBe(401)
      expect(received.length).toBe(0)
    } finally {
      peer.stop(true)
      rmSync(sockDir, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * Socket activation (spec D2): on a VM box the server listens on a UNIX socket
 * (`EXECUTOR_SOCKET`) behind systemd-socket-proxyd, and exits(0) after
 * `EXECUTOR_IDLE_EXIT_MS` of quiet so an idle box costs zero RAM (measured:
 * 39 idle bun servers = 1.7 GB on the noah host). Boots the REAL server, so
 * this pins the actual Bun listen + exit behavior, not a model of it.
 */
describe('unix-socket listen + idle self-exit (subprocess)', () => {
  interface UnixServer {
    proc: ReturnType<typeof Bun.spawn>
    sock: string
    dir: string
    workspace: string
  }
  const unixServers: UnixServer[] = []

  async function startUnixServer(env: Record<string, string>, waitForHealth = true): Promise<UnixServer> {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-unix-'))
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-unix-ws-'))
    const sock = join(dir, 'server.sock')
    const proc = Bun.spawn(['bun', SERVER_ENTRY], {
      env: {
        ...process.env,
        EXECUTOR_SOCKET: sock,
        EXECUTOR_SERVICE_CGROUP: '',
        FICUS_SANDBOX_ROLE: 'agent',
        FICUS_BOX_HOME: workspace,
        HOME: workspace,
        WORKSPACE_PATH: workspace,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const server: UnixServer = { proc, sock, dir, workspace }
    unixServers.push(server)
    if (!waitForHealth) return server
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        const res = await fetch('http://localhost/healthz', { unix: sock, signal: AbortSignal.timeout(1000) })
        if (res.ok) return server
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`unix server never became healthy on ${sock}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  afterAll(async () => {
    for (const server of unixServers.splice(0)) {
      server.proc.kill()
      await waitForExit(server.proc, 2_000)
      rmSync(server.dir, { recursive: true, force: true })
      rmSync(server.workspace, { recursive: true, force: true })
    }
  })

  it('serves over EXECUTOR_SOCKET (no TCP port) with the auth gate intact', async () => {
    const token = 'unix-socket-token'
    // EXECUTOR_IDLE_EXIT_MS=0 disables self-exit so the assertions below are not
    // racing the idle timer.
    const server = await startUnixServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_IDLE_EXIT_MS: '0' })

    const health = await fetch('http://localhost/healthz', { unix: server.sock })
    expect(health.status).toBe(200)

    const noAuth = await fetch('http://localhost/stat', {
      method: 'POST',
      unix: server.sock,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(noAuth.status).toBe(401)

    const okAuth = await fetch('http://localhost/stat', {
      method: 'POST',
      unix: server.sock,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(okAuth.status).toBe(200)

    // The socket file is the server's own listener, narrowed to owner+group.
    expect((statSync(server.sock).mode & 0o777).toString(8)).toBe('660')

    // It bound NO TCP port: the process is still alive and answering on the socket.
    expect(server.proc.killed).toBe(false)
  }, 30_000)

  it('re-listens over a STALE socket file left by a crashed predecessor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-unix-stale-'))
    const sock = join(dir, 'server.sock')
    // A leftover regular file at the socket path is exactly what a SIGKILLed
    // predecessor leaves behind; bind() fails on it unless it is unlinked first.
    writeFileSync(sock, '')
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'sandbox-unix-stale-ws-'))
      const proc = Bun.spawn(['bun', SERVER_ENTRY], {
        env: {
          ...process.env,
          EXECUTOR_SOCKET: sock,
          EXECUTOR_SERVICE_CGROUP: '',
          EXECUTOR_AUTH_TOKEN: 'stale-socket-token',
          EXECUTOR_IDLE_EXIT_MS: '0',
          FICUS_SANDBOX_ROLE: 'agent',
          FICUS_BOX_HOME: workspace,
          HOME: workspace,
          WORKSPACE_PATH: workspace,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      unixServers.push({ proc, sock, dir, workspace })
      const deadline = Date.now() + 15_000
      for (;;) {
        try {
          const res = await fetch('http://localhost/healthz', { unix: sock, signal: AbortSignal.timeout(1000) })
          if (res.ok) break
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error('server did not replace the stale socket file')
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      // dir is cleaned up by afterAll via the pushed entry
    }
  }, 30_000)

  it('keeps an active foreground invocation alive without health probes', async () => {
    const token = 'foreground-idle-token'
    const server = await startUnixServer({ EXECUTOR_AUTH_TOKEN: token, EXECUTOR_IDLE_EXIT_MS: '800' })
    const response = await fetch('http://localhost/bash', {
      unix: server.sock,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: 'sleep 2; echo done', sourceEnv: false, activateDevbox: false }),
    })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(
      await Promise.race([
        server.proc.exited,
        new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 50)),
      ])
    ).toBe('alive')
    expect(await response.text()).toContain('exitCode')
    expect(
      await Promise.race([
        server.proc.exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
      ])
    ).toBe(0)
  }, 30_000)

  it('exits 0 after the idle window in a parked-equivalent quiet box with no probes', async () => {
    const server = await startUnixServer({ EXECUTOR_AUTH_TOKEN: 'idle-exit-token', EXECUTOR_IDLE_EXIT_MS: '800' })
    const exited = await Promise.race([
      server.proc.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
    ])
    expect(exited).toBe(0)
    await expect(fetch('http://localhost/healthz', { unix: server.sock })).rejects.toThrow()
  }, 30_000)

  /**
   * The merged #1363 bypass, reproduced and pinned.
   *
   * The provisioned unit carried the service-cgroup ownership marker as
   * `Environment=EXECUTOR_SERVICE_CGROUP=1` ahead of `EnvironmentFile=`
   * host.env/server.env, and systemd applies EnvironmentFile content OVER
   * `Environment=` values regardless of unit order — so any marker value pushed
   * through those configurable files (hostile, empty, or merely mistaken)
   * silently disabled the residual-child census even though
   * `KillMode=control-group` still kills those children at service exit. The
   * authoritative marker is now the unit's ExecStart switch (`--service-cgroup`):
   * argv belongs to the root-installed unit and environment files cannot
   * override it.
   *
   * This test generates BOTH environment files with defeating values, replays
   * systemd's exact exec-time merge over the unit's `Environment=` seed, boots
   * the real entrypoint with the merged environment AND the ExecStart switch,
   * and proves the census/warning path still runs. The census outcome is host
   * dependent and BOTH observable outcomes prove the path was taken: where the
   * census succeeds the server warns with a numeric count and exits 0; where the
   * census is unavailable it FAILS CLOSED and defers the exit. A defeated marker
   * produces neither — a silent immediate exit — so this test is red against the
   * environment-only check (the mutation that reintroduces the defect).
   */
  it('provisioned ExecStart --service-cgroup switch wins over hostile host.env/server.env marker values', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'sandbox-marker-env-'))
    // Conflicting defeating values in BOTH files: host.env forces the marker
    // off, server.env then EMPTIES it (and wins, being listed last).
    writeFileSync(join(envDir, 'host.env'), 'EXECUTOR_SERVICE_CGROUP=0\n')
    writeFileSync(join(envDir, 'server.env'), 'EXECUTOR_SERVICE_CGROUP=\n')
    // Seed with the value the merged unit baked in, then apply host.env →
    // server.env exactly as the unit's EnvironmentFile order does.
    const mergedEnv = applyEnvironmentFiles({ EXECUTOR_SERVICE_CGROUP: '1' }, [
      join(envDir, 'host.env'),
      join(envDir, 'server.env'),
    ])
    // The premise of the defect is real: the configurable files defeat the
    // unit's own `Environment=` line.
    expect(mergedEnv.EXECUTOR_SERVICE_CGROUP).toBe('')

    const dir = mkdtempSync(join(tmpdir(), 'sandbox-unix-marker-'))
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-unix-marker-ws-'))
    const sock = join(dir, 'server.sock')
    const proc = Bun.spawn(['bun', SERVER_ENTRY, '--service-cgroup'], {
      env: {
        ...process.env,
        EXECUTOR_SOCKET: sock,
        ...mergedEnv,
        EXECUTOR_AUTH_TOKEN: 'marker-authority-token',
        EXECUTOR_IDLE_EXIT_MS: '1500',
        FICUS_SANDBOX_ROLE: 'agent',
        FICUS_BOX_HOME: workspace,
        HOME: workspace,
        WORKSPACE_PATH: workspace,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    unixServers.push({ proc, sock, dir, workspace })

    // Wait for /healthz on the unix socket before spawning the residual child.
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        const res = await fetch('http://localhost/healthz', { unix: sock, signal: AbortSignal.timeout(1000) })
        if (res.ok) break
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('marker server never became healthy')
      await new Promise((r) => setTimeout(r, 50))
    }

    // The #1363 scenario: a detached child the service contract does not
    // support. It must be counted (Linux) — never silently swept at idle exit.
    const token = 'marker-authority-token'
    const bash = await fetch('http://localhost/bash', {
      unix: sock,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        command: 'setsid sh -c "sleep 30" >/dev/null 2>&1 & echo $! > detached.pid; echo spawned',
        sourceEnv: false,
        activateDevbox: false,
      }),
    })
    expect(bash.status).toBe(200)

    // (A plain type alias — `as const` inside a `new Promise<...>` generic arg
    // breaks Bun 1.3.8's transpiled executor.)
    type MarkerOutcome = { state: 'exited'; code: number } | { state: 'alive' }
    const outcome = await Promise.race([
      proc.exited.then((code): MarkerOutcome => ({ state: 'exited', code })),
      new Promise<MarkerOutcome>((resolve) => setTimeout(() => resolve({ state: 'alive' }), 10_000)),
    ])
    if (outcome.state === 'alive') {
      // Census unavailable on this host: the server must have deferred the exit
      // (fail-closed) instead of skipping the census entirely.
      proc.kill()
      await waitForExit(proc, 2_000)
    }
    const output =
      (await new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => '')) +
      (await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => ''))

    if (outcome.state === 'exited') {
      expect(outcome.code).toBe(0)
      expect(output).toMatch(/idle exit will terminate [1-9]\d* unsupported background process(es)?/)
      // The warning stays sanitized: no command text from the counted child.
      expect(output).not.toContain('sleep 30')
      expect(output).not.toContain('setsid')
    } else {
      expect(output).toMatch(/idle exit deferred because service cgroup child count is unavailable/)
    }

    // Best-effort cleanup of the detached child (it self-reaps after 30s).
    try {
      const pid = Number(readFileSync(join(workspace, 'detached.pid'), 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
    rmSync(envDir, { recursive: true, force: true })
  }, 45_000)

  it('never self-exits without EXECUTOR_SOCKET — a TCP (k8s/docker) server has nothing to re-activate it', async () => {
    const server = await startServer({ EXECUTOR_AUTH_TOKEN: 'tcp-no-idle-exit', EXECUTOR_IDLE_EXIT_MS: '300' })
    // Well past 4 windows: a socket-mode server with this window would be gone.
    await new Promise((r) => setTimeout(r, 3_000))
    const health = await fetch(`${server.base}/healthz`)
    expect(health.status).toBe(200)
  }, 30_000)
})

import { afterEach, expect, test } from 'bun:test'
import { createGatewayHandler, gatewayManifestSchema } from './gateway-policy'
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const a = `bb-${id.replaceAll('-', '')}.example.com`
const b = `bb-${other.replaceAll('-', '')}.example.com`
const manifest = {
  contractVersion: 1,
  tenantId: id,
  physicalHostBinding: other,
  hostEpoch: 1,
  hostState: 'active',
  routes: [
    { vaultId: id, upstreamVaultId: other, origin: `https://${a}`, localPort: 30000, state: 'ready' },
    { vaultId: other, upstreamVaultId: id, origin: `https://${b}`, localPort: 30001, state: 'ready' },
  ],
}
const request = (host = a, path = '/v1/whoami', init?: RequestInit) =>
  new Request(`http://127.0.0.1:34792${path}`, {
    ...init,
    headers: { Host: host, ...Object.fromEntries(new Headers(init?.headers)) },
  })
const active: Response[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((response) => response.body?.cancel().catch(() => {})))
})
async function retained(promise: Promise<Response>) {
  const response = await promise
  active.push(response)
  return response
}

test('credential-free manifest is strict, bounded, identity-preserving and contains no paths', () => {
  expect(gatewayManifestSchema.safeParse(manifest).success).toBe(true)
  expect(
    gatewayManifestSchema.safeParse({ ...manifest, routes: [{ ...manifest.routes[0], localPort: 50000 }] }).success
  ).toBe(true)
  for (const localPort of [80, 3000, 34792, 65536])
    expect(
      gatewayManifestSchema.safeParse({ ...manifest, routes: [{ ...manifest.routes[0], localPort }] }).success
    ).toBe(false)
  for (const key of ['token', 'path', 'owner', 'credentials'])
    expect(gatewayManifestSchema.safeParse({ ...manifest, [key]: 'PRIVATE' }).success).toBe(false)
  expect(
    gatewayManifestSchema.safeParse({ ...manifest, routes: [manifest.routes[0], manifest.routes[0]] }).success
  ).toBe(false)
  expect(
    gatewayManifestSchema.safeParse({
      ...manifest,
      routes: [{ ...manifest.routes[0], origin: 'http://169.254.169.254' }],
    }).success
  ).toBe(false)
})
test('unknown hosts, foreign ports, ambiguous paths and Core/metadata routes cannot select a target', async () => {
  let calls = 0
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => {
      calls++
      return new Response('ok')
    },
  })
  for (const [host, path] of [
    ['unknown.example.com', '/v1/whoami'],
    [`${a}:443`, '/v1/whoami'],
    [a, '/api/secrets'],
    [a, '/v1/%2fwhoami'],
    [a, '/v1/evidence/../..//api'],
    [a, '/latest/meta-data'],
  ]) {
    expect((await handle(request(host, path))).status).toBe(404)
  }
  expect(calls).toBe(0)
})
test('forwards auth only to the exact recorded loopback route and preserves upstream browser security headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response('native response', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Security-Policy': "default-src 'none'",
          'Referrer-Policy': 'no-referrer',
          'BigBrain-Protocol': '1',
        },
      })
    },
  })
  const response = await retained(
    handle(request(b, '/v1/whoami', { headers: { Authorization: 'Bearer PRIVATE', 'X-Forwarded-Host': 'evil' } }))
  )
  expect(await response.text()).toBe('native response')
  expect(calls[0]!.url).toBe('http://127.0.0.1:30001/v1/whoami')
  expect(calls[0]!.init.redirect).toBe('manual')
  expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer PRIVATE')
  expect(new Headers(calls[0]!.init.headers).get('X-Forwarded-Host')).toBe(null)
  expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'")
  expect(response.headers.get('BigBrain-Protocol')).toBe('1')
})
test('does not forward stale transfer lengths or encoding after fetch decoding', async () => {
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => new Response('decoded', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '20' } }),
  })
  const response = await retained(handle(request()))
  expect(response.headers.get('Content-Encoding')).toBe(null)
  expect(response.headers.get('Content-Length')).toBe(null)
  expect(await response.text()).toBe('decoded')
})

test('preserves the pinned invite font assets, not an arbitrary public asset proxy', async () => {
  let calls = 0
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => {
      calls++
      return new Response('font')
    },
  })
  for (const path of ['/assets/hanken-grotesk-latin.woff2', '/assets/hanken-grotesk-latin-ext.woff2']) {
    const response = await retained(handle(request(a, path)))
    expect(response.status).toBe(200)
    await response.text()
  }
  expect((await handle(request(a, '/assets/secret.txt'))).status).toBe(404)
  expect(calls).toBe(2)
})

test('holds per-vault and aggregate permits through response consumption; other vault remains independently usable', async () => {
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => new Response(new ReadableStream({ pull() {} })),
  })
  const first = await retained(handle(request()))
  const second = await retained(handle(request()))
  expect((await handle(request())).status).toBe(429)
  const third = await retained(handle(request(b)))
  const fourth = await retained(handle(request(b)))
  expect((await handle(request(b))).status).toBe(429)
  await first.body!.cancel()
  await second.body!.cancel()
  await third.body!.cancel()
  await fourth.body!.cancel()
  const next = await retained(handle(request()))
  expect(next.status).toBe(200)
})
test('abort does not release admission before the owned upstream fetch settles', async () => {
  let resolve!: (response: Response) => void
  let entered!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  let calls = 0
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => {
      if (++calls === 1) {
        entered()
        return new Promise<Response>((r) => {
          resolve = r
        })
      }
      return new Response(new ReadableStream({ pull() {} }))
    },
  })
  const abort = new AbortController()
  const first = handle(request(a, '/v1/whoami', { signal: abort.signal }))
  await started
  abort.abort()
  const second = await retained(handle(request()))
  expect((await handle(request())).status).toBe(429)
  resolve(new Response('PRIVATE'))
  const cancelled = await first
  expect(cancelled.status).toBe(503)
  expect(await cancelled.text()).not.toContain('PRIVATE')
  await second.body!.cancel()
})

test('one mutation per vault is admitted with no queue, while a read can proceed', async () => {
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => new Response(new ReadableStream({ pull() {} })),
  })
  const mutation = request(a, '/v1/evidence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  await retained(handle(mutation))
  expect((await handle(request(a, '/v1/evidence', { method: 'POST', body: '{}' }))).status).toBe(429)
  expect((await retained(handle(request()))).status).toBe(200)
})
test('bounded token buckets use vault identity rather than caller/token/IP churn', async () => {
  let now = 0
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    now: () => now,
    fetch: async () => new Response('ok'),
  })
  for (let i = 0; i < 10; i++) {
    const response = await retained(handle(request(a, '/v1/whoami', { headers: { Authorization: `Bearer ${i}` } })))
    expect(response.status).toBe(200)
    await response.text()
  }
  expect((await handle(request())).status).toBe(429)
  now = 1000
  const response = await retained(handle(request()))
  expect(response.status).toBe(200)
  await response.text()
})
test('stream caps reject oversized input/output without reflecting payload or errors', async () => {
  let calls = 0
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async (_url, init) => {
      calls++
      if (init.body) await new Response(init.body as ReadableStream<Uint8Array>).text()
      return new Response('ok')
    },
  })
  const oversized = await handle(
    request(a, '/v1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'PRIVATE'.repeat(200000),
    })
  )
  expect(oversized.status).toBe(413)
  expect(await oversized.text()).not.toContain('PRIVATE')
  expect(calls).toBe(0)
  let cancelled = false
  const largeOutput = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          },
        })
      ),
  })
  const response = await retained(largeOutput(request()))
  await expect(response.text()).rejects.toThrow('output_limit')
  expect(cancelled).toBe(true)
})
test('never follows redirects and only passes pinned native/OAuth callback destinations unchanged', async () => {
  let location = 'http://169.254.169.254/latest'
  const handle = createGatewayHandler({
    manifest: async () => manifest,
    fetch: async () => new Response(null, { status: 302, headers: { Location: location } }),
  })
  expect((await handle(request(a, '/authorize'))).status).toBe(502)
  location = 'https://claude.ai/api/mcp/auth_callback?code=PRIVATE&state=STATE'
  const response = await retained(handle(request(a, '/authorize')))
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toBe(location)
})
test('suspension, stale/invalid manifest and removed routes fail closed without fetching', async () => {
  let current: unknown = { ...manifest, hostState: 'suspended' }
  let calls = 0
  const handle = createGatewayHandler({
    manifest: async () => current,
    fetch: async () => {
      calls++
      return new Response('PRIVATE')
    },
  })
  expect((await handle(request())).status).toBe(503)
  current = { ...manifest, token: 'PRIVATE' }
  expect((await handle(request())).status).toBe(503)
  current = { ...manifest, routes: [] }
  expect((await handle(request())).status).toBe(404)
  expect(calls).toBe(0)
})

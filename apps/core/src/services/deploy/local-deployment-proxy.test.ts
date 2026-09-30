import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { like } from 'drizzle-orm'
import { brotliCompressSync, brotliDecompressSync, deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import {
  createLocalDeployment,
  stopLocalDeploymentRecord,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { configureLocalDeploymentProxyDependencies, proxyLocalDeploymentRequest } from './local-deployment-proxy'

const LEGACY_TOKEN_QUERY_PARAM = '_tau_token' // ficus-p5-bridge

describe('localDeployment proxy', () => {
  let testPrefix: string
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []

  beforeEach(() => {
    testPrefix = `local-deployment-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    fetchCalls.length = 0
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
      fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: url.toString(), init: init ?? {} })
        return new Response('proxied', { status: 201, headers: { 'content-type': 'text/plain' } })
      }) as unknown as typeof fetch,
    })
  })

  afterEach(async () => {
    configureLocalDeploymentProxyDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  function localDeploymentUrl(localDeployment: { urlPathOrHost: string }, path = '', query = ''): string {
    const url = new URL(`http://ficus.test${localDeployment.urlPathOrHost}`)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    if (query) {
      for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value)
    }
    return url.toString()
  }

  /** The token is not on the DTO; it rides the URL Ficus hands the browser. */
  function browserToken(localDeployment: { urlPathOrHost: string }): string {
    return new URL(`http://ficus.test${localDeployment.urlPathOrHost}`).searchParams.get('_ficus_token') ?? ''
  }

  async function createTestSquad(): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'LocalDeployment proxy test squad' })
      .returning()
    return new Squad(row)
  }

  it('refuses missing localDeployments', async () => {
    const response = await proxyLocalDeploymentRequest(
      '00000000-0000-0000-0000-000000000000',
      new Request('http://ficus.test/api/app/missing/'),
      ''
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('refuses stopped localDeployments', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await stopLocalDeploymentRecord(localDeployment.id)

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`),
      ''
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects missing or invalid browser localDeployment tokens without Ficus auth', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const missing = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`),
      ''
    )
    const invalid = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/?_ficus_token=wrong`),
      ''
    )

    expect(missing.status).toBe(401)
    expect(invalid.status).toBe(401)
    expect(missing.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(invalid.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('ensures the squad sandbox and retries target resolution when core has not adopted it yet', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    const ensureCalls: string[] = []
    const targetCalls: string[] = []
    configureLocalDeploymentProxyDependencies({
      ensureSquadSandbox: async (squadOrId) => {
        ensureCalls.push(typeof squadOrId === 'string' ? squadOrId : squadOrId.id)
        return '/workspace'
      },
      resolveLocalDeploymentTarget: async (sandboxId) => {
        targetCalls.push(sandboxId)
        if (targetCalls.length === 1) throw new Error(`Sandbox not found: ${localDeployment.sandboxId}`)
        return { host: '127.0.0.1', port: 5173 }
      },
      fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: url.toString(), init: init ?? {} })
        return new Response('proxied', { status: 201 })
      }) as unknown as typeof fetch,
    })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment)),
      ''
    )

    expect(response.status).toBe(201)
    expect(ensureCalls).toEqual([squad.id])
    expect(targetCalls).toEqual([localDeployment.sandboxId, localDeployment.sandboxId])
  })

  it('forwards method, path, query, and body with a valid browser localDeployment token', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(
        localDeploymentUrl(localDeployment, 'api/items', `filter=all&${LEGACY_TOKEN_QUERY_PARAM}=forwarded-by-bridge`),
        {
          method: 'POST',
          body: 'hello',
          headers: { 'content-type': 'text/plain' },
        }
      ),
      'api/items'
    )

    expect(response.status).toBe(201)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:5173/api/items?filter=all')
    expect(fetchCalls[0].url).not.toContain('_ficus_token')
    // The Platform bridge may forward the credential under its old name too: never to the app.
    expect(fetchCalls[0].url).not.toContain(LEGACY_TOKEN_QUERY_PARAM)
    expect(fetchCalls[0].init.method).toBe('POST')
    expect(await new Response(fetchCalls[0].init.body as BodyInit).text()).toBe('hello')
  })

  it('strips an app-supplied proxy-error marker while preserving the app response', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
      fetch: mock(
        async () =>
          new Response('app-owned error', {
            status: 500,
            headers: { 'x-ficus-app-proxy': 'error', 'content-type': 'text/plain' },
          })
      ) as unknown as typeof fetch,
    })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment, 'status')),
      'status'
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('x-ficus-app-proxy')).toBeNull()
    expect(await response.text()).toBe('app-owned error')
  })

  it('preserves response status and content-type', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment, 'status')),
      'status'
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('proxied')
  })

  it("sets a path-scoped cookie so the app's own asset requests authenticate", async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment)),
      ''
    )

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`ficus_app_${localDeployment.id}=`)
    // Path scoping is the security boundary — it keeps this credential off
    // Ficus's own API and off every other deployment.
    expect(cookie).toContain(`Path=/api/app/${localDeployment.id}/`)
    expect(cookie).toContain('HttpOnly')
  })

  it('accepts the cookie alone, which is how subresources load at all', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    // No query string: exactly what the browser sends for /assets/index-*.js.
    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/assets/index-abc.js`, {
        headers: { cookie: `ficus_app_${localDeployment.id}=${browserToken(localDeployment)}` },
      }),
      'assets/index-abc.js'
    )

    expect(res.status).toBe(201)
    expect(fetchCalls[0].url).toContain('/assets/index-abc.js')
    // Nothing to re-mint: the request already carried the credential.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('still refuses a wrong cookie value', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/assets/x.js`, {
        headers: { cookie: `ficus_app_${localDeployment.id}=nope` },
      }),
      'assets/x.js'
    )

    expect(res.status).toBe(401)
  })

  it('does not forward Ficus auth credentials', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    await proxyLocalDeploymentRequest(
      localDeployment.id,
      // Use the valid signed URL (carries _ficus_token) so the request authenticates,
      // then assert the Ficus auth credentials are not forwarded upstream.
      new Request(localDeploymentUrl(localDeployment), {
        headers: {
          authorization: 'Bearer ficus-token',
          'x-auth-token': 'ficus-token',
          cookie: 'ficus_password=secret; other=value',
          'x-keep': 'yes',
        },
      }),
      ''
    )

    const headers = fetchCalls[0].init.headers as Headers
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-auth-token')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.get('x-keep')).toBe('yes')
  })

  it('requires a valid browser token even when Ficus auth credentials are present', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    // Ficus auth header but NO _ficus_token: previously a Ficus auth header
    // short-circuited the token check and proxied (201). Must now be 401.
    const noToken = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`, {
        headers: { authorization: 'Bearer ficus-session' },
      }),
      ''
    )
    expect(noToken.status).toBe(401)

    // Wrong token, also rejected — never reaches the upstream fetch.
    const wrongToken = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/?_ficus_token=wrong`, {
        headers: { authorization: 'Bearer ficus-session' },
      }),
      ''
    )
    expect(wrongToken.status).toBe(401)
    expect(fetchCalls).toHaveLength(0)
  })

  it('does not forward hop-by-hop headers', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment), {
        headers: { connection: 'keep-alive, x-hop', upgrade: 'websocket', 'x-hop': 'remove-me', 'x-keep': 'yes' },
      }),
      ''
    )

    const headers = fetchCalls[0].init.headers as Headers
    expect(headers.has('connection')).toBe(false)
    expect(headers.has('upgrade')).toBe(false)
    expect(headers.has('keep-alive')).toBe(false)
    expect(headers.has('x-hop')).toBe(false)
    expect(headers.get('x-keep')).toBe('yes')
  })

  // Real sockets end to end: an app upstream that compresses, the proxy served
  // by Bun.serve as Core serves it, and a client that reads the raw wire bytes
  // (decompress: false) and decodes them per the Content-Encoding it received,
  // as a browser does. Bun's default fetch decodes the body but kept the
  // upstream Content-Encoding, which browsers reject as
  // ERR_CONTENT_DECODING_FAILED.
  describe('compressed upstream responses', () => {
    const asset = 'body{color:red}\n'.repeat(400)
    const encoders: Record<string, (input: string) => Uint8Array<ArrayBuffer>> = {
      gzip: (input) => new Uint8Array(gzipSync(input)),
      br: (input) => new Uint8Array(brotliCompressSync(input)),
      deflate: (input) => new Uint8Array(deflateSync(input)),
      zstd: (input) => new Uint8Array(Bun.zstdCompressSync(input)),
    }
    const decoders: Record<string, (input: Uint8Array) => string> = {
      gzip: (input) => gunzipSync(input).toString(),
      br: (input) => brotliDecompressSync(input).toString(),
      deflate: (input) => inflateSync(input).toString(),
      zstd: (input) => new TextDecoder().decode(Bun.zstdDecompressSync(input)),
    }

    let upstream: ReturnType<typeof Bun.serve>
    let front: ReturnType<typeof Bun.serve>
    let upstreamAcceptEncodings: Array<string | null>

    beforeEach(() => {
      upstreamAcceptEncodings = []
      upstream = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          upstreamAcceptEncodings.push(req.headers.get('accept-encoding'))
          const url = new URL(req.url)
          const encoding = url.searchParams.get('encoding')
          if (url.pathname === '/_next/static/not-modified.css')
            return new Response(null, { status: 304, headers: { etag: '"v1"', 'content-encoding': 'gzip' } })
          if (url.pathname === '/_next/static/empty') return new Response(null, { status: 204 })
          if (url.pathname === '/_next/static/plain.css')
            return new Response(asset, { headers: { 'content-type': 'text/css' } })
          const encoded = encoders[encoding ?? 'gzip'](asset)
          const headers: Record<string, string> = { 'content-type': 'text/css', 'content-encoding': encoding ?? 'gzip' }
          if (url.pathname === '/_next/static/marked.css') headers['x-ficus-app-proxy'] = 'error'
          if (url.pathname === '/_next/static/streamed.css') {
            const middle = Math.floor(encoded.length / 2)
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoded.subarray(0, middle))
                  controller.enqueue(encoded.subarray(middle))
                  controller.close()
                },
              }),
              { headers }
            )
          }
          return new Response(encoded, { headers })
        },
      })
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: upstream.port! }),
        fetch,
      })
    })

    afterEach(() => {
      upstream.stop(true)
      front?.stop(true)
    })

    async function runningDeployment() {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      front = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          const path = new URL(req.url).pathname.replace(`/api/app/${localDeployment.id}/`, '')
          return proxyLocalDeploymentRequest(localDeployment.id, req, path)
        },
      })
      return localDeployment
    }

    /** A browser-like request to the proxy, keeping the raw bytes on the wire. */
    async function browserFetch(
      localDeployment: { id: string; urlPathOrHost: string },
      path: string,
      { query = '', method = 'GET', withCookie = true } = {}
    ) {
      const url = new URL(localDeploymentUrl(localDeployment, path, query))
      const token = url.searchParams.get('_ficus_token')
      if (withCookie) url.searchParams.delete('_ficus_token')
      const response = await fetch(`http://127.0.0.1:${front.port}${url.pathname}${url.search}`, {
        method,
        headers: {
          'accept-encoding': 'gzip, deflate, br, zstd',
          ...(withCookie ? { cookie: `ficus_app_${localDeployment.id}=${token}` } : {}),
        },
        decompress: false,
      })
      return { response, bytes: new Uint8Array(await response.arrayBuffer()) }
    }

    it.each(Object.keys(encoders))(
      'passes a %s-encoded asset through byte for byte with its Content-Encoding',
      async (encoding) => {
        const localDeployment = await runningDeployment()

        const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', {
          query: `encoding=${encoding}`,
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-encoding')).toBe(encoding)
        expect(bytes).toEqual(encoders[encoding](asset))
        const contentLength = response.headers.get('content-length')
        if (contentLength !== null) expect(Number(contentLength)).toBe(bytes.length)
        expect(decoders[encoding](bytes)).toBe(asset)
        // The browser's Accept-Encoding still reaches the app.
        expect(upstreamAcceptEncodings[0]).toBe('gzip, deflate, br, zstd')
      }
    )

    it('passes a streamed gzip body through intact', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/streamed.css')

      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(decoders.gzip(bytes)).toBe(asset)
    })

    it('keeps the encoded body intact on the cookie-minting (URL token) request', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', {
        query: 'encoding=br',
        withCookie: false,
      })

      expect(response.headers.get('set-cookie')).toContain(`ficus_app_${localDeployment.id}=`)
      expect(response.headers.get('content-encoding')).toBe('br')
      expect(decoders.br(bytes)).toBe(asset)
    })

    it('strips an app-forged error marker from an encoded response without touching the body', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/marked.css')

      expect(response.headers.get('x-ficus-app-proxy')).toBeNull()
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(decoders.gzip(bytes)).toBe(asset)
    })

    it('answers HEAD with the encoded headers and no body', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', { method: 'HEAD' })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(bytes.length).toBe(0)
    })

    it('passes 304 and 204 through without a body', async () => {
      const localDeployment = await runningDeployment()

      const notModified = await browserFetch(localDeployment, '_next/static/not-modified.css')
      const empty = await browserFetch(localDeployment, '_next/static/empty')

      expect(notModified.response.status).toBe(304)
      expect(notModified.response.headers.get('etag')).toBe('"v1"')
      expect(notModified.bytes.length).toBe(0)
      expect(empty.response.status).toBe(204)
      expect(empty.bytes.length).toBe(0)
    })

    it('leaves an uncompressed response unchanged', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/plain.css')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('content-type')).toBe('text/css')
      expect(new TextDecoder().decode(bytes)).toBe(asset)
    })
  })
})

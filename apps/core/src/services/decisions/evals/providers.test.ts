import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendProviders, resolveProviders } from './providers'

const keys = [
  'FICUS_API_URL',
  'FICUS_TOKEN',
  'FICUS_AGENT_CONTEXT',
  'FICUS_WEBHOOK_CONTEXT',
  'FICUS_AUTH_STORE',
  'FICUS_DEV_AUTH_STORE_PATH',
] as const
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
let server: ReturnType<typeof Bun.serve> | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.stop(true)
  server = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

function fixture() {
  const requests: Array<{ path: string; authorization: string | null; body?: unknown }> = []
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        ...(request.method === 'POST' ? { body: await request.json() } : {}),
      })
      if (request.method === 'POST')
        return Response.json({ ok: true, result: { answers: { yes: { type: 'yesno', probability: 0.9 } } } })
      return Response.json({
        providers: [
          {
            id: 'configured',
            kind: 'jev',
            label: 'Jev',
            model: 'jev-latest',
            enabled: true,
            effectivePricePerMillionInput: 0.1,
          },
        ],
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

function savedBackend(url: string) {
  dir = mkdtempSync(join(tmpdir(), 'eval-auth-'))
  const path = join(dir, 'auth.json')
  writeFileSync(path, JSON.stringify({ backends: { selected: { apiUrl: url, password: 'fixture-backend-token' } } }))
  process.env.FICUS_AUTH_STORE = path
  return path
}

test('worker uses only injected API URL and token with the narrow endpoints and feature', async () => {
  const { url, requests } = fixture()
  process.env.FICUS_API_URL = `${url}/`
  process.env.FICUS_TOKEN = 'fixture-worker-token'
  process.env.FICUS_AGENT_CONTEXT = '1'
  process.env.FICUS_AUTH_STORE = '/does-not-exist'
  const [provider] = await resolveProviders('worker')
  expect(provider?.pricePerMillionInput).toBe(0.1)
  await provider!.ask(
    { state: 'case', questions: { yes: { type: 'yesno', instructions: 'Yes?' } } },
    AbortSignal.timeout(1000),
    'tool-results'
  )
  expect(requests).toEqual([
    { path: '/api/decisions/evaluate', authorization: 'Bearer fixture-worker-token' },
    {
      path: '/api/decisions/evaluate',
      authorization: 'Bearer fixture-worker-token',
      body: {
        providerId: 'configured',
        purpose: 'tool-results',
        state: 'case',
        questions: { yes: { type: 'yesno', instructions: 'Yes?' } },
      },
    },
  ])
})

test('worker fails closed with incomplete environment, even when a saved backend exists', async () => {
  const { url, requests } = fixture()
  savedBackend(url)
  delete process.env.FICUS_TOKEN
  process.env.FICUS_API_URL = url
  await expect(resolveProviders('worker')).rejects.toThrow('FICUS_TOKEN')
  process.env.FICUS_TOKEN = 'fixture-worker-token'
  delete process.env.FICUS_API_URL
  await expect(resolveProviders('worker')).rejects.toThrow('FICUS_API_URL')
  expect(requests).toEqual([])
})

test('explicit labeled backend wins over ambient env outside agent context', async () => {
  const { url, requests } = fixture()
  savedBackend(url)
  delete process.env.FICUS_AGENT_CONTEXT
  delete process.env.FICUS_WEBHOOK_CONTEXT
  process.env.FICUS_API_URL = 'http://127.0.0.1:1'
  process.env.FICUS_TOKEN = 'wrong-env-token'
  await backendProviders('selected')
  expect(requests[0]?.authorization).toBe('Bearer fixture-backend-token')
  expect(requests[0]?.path).toBe('/api/decisions/evaluate')
})

test('agent and webhook contexts cannot assume a saved human backend', async () => {
  const { url, requests } = fixture()
  savedBackend(url)
  process.env.FICUS_AGENT_CONTEXT = '1'
  await expect(backendProviders('selected')).rejects.toThrow('injected identity')
  delete process.env.FICUS_AGENT_CONTEXT
  process.env.FICUS_WEBHOOK_CONTEXT = '1'
  await expect(backendProviders('selected')).rejects.toThrow('injected identity')
  expect(requests).toEqual([])
})

test('bad API URLs are refused without including URL credentials in diagnostics', async () => {
  process.env.FICUS_TOKEN = 'fixture-worker-token'
  for (const url of [
    'not-a-url-secret',
    'https://name:secret@example.test',
    'file:///secret',
    'https://example.test/?token=secret',
    'https://example.test/#secret',
  ]) {
    process.env.FICUS_API_URL = url
    await expect(resolveProviders('worker')).rejects.toThrow('Invalid Ficus API URL')
    try {
      await resolveProviders('worker')
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
  }
})

test('remote failure bodies and transport errors are not surfaced as credentials', async () => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) =>
      request.method === 'GET'
        ? Response.json({
            providers: [{ id: 'configured', label: 'Jev', kind: 'jev', model: 'jev-latest', enabled: true }],
          })
        : new Response('fixture-secret-token', { status: 429 }),
  })
  process.env.FICUS_API_URL = `http://127.0.0.1:${server.port}`
  process.env.FICUS_TOKEN = 'fixture-worker-token'
  const [provider] = await resolveProviders('worker')
  await expect(
    provider!.ask(
      { state: '', questions: { yes: { type: 'yesno', instructions: 'Yes?' } } },
      AbortSignal.timeout(1000),
      'tool-results'
    )
  ).rejects.toThrow('HTTP 429')
})

test('legacy dev auth path still works; malformed stores never quote their content', async () => {
  const { url } = fixture()
  const path = savedBackend(url)
  delete process.env.FICUS_AGENT_CONTEXT
  delete process.env.FICUS_WEBHOOK_CONTEXT
  delete process.env.FICUS_AUTH_STORE
  process.env.FICUS_DEV_AUTH_STORE_PATH = path
  expect(await backendProviders('selected')).toHaveLength(1)
  writeFileSync(path, '{"password":"fixture-secret-token" BROKEN')
  await expect(backendProviders('selected')).rejects.toThrow('Invalid CLI auth store')
})

test('injected contexts default to worker without falling back to a database or saved login', async () => {
  const { url, requests } = fixture()
  process.env.FICUS_AGENT_CONTEXT = '1'
  process.env.FICUS_API_URL = url
  process.env.FICUS_TOKEN = 'fixture-worker-token'
  await resolveProviders()
  expect(requests[0]?.authorization).toBe('Bearer fixture-worker-token')
})

test('env and explicit local selection keep their existing semantics without falling back', async () => {
  const { envProviders, localProviders, PLACEHOLDER_DATABASE_URL } = await import('./providers')
  const providers = await envProviders({ FICUS_EVAL_JEV_API_KEY: 'fixture-key', FICUS_EVAL_JEV_MODEL: 'jev-preview' })
  expect(providers).toMatchObject([{ id: 'env-jev', model: 'jev-preview', readsImages: false }])
  expect(await envProviders({})).toEqual([])
  const prior = process.env.DATABASE_URL
  try {
    process.env.DATABASE_URL = PLACEHOLDER_DATABASE_URL
    await expect(localProviders()).rejects.toThrow('No DATABASE_URL')
    await expect(resolveProviders('nonsense')).rejects.toThrow('Unknown provider source')
  } finally {
    if (prior === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = prior
  }
})

test('redirects do not send a worker token to another origin', async () => {
  let received = 0
  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      received++
      return Response.json({ providers: [] })
    },
  })
  try {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.redirect(`http://127.0.0.1:${other.port}/api/decisions/evaluate`),
    })
    process.env.FICUS_API_URL = `http://127.0.0.1:${server.port}`
    process.env.FICUS_TOKEN = 'fixture-worker-token'
    await expect(resolveProviders('worker')).rejects.toThrow('Could not reach the evaluation API')
    expect(received).toBe(0)
  } finally {
    await other.stop(true)
  }
})

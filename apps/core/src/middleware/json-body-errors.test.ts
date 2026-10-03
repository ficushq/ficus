import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WORKSPACE_DOT_DIR, prepareWorkspaceDotDir } from '../services/workspace/dot-dir'
import { describe, expect, test } from 'bun:test'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  INVALID_JSON_BODY_MESSAGE,
  jsonBodyErrorHandler,
  jsonBodyErrorMiddleware,
  MalformedJsonBodyError,
  parseOptionalJsonObjectBody,
} from './json-body-errors'

function createApp(onOptionalBody = (_body: unknown) => {}) {
  const app = new Hono()
  app.use('*', jsonBodyErrorMiddleware)
  app.onError(jsonBodyErrorHandler)
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/direct', async (c) => c.json({ value: await c.req.json() }))
  app.patch('/validated', zValidator('json', z.object({ name: z.string() })), (c) => c.json(c.req.valid('json')))
  app.post('/syntax-error', () => {
    throw new SyntaxError('application bug')
  })
  app.post('/consumed', async (c) => {
    await c.req.raw.text()
    return c.json(await c.req.json())
  })
  app.post('/http-exception', () => {
    throw new HTTPException(418, { message: 'teapot' })
  })
  app.post('/near-message', () => {
    throw new HTTPException(400, { message: 'another message' })
  })
  app.post('/near-status', () => {
    throw new HTTPException(409, { message: 'Malformed JSON in request body' })
  })
  app.post('/text', async (c) => c.text(await c.req.text()))
  app.post('/form', async (c) => c.json(Object.fromEntries((await c.req.formData()).entries())))
  app.post('/raw', async (c) => c.body(await c.req.raw.arrayBuffer()))
  app.post('/optional', async (c) => {
    const body = await parseOptionalJsonObjectBody(c, { fallback: true })
    onOptionalBody(body)
    return c.json(body)
  })
  app.post('/optional-reader-error', async (c) => {
    c.req.text = async () => {
      throw new Error('credential-reader-marker-must-not-leak')
    }
    return c.json(await parseOptionalJsonObjectBody(c, { fallback: true }))
  })
  app.post('/consumed-optional', async (c) => {
    await c.req.raw.text()
    return c.json(await parseOptionalJsonObjectBody(c, { fallback: true }))
  })
  return app
}

async function expectInvalidJson(response: Response) {
  expect(response.status).toBe(400)
  expect(response.headers.get('content-type')).toStartWith('application/json')
  expect(await response.json()).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
}

const nonObjectRoots = [
  ['null', 'null'],
  ['array', '["root-secret-marker"]'],
  ['string', '"root-secret-marker"'],
  ['number', '42'],
  ['boolean', 'true'],
] as const

describe('JSON body error boundary', () => {
  test.each(nonObjectRoots)('optional object bodies reject a %s root before continuation', async (_kind, body) => {
    let continuations = 0
    const response = await createApp(() => continuations++).request('/optional', { method: 'POST', body })
    const responseText = await response.text()

    expect({ continuations }).toEqual({ continuations: 0 })
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toStartWith('application/json')
    expect(JSON.parse(responseText)).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
    expect(responseText).not.toContain('root-secret-marker')
  })

  test.each([
    ['no content type', undefined],
    ['JSON', 'application/json'],
    ['text', 'text/plain'],
  ] as const)('optional object roots do not depend on %s gating', async (_label, contentType) => {
    const app = createApp()
    const request = (body: string) => {
      const raw = new Request('http://localhost/optional', {
        method: 'POST',
        headers: contentType ? { 'content-type': contentType } : undefined,
        body: contentType ? body : new TextEncoder().encode(body),
      })
      if (!contentType) expect(raw.headers.get('content-type')).toBeNull()
      return app.request(raw)
    }
    expect((await request('{}')).status).toBe(200)
    await expectInvalidJson(await request('[]'))
  })

  test('accepts prototype-named keys as inert JSON object data', async () => {
    const response = await createApp().request('/optional', {
      method: 'POST',
      body: '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"polluted":"no"}}}',
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.hasOwn(body, '__proto__')).toBe(true)
    expect(body['__proto__']).toEqual({ polluted: 'no' })
    expect(Object.hasOwn(body, 'constructor')).toBe(true)
    expect(body.constructor).toEqual({ prototype: { polluted: 'no' } })
    expect(({} as { polluted?: string }).polluted).toBeUndefined()
  })
  test.each([
    ['POST', '{'],
    ['PUT', '{"value":'],
    ['PATCH', ''],
    ['DELETE', undefined],
  ] as const)('normalizes malformed %s bodies', async (method, body) => {
    const response = await createApp().request('/direct', {
      method,
      headers: { 'content-type': 'application/json' },
      body,
    })
    await expectInvalidJson(response)
  })

  test('normalizes Hono validator parser errors but preserves content-type gating', async () => {
    const app = createApp()
    await expectInvalidJson(
      await app.request('/validated', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    )
    for (const headers of [undefined, { 'content-type': 'text/plain' }]) {
      const response = await app.request('/validated', { method: 'PATCH', headers, body: '{"name":"ok"}' })
      expect(response.status).toBe(400)
      expect(await response.json()).not.toEqual({ error: INVALID_JSON_BODY_MESSAGE })
    }
  })

  test('does not rewrite unrelated errors', async () => {
    const app = createApp()
    for (const path of ['/syntax-error', '/consumed']) {
      const response = await app.request(path, { method: 'POST', body: '{}' })
      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Internal Server Error')
    }
    const teapot = await app.request('/http-exception', { method: 'POST' })
    expect(teapot.status).toBe(418)
    expect(await teapot.text()).toBe('teapot')
    const nearMessage = await app.request('/near-message', { method: 'POST' })
    expect(nearMessage.status).toBe(400)
    expect(await nearMessage.text()).toBe('another message')
    const nearStatus = await app.request('/near-status', { method: 'POST' })
    expect(nearStatus.status).toBe(409)
    expect(await nearStatus.text()).toBe('Malformed JSON in request body')
  })

  test('preserves valid roots, content-type permissiveness, and text bodies', async () => {
    const app = createApp()
    for (const body of ['{"ok":true}', '42', 'null']) {
      const response = await app.request('/direct', { method: 'POST', body })
      expect(response.status).toBe(200)
      expect((await response.json()).value).toEqual(JSON.parse(body))
    }
    await expectInvalidJson(await app.request('/direct', { method: 'POST', body: '{' }))
    const text = await app.request('/text', { method: 'POST', body: '{' })
    expect(await text.text()).toBe('{')
    const form = new FormData()
    form.set('value', '{')
    expect(await (await app.request('/form', { method: 'POST', body: form })).json()).toEqual({ value: '{' })
    const raw = new Uint8Array([0, 255, 123, 1])
    expect(new Uint8Array(await (await app.request('/raw', { method: 'POST', body: raw })).arrayBuffer())).toEqual(raw)
  })

  test('keeps parsing lazy behind authentication and authorization', async () => {
    const unauthorized = new Hono()
    unauthorized.use('*', jsonBodyErrorMiddleware)
    unauthorized.onError(jsonBodyErrorHandler)
    unauthorized.use('*', async (c) => c.json({ error: 'Unauthorized' }, 401))
    unauthorized.post('/route', async (c) => c.json(await c.req.json()))
    expect((await unauthorized.request('/route', { method: 'POST', body: '{' })).status).toBe(401)

    const forbidden = new Hono()
    forbidden.use('*', jsonBodyErrorMiddleware)
    forbidden.onError(jsonBodyErrorHandler)
    forbidden.post(
      '/route',
      async (c) => c.json({ error: 'Forbidden' }, 403),
      async (c) => c.json(await c.req.json())
    )
    expect((await forbidden.request('/route', { method: 'POST', body: '{' })).status).toBe(403)
  })

  test('is request-scoped, nested-router compatible, concurrent, and idempotent', async () => {
    const child = new Hono().post('/value', async (c) => c.json(await c.req.json()))
    const app = new Hono()
    app.use('*', jsonBodyErrorMiddleware, jsonBodyErrorMiddleware)
    app.onError(jsonBodyErrorHandler)
    app.route('/child', child)
    const [valid, malformed] = await Promise.all([
      app.request('/child/value', { method: 'POST', body: '{"id":1}' }),
      app.request('/child/value', { method: 'POST', body: '{' }),
    ])
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ id: 1 })
    await expectInvalidJson(malformed)
  })

  test('optional bodies distinguish zero bytes from malformed input', async () => {
    const app = createApp()
    expect(await (await app.request('/optional', { method: 'POST' })).json()).toEqual({ fallback: true })
    expect(await (await app.request('/optional', { method: 'POST', body: '{"id":1}' })).json()).toEqual({ id: 1 })
    for (const body of [' ', '{']) {
      await expectInvalidJson(await app.request('/optional', { method: 'POST', body }))
    }
    const consumed = await app.request('/consumed-optional', { method: 'POST', body: '{}' })
    expect(consumed.status).toBe(500)
    expect(await consumed.text()).toBe('Internal Server Error')
  })

  test('does not swallow or expose optional-body reader failures', async () => {
    const response = await createApp().request('/optional-reader-error', { method: 'POST', body: '{}' })
    const responseText = await response.text()

    expect(response.status).toBe(500)
    expect(responseText).toBe('Internal Server Error')
    expect(responseText).not.toContain('credential-reader-marker-must-not-leak')
  })

  test('leaves oversized bodies to Bun before Hono runs', async () => {
    let handled = 0
    const app = new Hono()
    app.use('*', jsonBodyErrorMiddleware)
    app.onError(jsonBodyErrorHandler)
    app.post('/optional', async (c) => {
      const body = await parseOptionalJsonObjectBody(c, {})
      handled++
      return c.json(body)
    })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, fetch: app.fetch })
    try {
      const response = await fetch(new URL('/optional', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(2048) }),
      })
      expect(response.status).toBe(413)
      expect(handled).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test('exports a dedicated parser marker', () => {
    const cause = new SyntaxError('bad input')
    const error = new MalformedJsonBodyError(cause)
    expect(error.cause).toBe(cause)
    expect(error.message).toBe(INVALID_JSON_BODY_MESSAGE)
  })
  test('a workspace settings dir that needs a manual fix answers 409 with the actionable message and no path', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-dot-dir-409-')))
    const root = join(home, 'workspaces', 'squads', 'squad-1')
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, WORKSPACE_DOT_DIR), 'not a directory')
      const app = new Hono()
      app.onError(jsonBodyErrorHandler)
      app.get('/env', (c) => {
        prepareWorkspaceDotDir(root)
        return c.json({ ok: true })
      })

      const response = await app.request('/env')

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: string; code: string }
      expect(body.code).toBe('workspace_dot_dir_conflict')
      expect(body.error).toStartWith('Workspace squad-1 needs a manual fix to its settings dir:')
      expect(body.error).not.toContain(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requestBodyPolicy, requestBodyLimits, createRequestBodyLimits } from './request-body-limits'
import { jsonBodyErrorMiddleware, jsonBodyErrorHandler } from './json-body-errors'
import { attachPeerAddress, getClientAddress, isTrustedProxyPeer } from '../lib/client-address'

for (const [path, max] of [
  ['/api/new-router', 1],
  ['/api/chat', 4],
  ['/api/workstreams', 4],
  ['/api/squads/x/integrations/github/sign', 4],
  ['/api/assistant/x/entries', 48],
  ['/api/webhooks/github', 26],
  ['/api/memory/x/sync/webhook', 26],
  ['/api/images', 16],
  ['/api/screenshots/file', 16],
  ['/api/squads/x/avatar', 16],
  ['/api/decisions/try', 12],
  ['/api/memory/x/write', 128],
  ['/api/memory/x/workspace-files', 128],
  ['/api/skills/import', 128],
  ['/api/amtp/inbox', 4],
] as const)
  test(path + ' byte budget', () =>
    expect(requestBodyPolicy('POST', path)).toEqual({ kind: 'bounded', maxBytes: max * 1024 ** 2 })
  )
for (const path of ['/api/squads/x/workspace/upload', '/api/app/x/proxy'])
  test(path + ' streams without reading', () => {
    expect(requestBodyPolicy('POST', path).kind).toBe('stream')
    expect(requestBodyPolicy('GET', path).kind).toBe('stream')
  })
for (const path of ['/api/squads/x/workspace/upload-extra', '/api/agents/x/files-extra', '/api/app-extra/x'])
  test(path + ' cannot spoof exemption', () => expect(requestBodyPolicy('POST', path).kind).toBe('bounded'))
for (const path of [
  '/api/agents/x/files',
  '/api/agents/x/private/upload',
  '/api/inbox/x/attachments',
  '/api/workflows/runs/x/attempts/2/attachments',
  '/api/transcribe',
])
  test(path + ' keeps domain-owned budget', () => expect(requestBodyPolicy('POST', path).kind).toBe('route-owned'))

test('counts actual bytes, returns clear 413, and does not reach handlers', async () => {
  const app = new Hono()
  let calls = 0
  app.use(
    '*',
    createRequestBodyLimits(() => ({ kind: 'bounded', maxBytes: 8 }))
  )
  app.post('*', (c) => {
    calls++
    return c.text('ok')
  })
  const response = await app.request('/api/new', {
    method: 'POST',
    body: '123456789',
    headers: { 'content-length': '1' },
  })
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    error: 'Request body too large',
    code: 'REQUEST_BODY_TOO_LARGE',
    maxBytes: 8,
  })
  expect(calls).toBe(0)
})
test('body replacement preserves signature bytes, malformed JSON contract, and socket peer', async () => {
  const app = new Hono()
  app.use('*', jsonBodyErrorMiddleware)
  app.onError(jsonBodyErrorHandler)
  app.use('*', requestBodyLimits)
  app.post('/api/raw', async (c) =>
    c.json({ raw: await c.req.text(), peer: getClientAddress(c.req.raw), trusted: isTrustedProxyPeer(c.req.raw) })
  )
  app.post('/api/json', async (c) => c.json(await c.req.json()))
  const bytes = ' { "text": "😀" }\n'
  const req = new Request('http://localhost/api/raw', {
    method: 'POST',
    body: bytes,
    headers: { 'x-forwarded-for': '198.51.100.8' },
  })
  attachPeerAddress(req, '127.0.0.1')
  expect(await (await app.request(req)).json()).toEqual({ raw: bytes, peer: '198.51.100.8', trusted: true })
  const bad = await app.request('/api/json', {
    method: 'POST',
    body: '{',
    headers: { 'content-type': 'application/json' },
  })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'Invalid JSON body' })
})

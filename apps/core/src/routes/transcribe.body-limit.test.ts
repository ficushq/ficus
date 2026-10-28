import { expect, test, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { requestBodyLimits } from '../middleware/request-body-limits'
import { createTestAdmin, cleanupTestRbac, authHeaders } from '../test-utils'
import { getSettingsStore } from '../services/settings'
mock.module('../services/integrations/openai-services/settings', () => ({ getOpenAIServiceKey: () => null }))
const { createTranscribeRouter } = await import('./transcribe')
const prefix = 'transcribe-body-' + crypto.randomUUID()
let token: string
beforeAll(async () => {
  token = (await createTestAdmin({ prefix })).token
  await getSettingsStore().set('TRANSCRIPTION_ENABLED', 'true')
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})
const app = new Hono()
app.use('*', identityMiddleware)
app.use('*', requestBodyLimits)
app.route(
  '/api/transcribe',
  createTranscribeRouter(async () => {
    throw new Error('provider must not be called')
  })
)
test('transport overflow returns 413 before multipart parser', async () => {
  const res = await app.request('/api/transcribe', {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'multipart/form-data; boundary=test' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(10 * 1024 ** 2 + 65537))
        c.close()
      },
    }),
  })
  expect(res.status).toBe(413)
})
test('exact 10MiB audio is accepted by byte budget; per-file overflow stays 413', async () => {
  for (const extra of [0, 1]) {
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(10 * 1024 ** 2 + extra)], 'audio.wav'))
    const res = await app.request('/api/transcribe', { method: 'POST', headers: authHeaders(token), body: form })
    expect(res.status).toBe(extra ? 413 : 503) // no configured API key; normal domain handling is reached
  }
})

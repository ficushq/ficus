import { expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, squads } from '../db'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin } from '../test-utils'
import * as derivation from '../services/public-voice/derive'
import { DerivationError } from '../services/public-voice/github-activity'
import { __derivationsInProgress, squadVoiceRouter } from './squad-voice'

/** Real transport proof: body cancellation must reach Hono, not just a mocked signal. */
test('socket disconnect cancels collection, releases ownership and permits a repeated request', async () => {
  const prefix = `voice-stream-${crypto.randomUUID()}`
  const admin = await createTestAdmin({ prefix })
  const squad = await Squad.create({ name: prefix, purpose: 'Synthetic voice stream fixture' })
  const app = new Hono().use('*', identityMiddleware).route('/api/squads', squadVoiceRouter)
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  let observedAbort!: () => void
  const aborted = new Promise<void>(resolve => { observedAbort = resolve })
  const derive = spyOn(derivation, 'derivePublicVoice').mockImplementationOnce(async input => {
    input.signal!.addEventListener('abort', () => observedAbort(), { once: true })
    await input.onProgress?.({ type: 'phase', phase: 'collecting' })
    return new Promise(() => {})
  }).mockRejectedValueOnce(new DerivationError('derivation_invalid_output', { reason: 'not_json', raw: 'synthetic private sentinel' }))
  const request = () => fetch(`http://localhost:${server.port}/api/squads/${squad.id}/voice/derive`, {
    method: 'POST', headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ login: 'octo' }),
  })
  try {
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
    // Wait for real work admission before closing the underlying HTTP response.
    await reader.read()
    await reader.cancel()
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnect was not propagated')), 1000))])
    expect(__derivationsInProgress.has(squad.id)).toBe(false)
    const repeated = await request()
    const text = await repeated.text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain('"reason":"not_json"')
    expect(text).not.toContain('synthetic private sentinel')
    expect(__derivationsInProgress.has(squad.id)).toBe(false)
  } finally {
    server.stop(true)
    derive.mockRestore()
    await db.delete(squads).where(eq(squads.id, squad.id))
    await cleanupTestRbac(prefix)
  }
}, 15_000)

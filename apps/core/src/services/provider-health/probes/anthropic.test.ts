import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { anthropicProbe } from './anthropic'

// These tests overwrite globalThis.fetch; restore it so the mock never leaks
// into later files in bun's single-process run (`mock.restore()` reverts spies
// but not a plain `globalThis.fetch = ...` assignment).
const originalFetch = globalThis.fetch

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as any
}

describe('anthropicProbe', () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports healthy when /v1/models is reachable with valid auth', async () => {
    const f = mock(() => Promise.resolve(res({ data: [] })))
    globalThis.fetch = f as any

    const r = await anthropicProbe.probe({ apiKey: 'k', baseUrl: 'https://api.anthropic.com' })

    expect(r).toEqual({
      state: 'healthy',
      status: 200,
      recoveryKinds: ['invalid-credential', 'expired-oauth'],
    })
    expect(f).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      })
    )
  })

  it('reports invalid credentials on 401', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({}, 401))) as any

    const r = await anthropicProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('invalid-credential')
    expect(r.status).toBe(401)
  })

  it('reports rate-limit on 429', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({}, 429))) as any

    const r = await anthropicProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('rate-limit')
    expect(r.status).toBe(429)
  })

  it('treats 5xx as inconclusive', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({}, 503))) as any

    const r = await anthropicProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('inconclusive')
    expect(r.status).toBe(503)
  })

  it('reports error for other non-ok statuses', async () => {
    globalThis.fetch = mock(() => Promise.resolve(res({}, 400))) as any

    const r = await anthropicProbe.probe({ apiKey: 'k' })

    expect(r.state).toBe('unhealthy')
    expect((r as any).kind).toBe('error')
    expect(r.status).toBe(400)
  })

  it('returns inconclusive when no apiKey is configured', async () => {
    const f = mock(() => Promise.resolve(res({})))
    globalThis.fetch = f as any

    const r = await anthropicProbe.probe({ apiKey: undefined })

    expect(r.state).toBe('inconclusive')
    expect(f).not.toHaveBeenCalled()
  })
})

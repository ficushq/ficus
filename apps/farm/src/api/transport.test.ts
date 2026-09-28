import { describe, expect, it } from 'bun:test'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { isHttpResponseError } from '@ficus/client-core'
import { createFarmTransport } from './transport'

function recordingFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return response
  }
  return { calls, impl }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('farm transport', () => {
  it('sends the session cookie and no CSRF header on reads', async () => {
    const { calls, impl } = recordingFetch(json([{ id: 's1' }]))
    const result = await createFarmTransport(impl).request<Array<{ id: string }>>('/squads')
    expect(result).toEqual([{ id: 's1' }])
    expect(calls[0].url).toBe('http://localhost/api/squads')
    expect(calls[0].init.credentials).toBe('include')
    expect((calls[0].init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined()
  })

  it('adds the CSRF header and a JSON body on mutations', async () => {
    const { calls, impl } = recordingFetch(json({ ok: true }))
    await createFarmTransport(impl).request('/actions/x', { method: 'POST', body: { a: 1 } })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers[CSRF_HEADER]).toBe('1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(calls[0].init.body).toBe('{"a":1}')
  })

  it('throws an HttpResponseError carrying the status', async () => {
    const { impl } = recordingFetch(json({ error: 'nope' }, 401))
    const error = await createFarmTransport(impl)
      .request('/auth/me')
      .catch((e: unknown) => e)
    expect(isHttpResponseError(error, 401)).toBe(true)
  })
})

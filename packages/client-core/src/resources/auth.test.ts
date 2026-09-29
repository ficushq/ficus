import { describe, expect, test } from 'bun:test'
import { authResource } from './auth'
import type { Transport, RequestOptions } from '../transport'

function mockTransport(responder?: (path: string, options?: RequestOptions) => unknown) {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return (responder?.(path, options) ?? undefined) as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path: string) => `ws://test${path}`,
    url: (path: string) => `http://test/api${path}`,
  }
  return { t, calls }
}

describe('authResource', () => {
  test('getMyPermissions omits squadId when not provided', async () => {
    const { t, calls } = mockTransport(() => ({ permissions: [] }))
    await authResource(t).getMyPermissions()
    expect(calls[0].path).toBe('/auth/permissions')
  })

  test('getMyPermissions adds an encoded squadId query parameter when provided', async () => {
    const { t, calls } = mockTransport(() => ({ permissions: [] }))
    await authResource(t).getMyPermissions('squad id/with spaces')
    expect(calls[0].path).toBe('/auth/permissions?squadId=squad+id%2Fwith+spaces')
  })

  test('device authorization inspect and approve post capability bodies', async () => {
    const { t, calls } = mockTransport()
    await authResource(t).deviceAuthorizationInspect({ verificationCode: 'verify' })
    await authResource(t).deviceAuthorizationApprove({ verificationCode: 'verify' })
    expect(calls).toEqual([
      { path: '/auth/device/inspect', options: { method: 'POST', body: { verificationCode: 'verify' } } },
      { path: '/auth/device/approve', options: { method: 'POST', body: { verificationCode: 'verify' } } },
    ])
  })

  test('createWebHandoff posts to the web handoff route with no body', async () => {
    const { t, calls } = mockTransport(() => ({ code: 'ficus_wh_x', expiresAt: '2026-09-30T00:01:00.000Z' }))
    expect(await authResource(t).createWebHandoff()).toEqual({
      code: 'ficus_wh_x',
      expiresAt: '2026-09-30T00:01:00.000Z',
    })
    expect(calls).toEqual([{ path: '/auth/web-handoff', options: { method: 'POST' } }])
  })

  test('pairClaim posts the code/name/platform body', async () => {
    const { t, calls } = mockTransport(() => ({ token: 'ficus_dev_x', user: { id: 'u1', email: 'a@b.c' } }))
    await authResource(t).pairClaim({ code: 'ABC123', name: 'iPhone', platform: 'ios' })
    expect(calls[0].path).toBe('/auth/pair/claim')
    expect(calls[0].options?.method).toBe('POST')
    expect(calls[0].options?.body).toEqual({ code: 'ABC123', name: 'iPhone', platform: 'ios' })
  })
})

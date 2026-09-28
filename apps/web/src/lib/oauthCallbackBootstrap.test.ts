import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { acquireDomHarness } from '../test/domHarness'
import { prepareOAuthCallbackHistory, readPreparedOAuthCallback } from './oauthCallbackBootstrap'

const FLOW = '11111111-1111-4111-8111-111111111111'
const HANDLE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>

beforeEach(async () => {
  harness = await acquireDomHarness({
    url: `http://localhost/settings/integrations/oauth/callback?flow=${FLOW}&handle=${HANDLE}&status=ok`,
  })
})

afterEach(async () => {
  await harness.cleanup()
})

test('bootstrap strips hosted query material before service-worker or auth network work and retains the exact body', () => {
  const order: string[] = []
  const replaceState = window.history.replaceState.bind(window.history)
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    order.push('replaceState')
    replaceState(data, unused, url)
  }) as typeof window.history.replaceState

  prepareOAuthCallbackHistory()
  order.push('service-worker')
  order.push('auth-fetch')

  expect(order).toEqual(['replaceState', 'service-worker', 'auth-fetch'])
  expect(window.location.search).toBe('')
  expect(readPreparedOAuthCallback()).toEqual({
    kind: 'broker',
    body: { localFlowId: FLOW, handle: HANDLE },
  })
})

test('bootstrap strips self-hosted code and provider error material synchronously', () => {
  window.history.replaceState(
    null,
    '',
    `/settings/integrations/oauth/callback?state=${HANDLE}&code=local-code&error_description=RAW_DESCRIPTION`
  )

  prepareOAuthCallbackHistory()

  expect(window.location.search).toBe('')
  expect(window.location.href).not.toContain('local-code')
  expect(window.location.href).not.toContain('RAW_DESCRIPTION')
  expect(readPreparedOAuthCallback()).toEqual({ kind: 'local', body: { state: HANDLE, code: 'local-code' } })
})

test('production bootstrap captures OAuth material before service-worker registration and app rendering', () => {
  const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
  const prepare = source.indexOf('\nprepareOAuthCallbackHistory()')
  const serviceWorker = source.indexOf("\nif ('serviceWorker' in navigator)")
  const render = source.indexOf('\ncreateRoot(')

  expect(prepare).toBeGreaterThan(-1)
  expect(prepare).toBeLessThan(serviceWorker)
  expect(prepare).toBeLessThan(render)
  expect(source).toContain("import { DevBackendBar } from './components/DevBackendBar'")
  expect(source).toContain('<DevBackendBar />')
  expect(source).toContain('className="flex h-full min-h-0 flex-col"')
})

test('GitHub callbacks also remove token exchange material before bootstrap', () => {
  window.history.replaceState(null, '', `/settings/integrations/oauth/callback/github?state=${HANDLE}&code=github-code`)
  prepareOAuthCallbackHistory()
  expect(window.location.search).toBe('')
  expect(readPreparedOAuthCallback()).toEqual({ kind: 'local', body: { state: HANDLE, code: 'github-code' } })
})

test('a broker callback carries the sessionStorage provider hint into the persisted (reload-surviving) history state', () => {
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'slack')

  prepareOAuthCallbackHistory()

  expect(readPreparedOAuthCallback()).toEqual({
    kind: 'broker',
    body: { localFlowId: FLOW, handle: HANDLE },
    provider: 'slack',
  })
  // Consumed once, same as before: an abandoned later flow cannot inherit it.
  expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()
})

test('a broker callback with no provider hint carries none (defaults are unaffected)', () => {
  prepareOAuthCallbackHistory()

  expect(readPreparedOAuthCallback()).toEqual({
    kind: 'broker',
    body: { localFlowId: FLOW, handle: HANDLE },
  })
})

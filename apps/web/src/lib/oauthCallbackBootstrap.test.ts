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
  // Top-level, before boot() (which the farm resume check may skip) registers the worker and renders.
  const prepare = source.indexOf('\nprepareOAuthCallbackHistory()')
  const serviceWorker = source.search(/\n\s*if \('serviceWorker' in navigator\)/)
  const render = source.search(/\n\s*createRoot\(/)

  expect(prepare).toBeGreaterThan(-1)
  expect(serviceWorker).toBeGreaterThan(-1)
  expect(render).toBeGreaterThan(-1)
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

test('a broker completion never carries the per-tab hint, and the hint is cleared so it cannot go stale', () => {
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'slack')

  prepareOAuthCallbackHistory()

  // Core resolves the provider from the flow; a hint left by another flow must not steer completion.
  expect(readPreparedOAuthCallback()).toEqual({ kind: 'broker', body: { localFlowId: FLOW, handle: HANDLE } })
  expect(window.history.state).toEqual({ ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE } })
  expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()
})

test('a broker completion with no hint (a flow started in the Desktop app) is prepared the same way', () => {
  prepareOAuthCallbackHistory()

  expect(readPreparedOAuthCallback()).toEqual({ kind: 'broker', body: { localFlowId: FLOW, handle: HANDLE } })
})

test('a completion saved with a hint by an earlier release still reloads, and the hint is ignored', () => {
  window.history.replaceState(
    { ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE }, ficusOAuthCallbackProvider: 'notion' },
    '',
    '/settings/integrations/oauth/callback'
  )

  expect(readPreparedOAuthCallback()).toEqual({ kind: 'broker', body: { localFlowId: FLOW, handle: HANDLE } })
})

for (const provider of ['linear', 'notion', 'slack'] as const) {
  test(`a cancelled ${provider} broker callback keeps the hint to name the provider`, () => {
    window.sessionStorage.setItem('ficusOAuthProviderHint', provider)
    window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=denied')

    prepareOAuthCallbackHistory()

    expect(window.location.search).toBe('')
    expect(readPreparedOAuthCallback()).toEqual({ kind: 'cancelled', provider })
    expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()
  })

  test(`a failed ${provider} broker callback keeps the hint and the broker's safe failure code`, () => {
    window.sessionStorage.setItem('ficusOAuthProviderHint', provider)
    window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=error&code=invalid_grant')

    prepareOAuthCallbackHistory()

    expect(window.location.search).toBe('')
    expect(readPreparedOAuthCallback()).toEqual({ kind: 'terminal', provider, reason: 'invalid_grant' })
  })
}

test('a failure code that is not a short safe code is dropped', () => {
  window.history.replaceState(
    null,
    '',
    '/settings/integrations/oauth/callback?status=error&code=%3Cscript%3Ealert(1)%3C%2Fscript%3E'
  )

  prepareOAuthCallbackHistory()

  expect(readPreparedOAuthCallback()).toEqual({ kind: 'terminal' })
})

test('settled outcomes without a hint name no provider rather than a default', () => {
  window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=denied')
  prepareOAuthCallbackHistory()
  expect(readPreparedOAuthCallback()).toEqual({ kind: 'cancelled' })
})

test('a failure reason is only accepted beside a terminal outcome', () => {
  window.history.replaceState(
    { ficusOAuthCallbackOutcome: 'cancelled', ficusOAuthCallbackReason: 'invalid_grant' },
    '',
    '/settings/integrations/oauth/callback'
  )
  expect(readPreparedOAuthCallback()).toBeUndefined()
  window.history.replaceState(
    { ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE }, ficusOAuthCallbackReason: 'invalid_grant' },
    '',
    '/settings/integrations/oauth/callback'
  )
  expect(readPreparedOAuthCallback()).toBeUndefined()
})

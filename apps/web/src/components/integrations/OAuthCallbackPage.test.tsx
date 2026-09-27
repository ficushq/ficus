import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { BrowserRouter } from 'react-router-dom'
import { prepareOAuthCallbackHistory } from '../../lib/oauthCallbackBootstrap'
import { acquireDomHarness } from '../../test/domHarness'

const FLOW = '11111111-1111-4111-8111-111111111111'
const HANDLE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const CALLBACK = `/settings/integrations/oauth/callback?flow=${FLOW}&handle=${HANDLE}&status=ok`

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch

beforeEach(async () => {
  harness = await acquireDomHarness({ url: `http://localhost${CALLBACK}` })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  prepareOAuthCallbackHistory()
  return harness.act(async () => {
    const { OAuthCallbackPage } = await import('./OAuthCallbackPage')
    root.render(
      <QueryClientProvider client={client}>
        <OAuthCallbackPage />
      </QueryClientProvider>
    )
  })
}

async function renderPageInBrowserRouter() {
  prepareOAuthCallbackHistory()
  await harness.act(async () => {
    const { OAuthCallbackPage } = await import('./OAuthCallbackPage')
    root.render(
      <BrowserRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <OAuthCallbackPage />
        </QueryClientProvider>
      </BrowserRouter>
    )
  })
}

async function flushEffects() {
  await harness.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

for (const provider of ['github', 'notion'] as const) {
  test(`${provider} callback upgrades a legacy settings return to the expanded provider card`, async () => {
    if (provider === 'github')
      window.history.replaceState(null, '', CALLBACK.replace('/callback?', '/callback/github?'))
    globalThis.fetch = (async () => Response.json({ returnTo: '/settings' })) as typeof fetch
    const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
    try {
      await renderPage()
      await flushEffects()
      expect(redirect).toHaveBeenCalledWith(`/settings?section=integrations&setting=integration-${provider}`)
    } finally {
      redirect.mockRestore()
    }
  })
}

test('slack callback (hinted via sessionStorage at authorization start) completes against the slack provider', async () => {
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'slack')
  let path = ''
  globalThis.fetch = (async (input) => {
    path = String(input)
    return Response.json({ returnTo: '/settings' })
  }) as typeof fetch
  const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
  try {
    await renderPage()
    await flushEffects()
    expect(path).toContain('/integrations/providers/slack/authorization/complete')
    expect(redirect).toHaveBeenCalledWith('/settings?section=integrations&setting=integration-slack')
    expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()
  } finally {
    redirect.mockRestore()
  }
})

test('a github-suffixed path wins over a stale provider hint left by an abandoned flow', async () => {
  window.history.replaceState(null, '', CALLBACK.replace('/callback?', '/callback/github?'))
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'slack')
  let path = ''
  globalThis.fetch = (async (input) => {
    path = String(input)
    return Response.json({ returnTo: '/settings' })
  }) as typeof fetch
  const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
  try {
    await renderPage()
    await flushEffects()
    expect(path).toContain('/integrations/providers/github/authorization/complete')
    expect(redirect).toHaveBeenCalledWith('/settings?section=integrations&setting=integration-github')
  } finally {
    redirect.mockRestore()
  }
})

test('strips the completion handle from the URL before any network call', async () => {
  const order: string[] = []
  const replaceState = window.history.replaceState.bind(window.history)
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    order.push('replaceState')
    replaceState(data, unused, url)
  }) as typeof window.history.replaceState
  globalThis.fetch = (async () => {
    order.push('complete')
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()

  expect(order).toEqual(['replaceState', 'complete'])
  expect(window.location.search).toBe('')
  expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
    'Finishing the secure connection'
  )
  expect(container.textContent).not.toContain(FLOW)
  expect(container.textContent).not.toContain(HANDLE)
  expect(storageValues(window.localStorage)).not.toContain(HANDLE)
  expect(storageValues(window.sessionStorage)).not.toContain(HANDLE)
})

test('reload recovers the same completion payload after a retryable failure', async () => {
  const bodies: string[] = []
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body))
    if (bodies.length === 1) {
      return Response.json({ error: 'broker_unavailable' }, { status: 503 })
    }
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()
  await flushEffects()
  expect(container.textContent).toContain('try again')
  expect(window.location.search).toBe('')

  await harness.act(async () => root.unmount())
  ;({ root, container } = harness.createRoot())
  await renderPage()

  expect(bodies).toEqual([
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
  ])
})

test('a reload after a retryable failure keeps completing against the hinted provider (slack), not the notion default', async () => {
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'slack')
  const paths: string[] = []
  globalThis.fetch = (async (input) => {
    paths.push(String(input))
    if (paths.length === 1) return Response.json({ error: 'broker_unavailable' }, { status: 503 })
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()
  await flushEffects()
  expect(container.textContent).toContain('try again')
  // The one-shot sessionStorage hint is gone after the first render...
  expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()

  // ...but a reload (fresh mount, same persisted history state) must still
  // know this is the slack flow, not silently fall back to notion.
  await harness.act(async () => root.unmount())
  ;({ root, container } = harness.createRoot())
  await renderPage()
  await flushEffects()

  expect(paths.every((path) => path.includes('/integrations/providers/slack/authorization/complete'))).toBe(true)
  expect(container.textContent).toContain('Connecting Slack')
})

test('BrowserRouter reload metadata preserves and resends the exact hosted completion payload', async () => {
  window.history.replaceState(
    { tauOAuthCompletion: { localFlowId: FLOW, handle: HANDLE } },
    '',
    '/settings/integrations/oauth/callback'
  )
  let body = ''
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body)
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPageInBrowserRouter()

  expect(window.history.state.idx).toBeNumber()
  expect(body).toBe(JSON.stringify({ localFlowId: FLOW, handle: HANDLE }))
})

test('retry resends the exact retained flow and handle body', async () => {
  const bodies: string[] = []
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body))
    if (bodies.length === 1) return Response.json({ error: 'broker_timeout' }, { status: 503 })
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()
  await flushEffects()
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  expect(retry.className).toContain('focus-visible:ring-2')
  await harness.act(async () => fireEvent.click(retry))

  expect(bodies).toEqual([
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
  ])
  expect(window.location.search).toBe('')
})

test('durable Core success clears the transient history payload', async () => {
  globalThis.fetch = (async () => Response.json({ returnTo: '/settings' })) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.invalidateQueries = (() => new Promise(() => {})) as typeof client.invalidateQueries

  await renderPage(client)
  await flushEffects()

  expect(window.history.state).toBeNull()
})

for (const terminalCode of ['completion_not_found', 'flow_expired']) {
  test(`explicitly terminal ${terminalCode} clears the transient history payload`, async () => {
    globalThis.fetch = (async () => Response.json({ error: terminalCode }, { status: 400 })) as typeof fetch

    await renderPage()
    await flushEffects()

    expect(window.history.state).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(HANDLE)
  })
}

test('self-hosted success strips query material before posting the local callback body', async () => {
  window.history.replaceState(null, '', `/settings/integrations/oauth/callback?state=${HANDLE}&code=local-code`)
  const order: string[] = []
  let request: { url: string; body: string } | undefined
  const replaceState = window.history.replaceState.bind(window.history)
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    order.push('replaceState')
    replaceState(data, unused, url)
  }) as typeof window.history.replaceState
  globalThis.fetch = (async (input, init) => {
    order.push('callback')
    request = { url: String(input), body: String(init?.body) }
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()

  expect(order).toEqual(['replaceState', 'replaceState', 'callback'])
  expect(request).toEqual({
    url: 'http://localhost/api/integrations/providers/notion/authorization/callback',
    body: JSON.stringify({ state: HANDLE, code: 'local-code' }),
  })
  expect(window.location.search).toBe('')
})

test('self-hosted denial is normalized without forwarding provider-controlled text', async () => {
  window.history.replaceState(
    null,
    '',
    `/settings/integrations/oauth/callback?state=${HANDLE}&error=RAW_ERROR&error_description=RAW_DESCRIPTION`
  )
  let body = ''
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body)
    return Response.json({ error: 'provider_denied' }, { status: 400 })
  }) as typeof fetch

  await renderPage()
  await flushEffects()

  expect(JSON.parse(body)).toEqual({ state: HANDLE, denied: true })
  expect(body).not.toContain('RAW_ERROR')
  expect(body).not.toContain('RAW_DESCRIPTION')
  expect(container.textContent).not.toContain('RAW_ERROR')
  expect(container.textContent).not.toContain('RAW_DESCRIPTION')
  expect(container.textContent).not.toContain('Try again')
  expect(window.history.state).toBeNull()
})

test('status=denied shows a cancelled message and never calls complete', async () => {
  window.history.replaceState(null, '', `/settings/integrations/oauth/callback?flow=${FLOW}&status=denied`)
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response()
  }) as typeof fetch

  await renderPage()

  expect(calls).toBe(0)
  expect(window.location.search).toBe('')
  expect(window.history.state).toBeNull()
  expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
    'Authorization cancelled'
  )
})

test('a fresh malformed callback cannot fall back to a stale history payload', async () => {
  window.history.replaceState(
    { tauOAuthCompletion: { localFlowId: FLOW, handle: HANDLE } },
    '',
    `/settings/integrations/oauth/callback?flow=${FLOW}&handle=bad`
  )
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response()
  }) as typeof fetch

  await renderPage()

  expect(calls).toBe(0)
  expect(window.location.search).toBe('')
  expect(window.history.state).toBeNull()
})

test('reload rejects history state with anything beyond the minimum completion payload', async () => {
  window.history.replaceState(
    { tauOAuthCompletion: { localFlowId: FLOW, handle: HANDLE }, unrelated: true },
    '',
    '/settings/integrations/oauth/callback'
  )
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response()
  }) as typeof fetch

  await renderPage()

  expect(calls).toBe(0)
  expect(window.history.state).toBeNull()
})

test('malformed and provider-controlled callback material stays out of observable output', async () => {
  window.history.replaceState(
    null,
    '',
    '/settings/integrations/oauth/callback?flow=bad&handle=RAW_HANDLE&status=error&code=RAW_PROVIDER_ERROR'
  )
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response()
  }) as typeof fetch

  await renderPage()

  expect(calls).toBe(0)
  expect(window.location.search).toBe('')
  expect(window.history.state).toBeNull()
  expect(container.textContent).not.toContain('RAW_HANDLE')
  expect(container.textContent).not.toContain('RAW_PROVIDER_ERROR')
})

function storageValues(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? '') ?? '')
}

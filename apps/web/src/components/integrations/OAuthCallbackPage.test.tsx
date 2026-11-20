import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { BrowserRouter } from 'react-router'
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

const RESOLVE_PATH = 'http://localhost/api/integrations/authorization/provider'
type Call = { url: string; body: string }

/**
 * Core for the callback page: the provider lookup answers from the flow it is given (or fails as an
 * unknown flow), and every other request goes to `respond`.
 */
function mockCore(provider: string | null, respond: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  globalThis.fetch = (async (input, init) => {
    const call = { url: String(input), body: String(init?.body) }
    calls.push(call)
    if (call.url === RESOLVE_PATH)
      return provider
        ? Response.json({ provider })
        : Response.json({ error: 'invalid_or_expired_state', code: 'invalid_or_expired_state' }, { status: 400 })
    return respond(call)
  }) as typeof fetch
  return calls
}

const pending = () => new Promise<Response>(() => {})

for (const provider of ['github', 'notion'] as const) {
  test(`${provider} callback upgrades a legacy settings return to the expanded provider card`, async () => {
    if (provider === 'github')
      window.history.replaceState(null, '', CALLBACK.replace('/callback?', '/callback/github?'))
    mockCore(provider, () => Response.json({ returnTo: '/settings' }))
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

for (const provider of ['linear', 'notion', 'slack'] as const) {
  test(`a ${provider} completion with no hint (started in the Desktop app) completes against the provider Core names`, async () => {
    const calls = mockCore(provider, () => Response.json({ returnTo: '/settings' }))
    const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
    try {
      await renderPage()
      await flushEffects()
      expect(calls).toEqual([
        { url: RESOLVE_PATH, body: JSON.stringify({ localFlowId: FLOW }) },
        {
          url: `http://localhost/api/integrations/providers/${provider}/authorization/complete`,
          body: JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
        },
      ])
      expect(redirect).toHaveBeenCalledWith(`/settings?section=integrations&setting=integration-${provider}`)
    } finally {
      redirect.mockRestore()
    }
  })
}

test('a stale hint from another flow never steers completion; the provider Core names wins', async () => {
  window.sessionStorage.setItem('ficusOAuthProviderHint', 'notion')
  const calls = mockCore('linear', () => pending())

  await renderPage()
  await flushEffects()

  expect(calls.map((call) => call.url)).toEqual([
    RESOLVE_PATH,
    'http://localhost/api/integrations/providers/linear/authorization/complete',
  ])
  expect(container.textContent).toContain('Connecting Linear')
  expect(container.textContent).not.toContain('Notion')
  expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBeNull()
})

test('a Linear account-linking callback (no hint is ever set) completes against linear and returns to the account', async () => {
  const calls = mockCore('linear', () => Response.json({ returnTo: '/settings/linear-identity' }))
  const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
  try {
    await renderPage()
    await flushEffects()
    expect(calls.at(-1)?.url).toBe('http://localhost/api/integrations/providers/linear/authorization/complete')
    expect(redirect).toHaveBeenCalledWith('/settings?section=account&setting=linear-account')
  } finally {
    redirect.mockRestore()
  }
})

test('while Core is naming the provider the page names no provider, never Notion', async () => {
  globalThis.fetch = (async () => pending()) as typeof fetch

  await renderPage()

  expect(container.querySelector('h1')?.textContent).toBe('Finishing the connection')
})

test('a flow Core does not know for this person is a terminal failure and nothing is completed', async () => {
  const calls = mockCore(null, () => Response.json({ returnTo: '/settings' }))

  await renderPage()
  await flushEffects()

  expect(calls.map((call) => call.url)).toEqual([RESOLVE_PATH])
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Return to Settings and start again')
  expect(container.querySelector('h1')?.textContent).toBe('Finishing the connection')
  expect(window.history.state).toBeNull()
})

test('a provider answer that is not a provider key never becomes part of a request path', async () => {
  const calls = mockCore('../../auth/logout', () => Response.json({ returnTo: '/settings' }))

  await renderPage()
  await flushEffects()

  expect(calls.map((call) => call.url)).toEqual([RESOLVE_PATH])
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Return to Settings and start again')
})

test('a self-hosted Linear app callback posts the code to the linear provider', async () => {
  window.history.replaceState(null, '', `/settings/integrations/oauth/callback/linear?state=${HANDLE}&code=linear-code`)
  let request: { url: string; body: string } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), body: String(init?.body) }
    return Response.json({ returnTo: '/settings' })
  }) as typeof fetch
  const redirect = spyOn(window.location, 'replace').mockImplementation(() => {})
  try {
    await renderPage()
    await flushEffects()
    expect(request).toEqual({
      url: 'http://localhost/api/integrations/providers/linear/authorization/callback',
      body: JSON.stringify({ state: HANDLE, code: 'linear-code' }),
    })
    expect(container.textContent).toContain('Connecting Linear')
    expect(redirect).toHaveBeenCalledWith('/settings?section=integrations&setting=integration-linear')
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
    expect(path).not.toBe(RESOLVE_PATH)
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
    order.push('fetch')
    return new Promise<Response>(() => {})
  }) as typeof fetch

  await renderPage()

  expect(order).toEqual(['replaceState', 'fetch'])
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
  mockCore('notion', (call) => {
    bodies.push(call.body)
    if (bodies.length === 1) return Response.json({ error: 'broker_unavailable' }, { status: 503 })
    return pending()
  })

  await renderPage()
  await flushEffects()
  expect(container.textContent).toContain('try again')
  expect(window.location.search).toBe('')

  await harness.act(async () => root.unmount())
  ;({ root, container } = harness.createRoot())
  await renderPage()
  await flushEffects()

  expect(bodies).toEqual([
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
  ])
})

test('a reload after a retryable failure asks Core again and keeps completing against slack, not a default', async () => {
  const calls = mockCore('slack', () =>
    calls.filter((c) => c.url !== RESOLVE_PATH).length === 1
      ? Response.json({ error: 'broker_unavailable' }, { status: 503 })
      : pending()
  )

  await renderPage()
  await flushEffects()
  expect(container.textContent).toContain('try again')
  expect(container.textContent).toContain('Connecting Slack')

  await harness.act(async () => root.unmount())
  ;({ root, container } = harness.createRoot())
  await renderPage()
  await flushEffects()

  const completions = calls.filter((call) => call.url !== RESOLVE_PATH)
  expect(completions).toHaveLength(2)
  expect(completions.every((call) => call.url.includes('/integrations/providers/slack/authorization/complete'))).toBe(
    true
  )
  expect(container.textContent).toContain('Connecting Slack')
})

test('a provider lookup that cannot reach Core is retryable and the retry asks again', async () => {
  let lookups = 0
  const calls: Call[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) })
    if (String(input) === RESOLVE_PATH) {
      lookups += 1
      return lookups === 1
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json({ provider: 'linear' })
    }
    return pending()
  }) as typeof fetch

  await renderPage()
  await flushEffects()
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  await harness.act(async () => fireEvent.click(retry))
  await flushEffects()

  expect(calls.map((call) => call.url)).toEqual([
    RESOLVE_PATH,
    RESOLVE_PATH,
    'http://localhost/api/integrations/providers/linear/authorization/complete',
  ])
})

test('BrowserRouter reload metadata preserves and resends the exact hosted completion payload', async () => {
  window.history.replaceState(
    { ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE } },
    '',
    '/settings/integrations/oauth/callback'
  )
  let body = ''
  mockCore('notion', (call) => {
    body = call.body
    return pending()
  })

  await renderPageInBrowserRouter()
  await flushEffects()

  expect(window.history.state.idx).toBeNumber()
  expect(body).toBe(JSON.stringify({ localFlowId: FLOW, handle: HANDLE }))
})

test('retry resends the exact retained flow and handle body', async () => {
  const bodies: string[] = []
  mockCore('notion', (call) => {
    bodies.push(call.body)
    if (bodies.length === 1) return Response.json({ error: 'broker_timeout' }, { status: 503 })
    return pending()
  })

  await renderPage()
  await flushEffects()
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  expect(retry.className).toContain('focus-visible:ring-2')
  await harness.act(async () => fireEvent.click(retry))
  await flushEffects()

  expect(bodies).toEqual([
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
    JSON.stringify({ localFlowId: FLOW, handle: HANDLE }),
  ])
  expect(window.location.search).toBe('')
})

test('durable Core success clears the transient history payload', async () => {
  mockCore('notion', () => Response.json({ returnTo: '/settings' }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.invalidateQueries = (() => new Promise(() => {})) as typeof client.invalidateQueries

  await renderPage(client)
  await flushEffects()

  expect(window.history.state).toBeNull()
})

for (const terminalCode of ['completion_not_found', 'flow_expired']) {
  test(`explicitly terminal ${terminalCode} clears the transient history payload`, async () => {
    mockCore('notion', () => Response.json({ error: terminalCode }, { status: 400 }))

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
  const calls = mockCore('notion', (call) => {
    request = call
    return pending()
  })
  const fetchCore = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    order.push('fetch')
    return fetchCore(input, init)
  }) as typeof fetch

  await renderPage()
  await flushEffects()

  expect(order).toEqual(['replaceState', 'replaceState', 'fetch', 'fetch'])
  // The shared path names no provider, so Core names it from the state before the code is posted.
  expect(calls[0]).toEqual({ url: RESOLVE_PATH, body: JSON.stringify({ state: HANDLE }) })
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
  mockCore('slack', (call) => {
    body = call.body
    return Response.json({ error: 'provider_denied' }, { status: 400 })
  })

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

for (const provider of ['linear', 'notion', 'slack'] as const) {
  const label = { linear: 'Linear', notion: 'Notion', slack: 'Slack' }[provider]

  test(`a cancelled ${provider} callback names ${label}`, async () => {
    window.sessionStorage.setItem('ficusOAuthProviderHint', provider)
    window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=denied')
    globalThis.fetch = (async () => new Response()) as typeof fetch

    await renderPage()

    expect(container.querySelector('h1')?.textContent).toBe(`Connecting ${label}`)
    expect(container.textContent).toContain('Authorization cancelled')
  })

  test(`a failed ${provider} broker callback names ${label} and shows the safe reason`, async () => {
    window.sessionStorage.setItem('ficusOAuthProviderHint', provider)
    window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=error&code=rate_limited')
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response()
    }) as typeof fetch

    await renderPage()

    expect(calls).toBe(0)
    expect(container.querySelector('h1')?.textContent).toBe(`Connecting ${label}`)
    const alert = container.querySelector('[role="alert"]')?.textContent
    expect(alert).toContain('Return to Settings and start again')
    expect(alert).toContain('The provider is limiting requests.')
    expect(alert).toContain('(Code: rate_limited)')
  })
}

test('a failed callback with an unlisted safe code shows the code, and without a hint names no provider', async () => {
  window.history.replaceState(null, '', '/settings/integrations/oauth/callback?status=error&code=provider_mismatch')
  globalThis.fetch = (async () => new Response()) as typeof fetch

  await renderPage()

  expect(container.querySelector('h1')?.textContent).toBe('Finishing the connection')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'The provider reported an error. (Code: provider_mismatch)'
  )
})

test('a fresh malformed callback cannot fall back to a stale history payload', async () => {
  window.history.replaceState(
    { ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE } },
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
    { ficusOAuthCompletion: { localFlowId: FLOW, handle: HANDLE }, unrelated: true },
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

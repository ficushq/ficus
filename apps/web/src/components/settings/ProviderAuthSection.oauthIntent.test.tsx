import { fireEvent, waitFor } from '@testing-library/dom'
import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import type { ProviderAuthEntry } from '../../api/providerAuth'

const { ProviderRow, ProviderAuthSection } = await import('./ProviderAuthSection')

/**
 * Call-site wiring for OAuth intent.
 *
 * The store/route layers decide ADD vs REAUTHORIZE from the presence of
 * `accountId`, so the BUTTONS are the last link in the chain: if the per-account
 * "Re-authorize" action forgot to pass its accountId it would silently become an
 * ADD, and if the provider-level "Add account" action passed one it would become
 * a reauthorize — the original clobber. Both are invisible to render-only tests,
 * so these drive real clicks and assert the exact request body that leaves the app.
 */
const oauthEntry: ProviderAuthEntry = {
  provider: 'openai-codex',
  type: 'oauth',
  hasCredential: true,
  configured: true,
  disabled: false,
  accounts: [
    { id: 'acc_FIRST', label: 'Work', enabled: true, type: 'oauth', health: 'available' },
    { id: 'acc_SECOND', label: 'Personal', enabled: true, type: 'oauth', health: 'available' },
  ],
}

const providerReg = {
  id: 'openai',
  name: 'OpenAI',
  description: 'GPT and o-series models',
  oauthId: 'openai-codex',
  oauthLabel: 'ChatGPT Plus/Pro',
}

type FetchCall = { url: string; method?: string; body?: string }

async function withProviderRow(
  run: (ctx: {
    dom: Awaited<ReturnType<typeof acquireDomHarness>>
    calls: FetchCall[]
    buttons: () => HTMLButtonElement[]
  }) => Promise<void>,
  chooseMethod = false,
  cancelFails = false
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } },
  })
  // A previous successful login can leave status cached when another account is added.
  if (chooseMethod)
    queryClient.setQueryData(queryKeys.providerAuth.oauthStatus('openai-codex'), { need: { kind: 'done' } })
  const dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  const rendered = dom.createRoot()
  const calls: FetchCall[] = []
  let selected: string | null = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
    if (String(input).endsWith('/oauth/cancel')) {
      if (cancelFails)
        return new dom.window.Response(JSON.stringify({ error: 'Could not cancel login' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response
      selected = null
    }
    if (String(input).endsWith('/oauth/select')) selected = JSON.parse(init!.body as string).optionId
    // Model the provider's method chooser when exercising automatic selection.
    return new dom.window.Response(
      JSON.stringify({
        provider: 'openai-codex',
        need: chooseMethod
          ? selected
            ? selected === 'browser'
              ? { kind: 'code', authUrl: 'https://example.com/browser' }
              : {
                  kind: 'device_code',
                  userCode: 'TEST-CODE',
                  verificationUri: 'https://example.com/device',
                  expiresInSeconds: 900,
                }
            : {
                kind: 'select',
                message: 'Choose method',
                options: [
                  { id: 'device_code', label: 'Device' },
                  { id: 'browser', label: 'Browser' },
                ],
              }
          : { kind: 'code', authUrl: 'https://x/auth' },
        status: 'started',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ) as unknown as Response
  }) as unknown as typeof fetch
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <ProviderRow provider={providerReg} oauthEntry={oauthEntry} oauthAvailable={true} canWrite={true} />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => Bun.sleep(10))
    await run({
      dom,
      calls,
      buttons: () => [...dom.window.document.querySelectorAll('button')] as unknown as HTMLButtonElement[],
    })
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
    queryClient.clear()
  }
}

const startCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes('/oauth/start'))

describe('OAuth intent is wired at the button call sites', () => {
  test("Re-authorize on the SECOND account row sends that row's accountId", async () => {
    await withProviderRow(async ({ dom, calls, buttons }) => {
      expect(buttons().some((button) => button.textContent === 'Re-authorize')).toBe(false)
      await dom.act(async () =>
        buttons()
          .find((button) => button.getAttribute('aria-label') === 'Account options for Personal')!
          .click()
      )
      const reauth = buttons().find((button) => button.textContent === 'Re-authorize')
      expect(reauth).toBeDefined()
      await dom.act(async () => {
        reauth!.click()
        await waitFor(() => expect(startCalls(calls)).toHaveLength(1))
      })

      const started = startCalls(calls)
      expect(started).toHaveLength(1)
      expect(started[0]!.method).toBe('POST')
      expect(JSON.parse(started[0]!.body!)).toEqual({ accountId: 'acc_SECOND' })
    })
  })

  test('Add account (provider-level) sends NO accountId, so completion appends', async () => {
    await withProviderRow(async ({ dom, calls, buttons }) => {
      const addButton = buttons().find((b) => b.textContent === 'Connect another account')
      expect(addButton).toBeDefined()
      await dom.act(async () => addButton!.click())

      // OAuth-capable provider → chooser first; pick the OAuth branch.
      const oauthChoice = buttons().find((b) => b.textContent?.startsWith('Login with'))
      expect(oauthChoice).toBeDefined()
      await dom.act(async () => oauthChoice!.click())
      await dom.act(async () => Bun.sleep(10))

      const started = startCalls(calls)
      expect(started).toHaveLength(1)
      expect(started[0]!.method).toBe('POST')
      // No body at all — an accountId here would turn ADD back into a clobber.
      expect(started[0]!.body).toBeUndefined()
    })
  })
})

for (const method of ['device_code', 'browser'] as const) {
  test(`OpenAI selects ${method} once from the corresponding login button`, async () => {
    await withProviderRow(async ({ dom, calls, buttons }) => {
      await dom.act(async () =>
        buttons()
          .find((button) => button.textContent === 'Connect another account')!
          .click()
      )
      const label = method === 'device_code' ? 'Login with ChatGPT Plus/Pro' : 'Browser login (fallback)'
      await dom.act(async () => {
        buttons()
          .find((button) => button.textContent === label)!
          .click()
        await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/oauth/select')).length).toBe(1))
      })
      expect(JSON.parse(calls.find((call) => call.url.endsWith('/oauth/select'))!.body!)).toEqual({ optionId: method })
    }, true)
  })
}

test('cancel device login retires the flow before browser fallback starts a fresh choice', async () => {
  await withProviderRow(async ({ dom, calls, buttons }) => {
    const click = async (label: string) =>
      dom.act(async () =>
        buttons()
          .find((button) => button.textContent === label)!
          .click()
      )
    await click('Connect another account')
    await click('Login with ChatGPT Plus/Pro')
    await dom.act(async () => waitFor(() => expect(dom.window.document.body.textContent).toContain('TEST-CODE')))
    await click('Cancel')
    await dom.act(async () =>
      waitFor(() => expect(buttons().some((button) => button.textContent === 'Connect another account')).toBe(true))
    )
    expect(calls.filter((call) => call.url.endsWith('/oauth/cancel'))).toHaveLength(1)
    await click('Connect another account')
    await click('Browser login (fallback)')
    await dom.act(async () =>
      waitFor(() => expect(calls.filter((call) => call.url.endsWith('/oauth/select'))).toHaveLength(2))
    )
    expect(
      calls.filter((call) => call.url.endsWith('/oauth/select')).map((call) => JSON.parse(call.body!).optionId)
    ).toEqual(['device_code', 'browser'])
    await dom.act(async () => waitFor(() => expect(dom.window.document.body.textContent).not.toContain('TEST-CODE')))
    expect(startCalls(calls)).toHaveLength(2)
  }, true)
})

test('failed server cancellation leaves the device flow visible for retry', async () => {
  await withProviderRow(
    async ({ dom, calls, buttons }) => {
      for (const label of ['Connect another account', 'Login with ChatGPT Plus/Pro']) {
        await dom.act(async () =>
          buttons()
            .find((button) => button.textContent === label)!
            .click()
        )
      }
      await dom.act(async () => waitFor(() => expect(dom.window.document.body.textContent).toContain('TEST-CODE')))
      await dom.act(async () =>
        buttons()
          .find((button) => button.textContent === 'Cancel')!
          .click()
      )
      await dom.act(async () =>
        waitFor(() => expect(dom.window.document.body.textContent).toContain('Could not cancel login'))
      )
      expect(dom.window.document.body.textContent).toContain('TEST-CODE')
      expect(startCalls(calls)).toHaveLength(1)
    },
    true,
    true
  )
})

async function renderOnboardingProviders(
  run: (ctx: {
    dom: Awaited<ReturnType<typeof acquireDomHarness>>
    container: HTMLElement
    calls: FetchCall[]
  }) => Promise<void>
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  // Saving a key invalidates these, so the stubbed server answers with the same data.
  const responses: Record<string, unknown> = {
    '/provider-auth': [],
    '/provider-auth/catalog': [{ id: 'zai', label: 'Z.ai', modelCount: 12, oauthAvailable: false, disabled: false }],
    '/provider-auth/oauth/providers': [{ id: 'openai-codex', name: 'OpenAI' }],
    '/provider-auth/openrouter/routing': {},
  }
  client.setQueryData(queryKeys.auth.permissions(undefined), {
    permissions: ['provider-auth:read', 'provider-auth:write'],
  })
  client.setQueryData(queryKeys.providerAuth.list(), responses['/provider-auth'])
  client.setQueryData(queryKeys.providerAuth.catalog(), responses['/provider-auth/catalog'])
  client.setQueryData(queryKeys.providerAuth.oauthProviders(), responses['/provider-auth/oauth/providers'])
  client.setQueryData(queryKeys.providerAuth.openRouterRouting(), responses['/provider-auth/openrouter/routing'])
  const dom = await acquireDomHarness({ url: 'http://localhost/onboarding' })
  const calls: FetchCall[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    return Response.json((init?.method ?? 'GET') === 'GET' ? (responses[path] ?? {}) : {})
  }) as unknown as typeof fetch
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProviderAuthSection onboarding />
        </QueryClientProvider>
      )
    )
    await run({ dom, container, calls })
  } finally {
    globalThis.fetch = originalFetch
    await client.cancelQueries()
    await dom.cleanup()
    client.clear()
  }
}

test('onboarding provider selection opens sign-in inline without a settings redirect', async () => {
  await renderOnboardingProviders(async ({ dom, container }) => {
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Choose an AI provider')
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual(['Anthropic', 'OpenAI'])
    expect(container.querySelector('a[href*="settings"]')).toBeNull()
    await dom.act(async () => radios[1]!.click())
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('ChatGPT Plus/Pro')
    expect(container.textContent).toContain('API key')
    expect(container.querySelector('a[href*="settings"]')).toBeNull()
  })
})

test('onboarding providers chosen from More providers drive the same setup as before', async () => {
  await renderOnboardingProviders(async ({ dom, container, calls }) => {
    const document = dom.window.document
    const openMore = () =>
      dom.act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click())
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
    const listed = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('ul button')]

    await openMore()
    const names = listed().map((button) => button.querySelector('.font-medium')!.textContent)
    // Everything the old <select> offered besides the two cards, in the same (common-first) order.
    expect(names).toEqual([
      'OpenRouter',
      'Z.ai',
      'GitHub Copilot',
      'Google',
      'Google Antigravity',
      'Local or custom provider',
    ])

    await dom.act(async () =>
      fireEvent.change(dialog()!.querySelector('input[type="search"]')!, { target: { value: 'z.a' } })
    )
    await dom.act(async () => listed()[0]!.click())
    expect(dialog()).toBeNull()
    // The catalog provider's setup opens straight to its API key form, keyed by the same id.
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await dom.act(async () => fireEvent.change(keyInput, { target: { value: 'sk-test' } }))
    const posts = () => calls.filter((call) => call.method === 'POST')
    await dom.act(async () => {
      ;[...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click()
      await waitFor(() => expect(posts()).toHaveLength(1))
    })
    expect(posts()[0]!.url).toEndWith('/provider-auth/zai/accounts')
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ key: 'sk-test' })

    await openMore()
    await dom.act(async () =>
      listed()
        .find((button) => button.textContent?.includes('Local or custom provider'))!
        .click()
    )
    // "custom" still opens the compatible-server setup in place of the Z.ai account form.
    expect(container.querySelector('[aria-label="Custom server URL"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Account label')
  })
})

test('device login stays visible through delayed startup and code preparation', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  const { root, container } = dom.createRoot()
  const originalFetch = globalThis.fetch
  const start = Promise.withResolvers<void>()
  let selected = false
  let ready = false
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/oauth/start')) await start.promise
    if (url.endsWith('/oauth/select')) selected = true
    return Response.json({
      provider: 'openai-codex',
      need: !selected
        ? { kind: 'select', message: 'Choose method', options: [{ id: 'device_code', label: 'Device' }] }
        : ready
          ? {
              kind: 'device_code',
              userCode: 'READY-CODE',
              verificationUri: 'https://example.com/device',
              expiresInSeconds: 900,
            }
          : { kind: 'starting' },
      status: 'started',
    })
  }) as typeof fetch
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProviderRow provider={providerReg} oauthEntry={oauthEntry} oauthAvailable canWrite />
        </QueryClientProvider>
      )
    )
    const click = (label: string) =>
      dom.act(async () => {
        ;[...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click()
      })
    await click('Connect another account')
    await click('Login with ChatGPT Plus/Pro')
    const card = container.querySelector('[aria-label="Device login"]')!
    expect(card).not.toBeNull()
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.textContent).toContain('Preparing code and sign-in link')
    expect(card.querySelector('a')).toBeNull()
    expect(card.querySelector('button')!.disabled).toBe(true)
    await dom.act(async () => {
      start.resolve()
      await waitFor(() => expect(selected).toBe(true))
    })
    await dom.act(async () =>
      waitFor(() => {
        expect(
          client.getQueryData<{ need: { kind: string } }>(queryKeys.providerAuth.oauthStatus('openai-codex'))?.need.kind
        ).toBe('starting')
      })
    )
    expect(container.querySelector('[aria-label="Device login"]')).toBe(card)
    expect(card.getAttribute('aria-busy')).toBe('true')
    ready = true
    await dom.act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.providerAuth.oauthStatus('openai-codex') })
    })
    await dom.act(async () => waitFor(() => expect(card.textContent).toContain('READY-CODE')))
    expect(container.querySelector('[aria-label="Device login"]')).toBe(card)
    expect(card.getAttribute('aria-busy')).toBe('false')
    expect(card.querySelector('a')?.getAttribute('href')).toBe('https://example.com/device')
    expect(card.querySelector('button')!.disabled).toBe(false)
  } finally {
    start.resolve()
    await client.cancelQueries()
    await dom.cleanup()
    client.clear()
    globalThis.fetch = originalFetch
  }
})

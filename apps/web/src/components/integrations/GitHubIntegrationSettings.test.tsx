import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys, onboardingQueryKeys } from '../../queryKeys'
import { GitHubIntegrationSettings } from './GitHubIntegrationSettings'
import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/github-app'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let oldFetch: typeof globalThis.fetch
let client: QueryClient
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  oldFetch = globalThis.fetch
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('github'), [])
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: [{ key: 'github', enabled: false }] })
  client.setQueryData(integrationQueryKeys.githubWebhook(), {
    configured: false,
    webhookUrl: 'http://localhost/api/webhooks/github',
  })
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'github'], {
    authority: 'local',
    configured: true,
    clientId: 'public-app',
    authorizationMode: 'device',
    requiredCapabilities: [],
  })
})
afterEach(async () => {
  await harness.cleanup()
  client.clear()
  globalThis.fetch = oldFetch
})

test('device login displays only the public code and cancellation removes it', async () => {
  const requests: Array<{ url: string; body: string }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url, body: String(init?.body ?? '') })
    if (url.endsWith('/cancel')) return Response.json({ cancelled: true })
    return Response.json({
      kind: 'device',
      id: 'device-id',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      intervalSeconds: 60,
    })
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!
  await harness.act(async () => {
    fireEvent.click(button('Connect account'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(container.textContent).toContain('ABCD-EFGH')
  expect(container.textContent).toContain('This code expires in 15 minutes.')
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  let copiedCode = ''
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedCode = text
        },
      },
    })
    await harness.act(async () => fireEvent.click(container.querySelector('[aria-label="Copy GitHub device code"]')!))
    expect(copiedCode).toBe('ABCD-EFGH')
    expect(container.textContent).toContain('Copied')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    await harness.act(async () => fireEvent.click(container.querySelector('[aria-label="Copy GitHub device code"]')!))
    expect(container.textContent).toContain('Could not copy. Select the code to copy it manually.')
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }

  expect(container.querySelector('a[href="https://github.com/login/device"]')).not.toBeNull()
  expect(JSON.parse(requests[0].body)).toEqual({
    returnTo: '/settings',
  })
  await harness.act(async () => {
    fireEvent.click(button('Cancel'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(container.textContent).not.toContain('ABCD-EFGH')
  expect(requests.at(-1)?.url).toEndWith('/device/device-id/cancel')
})

test('read-only users cannot connect or configure an app', async () => {
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite={false} />
      </QueryClientProvider>
    )
  )
  expect(container.textContent).not.toContain('Connect account')
  expect(container.querySelector('input[type="password"]')).toBeNull()
})

test.each(['local', 'platform_broker'] as const)(
  '%s reconnect sends the selected account and a path-only return target',
  async (authority) => {
    let body = ''
    globalThis.fetch = (async (_input, init) => {
      body = String(init?.body)
      return new Promise<Response>(() => {})
    }) as typeof fetch
    client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'github'], {
      authority,
      configured: true,
      clientId: authority === 'local' ? FICUS_GITHUB_APP_CLIENT_ID : null,
      requiredCapabilities: [],
    })
    client.setQueryData(integrationQueryKeys.pool('github'), [
      {
        id: 'selected-account',
        displayName: 'Example',
        configuration: { login: 'example' },
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        usage: { squadCount: 1, squads: [] },
      },
    ])
    const { root, container } = harness.createRoot()
    await harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GitHubIntegrationSettings canRead canWrite />
        </QueryClientProvider>
      )
    )
    await harness.act(async () => {
      fireEvent.click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(JSON.parse(body)).toEqual({ returnTo: '/settings', connectionId: 'selected-account' })
  }
)

test('Ficus app users can grant repository access during onboarding and after connecting an account', async () => {
  const { root, container } = harness.createRoot()
  for (const authority of ['local', 'platform_broker'] as const) {
    for (const onboarding of [true, false]) {
      await harness.act(async () => {
        client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'github'], {
          authority,
          configured: true,
          clientId: authority === 'local' ? FICUS_GITHUB_APP_CLIENT_ID : null,
          requiredCapabilities: [],
        })
        root.render(
          <QueryClientProvider client={client}>
            <GitHubIntegrationSettings canRead canWrite onboarding={onboarding} />
          </QueryClientProvider>
        )
      })
      await waitFor(() => {
        const link = container.querySelector<HTMLAnchorElement>(
          'a[href="https://github.com/apps/ficus-integration/installations/new"]'
        )
        expect(link?.textContent).toBe('Grant repository access')
        expect(link?.target).toBe('_blank')
        expect(link?.rel).toBe('noreferrer')
        expect(container.textContent).toContain('Connecting an account does not grant repository access')
        expect(container.textContent).toContain("owner's approval")
      })
    }
  }
})

test('custom GitHub Apps are not sent to install the Ficus app', async () => {
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  expect(container.querySelector('a[href="https://github.com/apps/ficus-integration/installations/new"]')).toBeNull()
  expect(container.textContent).toContain('Install your GitHub App')
  expect(container.querySelector('a[href="https://github.com/settings/installations"]')).not.toBeNull()
})

test('webhook secret saves through Integrations and the entered value is cleared', async () => {
  const requests: { url: string; body: string }[] = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? '') })
    return Response.json({ configured: true, webhookUrl: 'https://ficus.example/api/webhooks/github' })
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const input = container.querySelector<HTMLInputElement>('input[aria-label="GitHub webhook secret"]')!
  await harness.act(async () => {
    fireEvent.input(input, { target: { value: 'candidate-webhook-secret' } })
  })
  await harness.act(async () => {
    fireEvent.submit(input.closest('form')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(requests).toEqual([
    {
      url: expect.stringContaining('/integrations/providers/github/webhook'),
      body: JSON.stringify({ secret: 'candidate-webhook-secret' }),
    },
  ])
  expect(input.value).toBe('')
  expect(container.textContent).toContain('Webhook secret saved.')
  expect(JSON.stringify(client.getQueryData(integrationQueryKeys.githubWebhook()))).not.toContain(
    'candidate-webhook-secret'
  )
  const disable = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Disable direct webhooks'
  )!
  await harness.act(async () => {
    fireEvent.click(disable)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(JSON.parse(requests.at(-1)!.body)).toEqual({ secret: null })
})

test('onboarding enables GitHub before login and returns authorization to onboarding', async () => {
  const requests: { url: string; body: string }[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url, body: String(init?.body ?? '') })
    if (url.endsWith('/enabled')) return Response.json({ enabled: true })
    return Response.json({
      kind: 'device',
      id: 'onboarding-device',
      userCode: 'SETUP-CODE',
      verificationUri: 'https://github.com/login/device',
      expiresAt: '2026-09-08T00:00:00Z',
      intervalSeconds: 60,
    })
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite embedded onboarding />
      </QueryClientProvider>
    )
  )
  expect(container.textContent).not.toContain('Webhook delivery')
  expect(container.querySelector('details summary')?.textContent).toBe('Use your own GitHub App instead')
  await harness.act(async () => {
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect account')!
    )
  })
  expect(requests[0].url).toEndWith('/github/enabled')
  expect(JSON.parse(requests[0].body)).toEqual({ enabled: true })
  expect(JSON.parse(requests[1].body)).toEqual({ returnTo: '/onboarding' })
  expect(container.textContent).toContain('SETUP-CODE')
})

test('onboarding can enable an existing healthy account without another login', async () => {
  client.setQueryData(integrationQueryKeys.pool('github'), [
    {
      id: 'existing',
      displayName: 'Work account',
      configuration: { login: 'fixture' },
      isGlobalDefault: true,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      usage: { squadCount: 1 },
    },
  ])
  const requests: Array<{ url: string; method?: string; body?: string }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
    if (String(input).endsWith('/enabled')) return Response.json({ enabled: true })
    return Response.json([])
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite embedded onboarding />
      </QueryClientProvider>
    )
  )
  await harness.act(async () => {
    fireEvent.click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Use GitHub')!)
    await waitFor(() => expect(requests.some((request) => request.url.endsWith('/github/enabled'))).toBe(true))
  })
  const enable = requests.find((request) => request.url.endsWith('/github/enabled'))!
  expect(JSON.parse(enable.body!)).toEqual({ enabled: true })
  expect(requests.some((request) => request.url.includes('/authorize'))).toBe(false)
})

test('GitHub account updates in the same millisecond refresh onboarding without asking to use GitHub again', async () => {
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: [{ key: 'github', enabled: true }] })
  const checklistKey = [...onboardingQueryKeys.all, 'stale-checklist']
  client.setQueryData(checklistKey, { github: 'todo' })
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite embedded onboarding />
      </QueryClientProvider>
    )
  )
  client.setQueryData(checklistKey, { github: 'todo' })
  expect(client.getQueryState(checklistKey)?.isInvalidated).toBe(false)
  await harness.act(async () => {
    const updatedAt = client.getQueryState(integrationQueryKeys.pool('github'))!.dataUpdatedAt
    client.setQueryData(
      integrationQueryKeys.pool('github'),
      [
        {
          id: 'fresh',
          displayName: 'Work account',
          configuration: { login: 'fixture' },
          enabled: true,
          authState: 'authenticated',
          healthState: 'healthy',
          usage: { squadCount: 1 },
        },
      ],
      { updatedAt }
    )
  })
  await harness.act(async () => {
    await waitFor(() => expect(client.getQueryState(checklistKey)?.isInvalidated).toBe(true))
  })
  expect(container.textContent).toContain('Work account')
  expect(container.textContent).not.toContain('Use GitHub')
})

test('global default account is first and changing it preserves the other accounts and cached order', async () => {
  const accounts = ['Personal', 'Work', 'Other'].map((name, index) => ({
    id: name,
    displayName: name,
    configuration: { login: name.toLowerCase() },
    isGlobalDefault: index === 1,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    usage: { squadCount: 0 },
  }))
  client.setQueryData(integrationQueryKeys.pool('github'), accounts)
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const displayed = () => [...container.querySelectorAll('p.font-medium')].map((row) => row.textContent)
  expect(displayed()).toEqual(['WorkGlobal default', 'Personal', 'Other'])
  expect(accounts.map((account) => account.id)).toEqual(['Personal', 'Work', 'Other'])
  await harness.act(async () => {
    client.setQueryData(
      integrationQueryKeys.pool('github'),
      accounts.map((account) => ({
        ...account,
        isGlobalDefault: account.id === 'Other',
      }))
    )
    await waitFor(() => expect(displayed()).toEqual(['OtherGlobal default', 'Personal', 'Work']))
  })
})

test('a failed login shows the server reason and Retry starts a new login', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (input) => {
    requests.push(String(input))
    if (requests.length === 1)
      return Response.json(
        {
          error:
            "Device authorization is disabled for this GitHub App. Enable device flow in the app's settings or add a client secret.",
          code: 'device_flow_disabled',
        },
        { status: 400 }
      )
    return Response.json({
      kind: 'device',
      id: 'retry-device',
      userCode: 'RETRY-CODE',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      intervalSeconds: 60,
    })
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  await harness.act(async () => {
    fireEvent.click(button('Connect account')!)
  })
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Device authorization is disabled for this GitHub App. Enable device flow in the app's settings or add a client secret."
    )
  )
  expect(container.textContent).not.toContain('GitHub operation failed')
  await harness.act(async () => {
    fireEvent.click(button('Retry')!)
  })
  await waitFor(() => expect(container.textContent).toContain('RETRY-CODE'))
  expect(requests).toHaveLength(2)
  expect(requests.every((url) => url.endsWith('/integrations/providers/github/authorization/start'))).toBe(true)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button('Retry')).toBeUndefined()
})

test('connecting from the instance password session offers to finish admin setup instead of Retry', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'Finish setting up your admin account to connect GitHub.', code: 'first_admin_incomplete' },
      { status: 403 }
    )) as typeof fetch
  let finishCalls = 0
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite onFinishAdminSetup={() => finishCalls++} />
      </QueryClientProvider>
    )
  )
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  await harness.act(async () => {
    fireEvent.click(button('Connect account')!)
  })
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Finish setting up your admin account to connect GitHub.'
    )
  )
  expect(button('Retry')).toBeUndefined()
  await harness.act(async () => {
    fireEvent.click(button('Finish admin setup')!)
  })
  expect(finishCalls).toBe(1)
})

test('failed app settings and account changes report the server reason instead of fixed text', async () => {
  client.setQueryData(integrationQueryKeys.pool('github'), [
    {
      id: 'account',
      displayName: 'Example',
      configuration: { login: 'example' },
      isGlobalDefault: true,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      usage: { squadCount: 0, squads: [] },
    },
  ])
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith('/oauth-app'))
      return Response.json({ error: 'OAuth application configuration failed' }, { status: 400 })
    return new Response('Internal Server Error', { status: 500 })
  }) as typeof fetch
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!
  await harness.act(async () => {
    fireEvent.click(button('Use Ficus app'))
  })
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('OAuth application configuration failed')
  )
  expect(button('Retry')).toBeUndefined()
  await harness.act(async () => {
    fireEvent.click(button('Disable'))
  })
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't update the GitHub account.")
  )
})

test("Ficus's default app explains that login needs no setup", async () => {
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'github'], {
    authority: 'local',
    configured: true,
    clientId: FICUS_GITHUB_APP_CLIENT_ID,
    authorizationMode: 'device',
    callbackUrl: 'http://localhost/settings/integrations/oauth/callback/github',
    requiredCapabilities: [],
  })
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubIntegrationSettings canRead canWrite embedded onboarding />
      </QueryClientProvider>
    )
  )
  expect(container.textContent).toContain(
    "Uses Ficus's GitHub App, so no setup is needed. You'll get a code to enter on github.com."
  )
  expect(container.textContent).toContain('no public URL is needed')
  expect(container.textContent).toContain('http://localhost/settings/integrations/oauth/callback/github')
})

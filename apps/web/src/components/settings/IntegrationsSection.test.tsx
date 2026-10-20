import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { integrationQueryKeys } from '../../queryKeys'
import { IntegrationsSection } from './IntegrationsSection'
import { SettingsSearchDestination } from './SettingsSearchDestination'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let oldFetch: typeof fetch
let scrollDescriptor: PropertyDescriptor | undefined
let scrolled: string[]
const entries = [
  { key: 'github', label: 'GitHub', enabled: false, description: 'Code' },
  { key: 'notion', label: 'Notion', enabled: true, description: 'Knowledge' },
  { key: 'bigbrain', label: 'BigBrain', description: 'Memory' },
]
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  oldFetch = globalThis.fetch
  scrolled = []
  scrollDescriptor = Object.getOwnPropertyDescriptor(harness.window.HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(harness.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement) {
      scrolled.push(this.id)
    },
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: entries.map((item) => ({ ...item })) })
  client.setQueryData(integrationQueryKeys.pool('github'), [])
  client.setQueryData(integrationQueryKeys.githubWebhook(), {
    configured: false,
    webhookUrl: 'http://localhost/api/webhooks/github',
  })
  client.setQueryData(integrationQueryKeys.oauthApp('github'), {
    authority: 'local',
    configured: true,
    authorizationMode: 'device',
    requiredCapabilities: [],
  })
})
afterEach(async () => {
  if (scrollDescriptor) Object.defineProperty(harness.window.HTMLElement.prototype, 'scrollIntoView', scrollDescriptor)
  else Reflect.deleteProperty(harness.window.HTMLElement.prototype, 'scrollIntoView')
  await harness.cleanup()
  client.clear()
  globalThis.fetch = oldFetch
})
async function render(writable = true, target?: string) {
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({
            permissions: [],
            can: (permission) => writable || permission.startsWith('integrations:read:'),
            isLoading: false,
            isError: false,
          })}
        >
          <SettingsSearchDestination section="integrations" target={target}>
            <IntegrationsSection />
          </SettingsSearchDestination>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  return container
}
test('directory is compact by default and search filters cards by name and purpose', async () => {
  const container = await render()
  expect(container.querySelectorAll('article')).toHaveLength(3)
  expect([...container.querySelectorAll('article h4')].map((heading) => heading.textContent)).toEqual([
    'Notion',
    'BigBrain',
    'GitHub',
  ])
  expect(container.querySelector('[aria-label="Enable BigBrain globally"]')?.getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[aria-label="Enabled integrations"]')?.textContent).toContain('Notion')
  expect(container.querySelector('[aria-label="Disabled integrations"]')?.textContent).toContain('GitHub')
  const search = container.querySelector('input[aria-label="Search integrations"]')!
  await harness.act(async () => fireEvent.change(search, { target: { value: ' REPOSITORIES ' } }))
  expect(container.querySelectorAll('article')).toHaveLength(1)
  expect(container.querySelector('article')?.textContent).toContain('GitHub')
  await harness.act(async () => fireEvent.change(search, { target: { value: 'absent' } }))
  expect(container.querySelectorAll('article')).toHaveLength(0)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('No integrations match')
})
test('global enable saves on the server and reveals settings; disable hides them', async () => {
  let enabled = false
  const writes: boolean[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/github/enabled')) {
      enabled = JSON.parse(String(init?.body)).enabled
      writes.push(enabled)
      return Response.json({ enabled })
    }
    if (url.endsWith('/catalog'))
      return Response.json({
        integrations: entries.map((item) => (item.key === 'github' ? { ...item, enabled } : item)),
      })
    if (new URL(url, 'http://localhost').pathname.endsWith('/connections')) return Response.json([])
    if (url.endsWith('/webhook'))
      return Response.json({ configured: false, webhookUrl: 'http://localhost/api/webhooks/github' })
    return Response.json({
      authority: 'local',
      configured: true,
      authorizationMode: 'device',
      requiredCapabilities: [],
    })
  }) as typeof fetch
  const container = await render()
  const toggle = () => container.querySelector('[aria-label="Enable GitHub globally"]')!
  await harness.act(async () => {
    fireEvent.click(toggle())
    await waitFor(() => expect(writes).toEqual([true]))
  })
  await harness.act(async () => {
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))
    expect(scrolled).toEqual(['integration-card-github'])
    expect(container.querySelector('[aria-label="Enabled integrations"] #integration-card-github')).not.toBeNull()
  })
  expect(container.querySelector('#integration-settings-github')).not.toBeNull()
  await harness.act(async () => {
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle())
  })
  await harness.act(async () => {
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
  })
  expect(writes).toEqual([true, false])
  expect(container.querySelector('#integration-settings-github')).toBeNull()
})
test('read-only users see states but cannot switch integrations', async () => {
  const container = await render(false)
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].every((button) => button.disabled)).toBe(
    true
  )
})
test('failed toggle keeps disabled settings hidden and shows an error', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'Unavailable' }, { status: 503 })) as typeof fetch
  const container = await render()
  const toggle = () => container.querySelector('[aria-label="Enable GitHub globally"]')!
  await harness.act(async () => {
    fireEvent.click(toggle())
  })
  await harness.act(async () => {
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
  })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('#integration-settings-github')).toBeNull()
})

test('deployment providers reveal protected token fields inside their cards', async () => {
  const provider = {
    key: 'vercel',
    label: 'Vercel',
    enabled: true,
    description: 'Deploy apps',
    connectionMode: 'deployment',
  }
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: [provider] })
  const fields = [
    {
      key: 'DEPLOY_VERCEL_TOKEN',
      label: 'Access token',
      secret: true,
      configured: true,
      placeholder: 'Vercel access token',
    },
  ]
  client.setQueryData(integrationQueryKeys.deploymentSettings('vercel'), { fields })
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json({ fields })
  }) as typeof fetch
  const container = await render()
  await harness.act(async () =>
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Settings'))!
    )
  )
  const token = container.querySelector('input[type="password"]') as HTMLInputElement
  expect(token).not.toBeNull()
  expect(token.value).toBe('')
  expect(token.placeholder).toContain('replacement')
  await harness.act(async () => fireEvent.change(token, { target: { value: 'new-test-token' } }))
  await harness.act(async () =>
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Save credentials'))!
    )
  )
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.url.endsWith('/providers/vercel/deployment-settings') &&
          (call.body as Record<string, string>)?.DEPLOY_VERCEL_TOKEN === 'new-test-token'
      )
    ).toBe(true)
  )
})

test('Google service accounts use a blank multiline field and save through the integration', async () => {
  const provider = {
    key: 'google-cloud',
    label: 'Google Cloud',
    enabled: true,
    description: 'Read aloud',
    connectionMode: 'service',
  }
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: [provider] })
  const fields = [
    {
      key: 'GOOGLE_SERVICE_ACCOUNT_JSON',
      label: 'Service account JSON',
      secret: true,
      multiline: true,
      configured: true,
      placeholder: 'Service account JSON',
    },
  ]
  client.setQueryData(integrationQueryKeys.serviceSettings('google-cloud'), { fields })
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json({ fields })
  }) as typeof fetch
  const container = await render()
  await harness.act(async () =>
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Settings'))!
    )
  )
  const token = container.querySelector('textarea') as HTMLTextAreaElement
  expect(token).not.toBeNull()
  expect(token.value).toBe('')
  expect(token.placeholder).toContain('replacement')
  await harness.act(async () => fireEvent.change(token, { target: { value: 'new-test-json' } }))
  await harness.act(async () =>
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Save credentials'))!
    )
  )
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.url.endsWith('/providers/google-cloud/service-settings') &&
          (call.body as Record<string, string>)?.GOOGLE_SERVICE_ACCOUNT_JSON === 'new-test-json'
      )
    ).toBe(true)
  )
})

test('missing configuration is visible on collapsed cards and updates without opening settings', async () => {
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      {
        key: 'web-push',
        label: 'Web Push',
        enabled: true,
        description: 'Browser notifications',
        setup: { state: 'needs_setup', issues: ['Contact address is required.'] },
      },
    ],
  })
  const container = await render()
  expect(container.textContent).toContain('Setup required')
  expect(container.textContent).not.toContain('Contact address is required.')
  expect(container.querySelector('#integration-settings-web-push')).toBeNull()
  await harness.act(async () =>
    client.setQueryData(integrationQueryKeys.catalog(), {
      integrations: [
        {
          key: 'web-push',
          label: 'Web Push',
          enabled: true,
          description: 'Browser notifications',
          setup: { state: 'configured', issues: [] },
        },
      ],
    })
  )
  await harness.act(async () => {
    await waitFor(() => expect(container.textContent).not.toContain('Setup required'))
  })
  expect(container.textContent).not.toContain('Contact address is required.')
  expect(container.textContent).not.toContain('Configured')
  expect(container.querySelector('[aria-controls="integration-settings-web-push"]')).not.toBeNull()
})

test('disabled integrations hide setup warnings until enabled', async () => {
  const integration = {
    key: 'web-push',
    label: 'Web Push',
    enabled: false,
    description: 'Browser notifications',
    setup: { state: 'needs_setup', issues: ['Contact address is required.'] },
  }
  client.setQueryData(integrationQueryKeys.catalog(), { integrations: [integration] })
  const container = await render()
  expect(container.textContent).toContain('Disabled')
  expect(container.textContent).not.toContain('Setup required')
  expect(container.textContent).not.toContain('Contact address is required.')
  await harness.act(async () => {
    client.setQueryData(integrationQueryKeys.catalog(), { integrations: [{ ...integration, enabled: true }] })
    await waitFor(() => expect(container.textContent).toContain('Setup required'))
  })
  expect(container.textContent).toContain('Setup required')
  await harness.act(async () => {
    client.setQueryData(integrationQueryKeys.catalog(), {
      integrations: [{ ...integration, setup: { state: 'needs_attention', issues: ['Reconnect account.'] } }],
    })
    await waitFor(() => expect(container.textContent).toContain('Disabled'))
  })
  expect(container.textContent).not.toContain('Needs attention')
  expect(container.textContent).not.toContain('Reconnect account.')
})

test('GitHub callback destination expands its settings and focuses the card', async () => {
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: entries.map((entry) => ({ ...entry, enabled: true })),
  })
  const container = await render(true, 'integration-github')
  await harness.act(async () => {
    await waitFor(() => expect(container.querySelector('#integration-settings-github')).not.toBeNull())
  })
  const card = container.querySelector('#integration-card-github')!
  expect(card.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
  expect(scrolled).toEqual(['integration-card-github'])
  expect(document.activeElement).toBe(card)
  expect(container.querySelector('#integration-settings-notion')).toBeNull()
})

test('unsupported BigBrain stays Disabled even with an old enabled flag and visibly explains the disabled switch', async () => {
  const reason = 'Requires BigBrain on the same machine as local/self-hosted Ficus; unavailable on Ficus Cloud.'
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      ...entries.filter((entry) => entry.key !== 'bigbrain'),
      {
        key: 'bigbrain',
        label: 'BigBrain',
        enabled: true,
        description: 'Memory',
        availability: { available: false, reason },
      },
    ],
  })
  const container = await render()
  const card = container.querySelector('[aria-label="Disabled integrations"] #integration-card-bigbrain')
  expect(card).not.toBeNull()
  expect(card?.textContent).toContain(reason)
  const toggle = card!.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.disabled).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.getAttribute('aria-describedby')).toBe('integration-unavailable-bigbrain')
  expect(container.querySelector('[aria-label="Enable GitHub globally"]')?.hasAttribute('disabled')).toBe(false)
  expect(container.querySelector('[aria-label="Enabled integrations"]')?.textContent).toContain('Notion')
})

test('BigBrain product homepage is accessible on a disabled unsupported card without enabling it', async () => {
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      {
        key: 'bigbrain',
        label: 'BigBrain',
        enabled: false,
        availability: { available: false, reason: 'Unavailable on Ficus Cloud.' },
      },
    ],
  })
  const container = await render()
  const card = container.querySelector('[aria-label="Disabled integrations"] #integration-card-bigbrain')!
  const link = [...card.querySelectorAll('a')].find((a) => a.textContent?.startsWith('Learn more about BigBrain'))
  expect(link?.getAttribute('href')).toBe('https://bigbrain.cool')
  expect(link?.getAttribute('target')).toBe('_blank')
  expect(link?.getAttribute('rel')).toContain('noopener')
  expect(card.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
})

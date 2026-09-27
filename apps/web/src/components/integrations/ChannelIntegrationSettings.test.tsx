import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { integrationQueryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import type { ChannelIntegrationSettings as View } from '../../api/integrations'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const allowAll = () => ({ permissions: [], can: () => true, isLoading: false, isError: false }) as const

const slackFields = [
  { key: 'botToken', label: 'Bot token', secret: true, placeholder: 'xoxb-…', configured: false, required: true },
  {
    key: 'signingSecret',
    label: 'Signing secret',
    secret: true,
    placeholder: 'Slack app signing secret',
    configured: false,
    required: true,
  },
]

function slackView(overrides: Partial<View> = {}): View {
  return {
    fields: slackFields,
    identity: null,
    connection: null,
    enabled: true,
    setup: { state: 'needs_setup', issues: ['Bot token is required.'] },
    webhook: { url: 'http://localhost/api/webhooks/channels/slack', secretConfigured: false, delivery: 'direct' },
    routing: null,
    managedApp: { available: false, connection: null, active: false },
    ...overrides,
  }
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  fetchHandler = async () => new Response(null, { status: 204 })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init)) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

function renderCard(provider: 'slack' | 'discord' | 'telegram', view: View | undefined, canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (view) client.setQueryData(integrationQueryKeys.channelSettings(provider), view)
  client.setQueryData(queries.squads.list().queryKey, [])
  if (view?.routing) {
    client.setQueryData(queries.channelInstances.detail(view.routing.instanceId).queryKey, {
      id: view.routing.instanceId,
      name: view.routing.instanceId,
      provider,
      providerConfig: {},
      channelSquadMap: {},
      defaultSquadId: view.routing.defaultSquadId,
      disabled: false,
      yamlFieldOverrides: [],
      hasTemplate: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      allowPrivateChats: true,
      trustedChannelIds: [],
      allowedChannelIds: [],
      deniedChannelIds: [],
    })
  }
  return harness.act(async () => {
    const { ChannelIntegrationSettings } = await import('./ChannelIntegrationSettings')
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider usePermissions={allowAll}>
          <ChannelIntegrationSettings provider={provider} canWrite={canWrite} />
        </PermissionsProvider>
      </QueryClientProvider>
    )
  })
}

async function flushEffects() {
  await harness.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('self-hosted Slack looks and behaves exactly as before: manual form visible, no managed UI', async () => {
  await renderCard('slack', slackView({ managedApp: { available: false, connection: null, active: false } }))
  await flushEffects()

  expect(container.textContent).not.toContain('Tau Slack app')
  expect(container.textContent).not.toContain('Add to Slack')
  expect(container.textContent).not.toContain('Use your own Slack app')
  expect(container.querySelector('details')).toBeNull()
  expect(container.textContent).toContain('Bot token')
  expect(container.querySelector('input')).not.toBeNull()
  expect(container.textContent).toContain('Download the Slack app manifest')
})

test('hosted with no managed connection shows Add to Slack and starts managed authorization', async () => {
  let started: { url: string; body: unknown } | undefined
  fetchHandler = async (input, init) => {
    const url = String(input)
    if (url.includes('/providers/slack/authorization/start')) {
      started = { url, body: JSON.parse(String(init?.body)) }
      return Response.json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=abc' })
    }
    return new Response(null, { status: 204 })
  }
  await renderCard('slack', slackView({ managedApp: { available: true, connection: null, active: false } }))
  await flushEffects()

  expect(container.textContent).toContain('Tau Slack app')
  // Manual setup is now a secondary, collapsed disclosure.
  const details = container.querySelector('details')!
  expect(details).not.toBeNull()
  expect(details.querySelector('summary')?.textContent).toBe('Use your own Slack app')

  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Add to Slack'
  )!
  expect(button).not.toBeNull()

  const assign = spyOn(window.location, 'assign').mockImplementation(() => {})
  try {
    await harness.act(async () => {
      fireEvent.click(button)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(started?.url).toContain('/providers/slack/authorization/start')
    expect(started?.body).toEqual({ returnTo: '/settings' })
    expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?client_id=abc')
    expect(window.sessionStorage.getItem('ficusOAuthProviderHint')).toBe('slack')
  } finally {
    assign.mockRestore()
  }
})

test('hosted with an active managed connection shows workspace, hides the request URL, and offers Disconnect', async () => {
  await renderCard(
    'slack',
    slackView({
      managedApp: {
        available: true,
        active: true,
        connection: {
          id: 'managed-1',
          authState: 'authenticated',
          healthState: 'healthy',
          lastErrorCode: null,
          teamId: 'T0123',
          teamName: 'Acme Corp',
        },
      },
      webhook: { url: 'http://localhost/api/webhooks/channels/slack', secretConfigured: false, delivery: 'relay' },
      routing: { instanceId: 'instance-1', defaultSquadId: null },
    })
  )
  await flushEffects()

  expect(container.textContent).toContain('Acme Corp')
  expect(container.textContent).toContain('T0123')
  expect(container.textContent).toContain('healthy')
  expect(container.querySelector('code')).toBeNull()
  expect(container.textContent).toContain('Events arrive through Tau Cloud')
  expect(container.textContent).toContain("Your own app's credentials are kept but unused")
  expect(container.textContent).toContain('Turn off')
  expect(container.textContent).toContain('event subscriptions')
  expect(container.textContent).toContain('slash command')
  expect(container.textContent).toContain('rejected')
  // Default squad routing shows for the managed-only connection (no manual identity at all).
  expect(container.querySelector('#slack-default-squad')).not.toBeNull()

  const disconnect = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Disconnect'
  )!
  expect(disconnect).not.toBeNull()

  let deleted: string | undefined
  fetchHandler = async (input) => {
    const url = String(input)
    if (url.includes('/integrations/connections/managed-1')) {
      deleted = url
      return new Response(null, { status: 204 })
    }
    if (url.includes('/channel-settings'))
      return Response.json(slackView({ managedApp: { available: true, connection: null, active: false } }))
    if (url.includes('/channel-instances/'))
      return Response.json({
        id: 'instance-1',
        name: 'instance-1',
        provider: 'slack',
        providerConfig: {},
        channelSquadMap: {},
        defaultSquadId: null,
        disabled: false,
        yamlFieldOverrides: [],
        hasTemplate: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        allowPrivateChats: true,
        trustedChannelIds: [],
        allowedChannelIds: [],
        deniedChannelIds: [],
      })
    return new Response(null, { status: 204 })
  }
  await harness.act(async () => fireEvent.click(disconnect))
  expect(deleted).toBeUndefined()
  expect(disconnect.textContent).toBe('Confirm disconnect')
  await harness.act(async () => {
    fireEvent.click(disconnect)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(deleted).toContain('/integrations/connections/managed-1')
})

test('a freshly connected workspace offers the default squad picker before any routing entry exists', async () => {
  let saved: unknown
  fetchHandler = async (input, init) => {
    if (String(input).includes('/channel-settings') && init?.method === 'PUT') saved = JSON.parse(String(init.body))
    return Response.json(slackView())
  }
  await renderCard(
    'slack',
    slackView({
      setup: { state: 'configured', issues: [] },
      managedApp: {
        available: true,
        active: true,
        connection: {
          id: 'managed-1',
          authState: 'authenticated',
          healthState: 'healthy',
          lastErrorCode: null,
          teamId: 'T0123',
          teamName: 'Acme Corp',
        },
      },
      webhook: { url: 'http://localhost/api/webhooks/channels/slack', secretConfigured: false, delivery: 'relay' },
      routing: null,
      routable: true,
    })
  )
  await flushEffects()

  const select = container.querySelector<HTMLSelectElement>('#slack-default-squad')
  expect(select).not.toBeNull()
  await harness.act(async () => {
    fireEvent.change(select!, { target: { value: '' } })
  })
  await flushEffects()
  expect(saved).toEqual({ defaultSquadId: null })
})

test('reauthorization required shows Reconnect and starts authorization with the connection id', async () => {
  let started: { body: unknown } | undefined
  fetchHandler = async (input, init) => {
    const url = String(input)
    if (url.includes('/providers/slack/authorization/start')) {
      started = { body: JSON.parse(String(init?.body)) }
      return Response.json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=abc' })
    }
    return new Response(null, { status: 204 })
  }
  await renderCard(
    'slack',
    slackView({
      managedApp: {
        available: true,
        active: false,
        connection: {
          id: 'managed-1',
          authState: 'reauthorization_required',
          healthState: 'unknown',
          lastErrorCode: 'token_revoked',
          teamId: 'T0123',
          teamName: 'Acme Corp',
        },
      },
    })
  )
  await flushEffects()

  expect(container.textContent).toContain('Reconnect required')
  const reconnect = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Reconnect'
  )!
  expect(reconnect).not.toBeNull()
  await harness.act(async () => {
    fireEvent.click(reconnect)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(started?.body).toEqual({ returnTo: '/settings', connectionId: 'managed-1' })
})

test('Telegram is unaffected: no managed UI, no disclosure wrapper', async () => {
  await renderCard('telegram', {
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: '123:ABC', configured: true, required: true },
    ],
    identity: { botId: '123456' },
    connection: {
      id: 'legacy:telegram',
      source: 'legacy',
      authState: 'legacy',
      healthState: 'legacy',
      lastErrorCode: null,
    },
    enabled: true,
    setup: { state: 'configured', issues: [] },
    webhook: { url: 'http://localhost/api/webhooks/channels/telegram', secretConfigured: true, delivery: 'direct' },
    routing: { instanceId: 'instance-2', defaultSquadId: null },
  })
  await flushEffects()

  expect(container.textContent).not.toContain('Tau Slack app')
  expect(container.textContent).not.toContain('Add to Slack')
  expect(container.querySelector('details')).toBeNull()
})

test('Discord is unaffected: no managed UI, no disclosure wrapper', async () => {
  await renderCard('discord', {
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: 'token', configured: true, required: true },
    ],
    identity: { applicationId: 'app-1', guildId: 'guild-1' },
    connection: {
      id: 'legacy:discord',
      source: 'legacy',
      authState: 'legacy',
      healthState: 'legacy',
      lastErrorCode: null,
    },
    enabled: true,
    setup: { state: 'configured', issues: [] },
    webhook: { url: 'http://localhost/api/webhooks/channels/discord', secretConfigured: true, delivery: 'direct' },
    routing: { instanceId: 'instance-3', defaultSquadId: null },
    guilds: [{ id: 'guild-1', name: 'My Server' }],
  })
  await flushEffects()

  expect(container.textContent).not.toContain('Tau Slack app')
  expect(container.querySelector('details')).toBeNull()
})

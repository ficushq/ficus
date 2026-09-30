import { expect, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { queries, integrationQueries } from '../queryOptions'
import { PermissionsProvider } from '../hooks/usePermissions'
import { LegacyChatDrawer as ChatDrawer } from './ChatDrawer'

function LocationProbe() {
  const location = useLocation()
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  )
}

test('opening a search result navigates and closes the assistant in one URL update', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings?chat=open' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queries.voice.status().queryKey, { enabled: false })
  client.setQueryData(queries.agents.list({ agentTypeId: 'system-manager', scopeType: 'system-manager' }).queryKey, [])
  client.setQueryData(queries.squads.list().queryKey, [{ id: 'squad-id', name: 'Example', purpose: 'Demo' }])
  client.setQueryData(queries.squads.activeWorkStreams().queryKey, [
    { id: 'work-id', squadId: 'squad-id', title: 'Fix OAuth', status: 'active' },
  ])
  client.setQueryData(integrationQueries.catalog().queryKey, { integrations: [] })
  const { container, root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: [], can: () => false, isLoading: false, isError: false })}
          >
            <MemoryRouter initialEntries={['/settings?chat=open']}>
              <LocationProbe />
              <ChatDrawer />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    const voiceTab = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="Assistant modes"] [role="radio"]'
      ),
    ].find((tab) => tab.textContent === 'Voice')!
    expect(voiceTab.disabled).toBe(true)
    expect(voiceTab.title).toContain('permission')
    await dom.act(async () => {
      const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'OAuth')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const result = container.querySelector<HTMLButtonElement>('[role="option"]')!
    expect(result.textContent).toContain('Fix OAuth')
    await dom.act(async () => result.click())
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/squads/squad-id/work?ws=work-id')
    expect(container.querySelector<HTMLElement>('[role="dialog"]')?.style.display).toBe('none')
  } finally {
    await dom.cleanup()
    client.clear()
  }
})

test('assistant history, starter messages, and live voice use the shared panel', async () => {
  const dom = await acquireDomHarness({ url: 'https://localhost/?chat=open' })
  Object.defineProperty(dom.window, 'isSecureContext', { configurable: true, value: true })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const agents = Array.from({ length: 6 }, (_, index) => ({
    id: `chat-${index}`,
    status: 'idle',
    metadata: { purpose: `Conversation ${index}` },
    updatedAt: `2026-09-0${6 - index}T00:00:00Z`,
  }))
  client.setQueryData(queries.voice.status().queryKey, { enabled: true })
  client.setQueryData(
    queries.agents.list({ agentTypeId: 'system-manager', scopeType: 'system-manager' }).queryKey,
    agents
  )
  client.setQueryData(queries.squads.list().queryKey, [])
  client.setQueryData(queries.squads.activeWorkStreams().queryKey, [])
  const { container, root } = dom.createRoot()
  const ChatFixture = ({ initialMessage }: { initialMessage?: { content: string } }) => (
    <output data-testid="initial-message">{initialMessage?.content}</output>
  )
  const VoiceFixture = ({
    onActivityChange,
    onConnected,
    compactOverride,
  }: {
    onActivityChange?: (active: boolean) => void
    onConnected?: () => void
    compactOverride?: boolean
  }) => (
    <button
      data-testid="voice-fixture"
      data-compact={compactOverride}
      onClick={() => {
        onActivityChange?.(true)
        onConnected?.()
      }}
    >
      Connect fixture
    </button>
  )
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!
    expect(button).toBeDefined()
    await dom.act(async () => button.click())
  }
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({
              permissions: ['chat:send', 'ai:voice'],
              can: (permission: string) => ['chat:send', 'ai:voice'].includes(permission),
              isLoading: false,
              isError: false,
            })}
          >
            <MemoryRouter initialEntries={['/?chat=open']}>
              <ChatDrawer dependencies={{ ChatComponent: ChatFixture, VoiceComponent: VoiceFixture }} />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    expect(container.querySelectorAll('[aria-label="Recent assistant chats"] a')).toHaveLength(5)
    await click('View all')
    expect(dom.window.document.activeElement?.getAttribute('aria-label')).toBe('Search assistant conversations')
    expect(container.querySelectorAll('#assistant-conversations a')).toHaveLength(6)
    await click('← Back to search')
    await click('What needs my attention?')
    expect(container.querySelector('[data-testid="initial-message"]')?.textContent).toBe('What needs my attention?')
    await click('← Back to search')
    await dom.act(async () => {
      const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Summarize today'
      )
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('Ask Ficus')
    expect(container.querySelector('[data-testid="initial-message"]')?.textContent).toBe('Summarize today')
    await click('Voice')
    const panel = container.querySelector('[role="dialog"]')!
    await click('Connect fixture')
    expect(container.querySelector('[data-testid="voice-fixture"]')?.getAttribute('data-compact')).toBe('true')
    expect(panel.className).toContain('w-64')
    expect(container.querySelector('[role="radiogroup"][aria-label="Assistant modes"]')).toBeNull()
    await dom.act(async () => container.querySelector<HTMLButtonElement>('[title="Expand assistant"]')!.click())
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    expect(container.querySelector('[data-testid="voice-fixture"]')?.getAttribute('data-compact')).toBe('false')
    expect(container.querySelector('[role="radiogroup"][aria-label="Assistant modes"]')).not.toBeNull()
    expect(container.querySelector('[title="Collapse assistant"]')).not.toBeNull()
    expect(container.querySelector('[title="Close (Esc)"]')).toBeNull()
  } finally {
    await dom.cleanup()
    client.clear()
  }
})

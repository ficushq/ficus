import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { useState } from 'react'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { RenderItem } from '@ficus/client-react'
import type { Message, MessageSearchResponse, MessageSearchResult } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { client } from '../api/clientInstance'

const usePermissionsMock = () => ({ can: () => true, isLoading: false, isError: false, permissions: ['agents:write'] })
const dependencies = {
  useImageSrcsHook: () => ({}),
  usePermissionsHook: usePermissionsMock,
  useVoiceEnabledHook: () => false,
  useVoiceRecorderHook: () => ({
    state: 'idle' as const,
    elapsed: 0,
    volume: 0,
    isSupported: false,
    isHoldMode: false,
    start: () => {},
    stop: () => {},
    stopAndSend: () => {},
    cancel: () => {},
    beginPress: () => {},
    endPress: () => {},
    cancelPress: () => {},
    isPressing: false,
  }),
  uploadImages: mock(async () => [] as string[]),
}

const { ChatView } = await import('./ChatView')

const message = (id: string, content: string): Message => ({
  id,
  agentId: 'agent-1',
  role: 'human',
  content,
  metadata: null,
  pending: false,
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
})
const item = (m: Message): RenderItem => ({ kind: 'persisted', id: m.id, message: m, mergedFrom: [m], blocks: [] })

function result(id: string, newerCount: number): MessageSearchResult {
  return {
    id,
    createdAt: '2026-11-01T10:00:00.000Z',
    role: 'human',
    sender: { userId: 'u1', name: 'Noah' },
    source: null,
    isSystem: false,
    snippet: { text: 'Check the deploy pipeline', truncatedStart: false, truncatedEnd: false, highlights: [[10, 16]] },
    newerCount,
  }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

/**
 * A chat whose loaded window holds only the newest message. Each older page it is asked for
 * prepends filler, and the target lands once enough older messages have been requested.
 */
function Harness({ targetDepth, hideComposer }: { targetDepth: number; hideComposer: boolean }) {
  const [items, setItems] = useState<RenderItem[]>([item(message('newest', 'Newest message'))])
  const [hasOlder, setHasOlder] = useState(true)
  const [requested, setRequested] = useState(1)
  return (
    <ChatView
      agentId="agent-1"
      enableHistorySearch
      items={items}
      dependencies={dependencies}
      onSend={() => undefined}
      hideComposer={hideComposer}
      hasOlderMessages={hasOlder}
      onLoadOlder={(options) => {
        loadOlderCalls.push(options)
        const size = Math.min(options?.minimumMessages ?? 50, 500)
        const total = requested + size
        setRequested(total)
        const page = [item(message(`filler-${total}`, 'Filler'))]
        if (total > targetDepth) {
          page.unshift(item(message('target', 'Check the deploy pipeline')))
          setHasOlder(false)
        }
        setItems((prev) => [...page, ...prev])
        return Promise.resolve()
      }}
    />
  )
}
let loadOlderCalls: Array<{ minimumMessages?: number } | undefined> = []

async function render(
  targetDepth: number,
  response: MessageSearchResponse,
  { hideComposer = true }: { hideComposer?: boolean } = {}
) {
  loadOlderCalls = []
  const scrollIntoView = mock(() => undefined)
  const dom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView as unknown as () => void
    },
  })
  const search = spyOn(client.agents, 'searchMessages').mockResolvedValue(response)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { root } = dom.createRoot()
  cleanup = async () => {
    search.mockRestore()
    queryClient.clear()
    await dom.cleanup()
  }
  await dom.act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <Harness targetDepth={targetDepth} hideComposer={hideComposer} />
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  })
  const document = dom.window.document
  const wait = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 5000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    }
  }
  const openAndSearch = async (text: string) => {
    await dom.act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Search this conversation"]')!.click()
    })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search this conversation"]')!
    expect(document.activeElement).toBe(input)
    await dom.act(async () => {
      fireEvent.input(input, { target: { value: text } })
    })
    await wait(() => document.querySelectorAll('[role="option"]').length > 0, 'results')
    return input
  }
  return { dom, document, search, scrollIntoView, wait, openAndSearch }
}

describe('ChatView history search', () => {
  test('searches the server and jumps to a result far beyond the loaded window', async () => {
    const { dom, document, search, scrollIntoView, wait, openAndSearch } = await render(1200, {
      results: [result('target', 1200)],
      nextCursor: null,
    })
    const input = await openAndSearch('  deploy ')

    expect(search).toHaveBeenCalledWith('agent-1', { q: 'deploy', limit: 20, cursor: undefined }, expect.anything())
    const option = document.querySelector('[role="option"]')!
    expect(option.textContent).toContain('Noah')
    expect(option.querySelector('mark')?.textContent).toBe('deploy')
    expect(document.querySelector('[data-message-id~="target"]')).toBeNull()

    await dom.act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await wait(() => !!document.querySelector('[data-message-id~="target"]'), 'target to load')
    await wait(() => scrollIntoView.mock.calls.length > 0, 'scroll to target')

    // Larger pages sized from the result's position: three requests reach 1200 messages back, not 24.
    expect(loadOlderCalls.length).toBe(3)
    expect(loadOlderCalls[0]?.minimumMessages).toBe(1200 + 1 - 1 + 10)
    expect(document.querySelector('[data-message-id~="target"]')?.className).toContain('ring-2')
    // The panel stays open so the person can pick another result.
    expect(document.querySelector('[data-testid="chat-history-search"]')).not.toBeNull()
  })

  test('says a result is too far back instead of loading thousands of messages', async () => {
    const { dom, document, wait, openAndSearch } = await render(10, {
      results: [result('ancient', 6000)],
      nextCursor: null,
    })
    await openAndSearch('deploy')
    await dom.act(async () => {
      document.querySelector<HTMLElement>('[role="option"]')!.click()
    })
    await wait(() => document.body.textContent!.includes('too far back'), 'too-far notice')
    expect(loadOlderCalls).toEqual([])
  })

  test('opens with Cmd/Ctrl+Shift+F, leaves Cmd/Ctrl+F to the browser, and closes with Escape', async () => {
    const { dom, document } = await render(10, { results: [], nextCursor: null })
    const panel = () => document.querySelector('[data-testid="chat-history-search"]')

    const plainFind = new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
    await dom.act(async () => {
      dom.window.dispatchEvent(plainFind)
    })
    expect(panel()).toBeNull()
    expect(plainFind.defaultPrevented).toBe(false)

    const shortcut = new dom.window.KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    })
    await dom.act(async () => {
      dom.window.dispatchEvent(shortcut)
    })
    expect(panel()).not.toBeNull()
    expect(shortcut.defaultPrevented).toBe(true)

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search this conversation"]')!
    await dom.act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(panel()).toBeNull()
  })

  test('keeps the button in the header only when there is no composer', async () => {
    const { document } = await render(10, { results: [], nextCursor: null })
    const button = document.querySelector('button[aria-label="Search this conversation"]')!
    expect(button.closest('[data-testid="chat-header"]')).not.toBeNull()
  })

  test('puts the button with the composer controls instead of a header row of its own', async () => {
    const { dom, document } = await render(10, { results: [], nextCursor: null }, { hideComposer: false })
    const panel = () => document.querySelector('[data-testid="chat-history-search"]')
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[aria-label="Search this conversation"]')
    expect(buttons.length).toBe(1)
    const button = buttons[0]!

    // Search was the header's only item, so no header row renders at all.
    expect(document.querySelector('[data-testid="chat-header"]')).toBeNull()
    expect(button.closest('.chat-composer-controls')).not.toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.title).toContain('+Shift+F')

    await dom.act(async () => {
      button.click()
    })
    expect(panel()).not.toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('bg-accent/10')

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search this conversation"]')!
    await dom.act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(panel()).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  test('offers search in the phone options sheet', async () => {
    const { dom, document } = await render(10, { results: [], nextCursor: null }, { hideComposer: false })
    const panel = () => document.querySelector('[data-testid="chat-history-search"]')
    const sheet = () => document.querySelector('[role="dialog"][aria-label="Attach or change controls"]')
    const sheetSearch = () =>
      Array.from(sheet()?.querySelectorAll('button') ?? []).find((b) =>
        /^(Search this conversation|Close search)$/.test(b.textContent ?? '')
      )

    await dom.act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Attach or change controls"]')!.click()
    })
    expect(sheetSearch()?.textContent).toBe('Search this conversation')
    await dom.act(async () => {
      sheetSearch()!.click()
    })
    expect(panel()).not.toBeNull()
    // The sheet closed and the panel's input kept focus.
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Search this conversation"]'))

    await dom.act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Attach or change controls"]')!.click()
    })
    expect(sheetSearch()?.textContent).toBe('Close search')
    expect(sheetSearch()!.className).toContain('bg-accent/10')
    await dom.act(async () => {
      sheetSearch()!.click()
    })
    expect(panel()).toBeNull()
  })
})

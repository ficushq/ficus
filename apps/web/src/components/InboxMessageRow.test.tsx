import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { Squad } from '@ficus/shared'
import type { InboxMessageResponse } from '../api/inbox'
import { formatSender, MessageRow } from './InboxMessageRow'

// MessageRow uses react-query hooks; every render needs a QueryClient in context.
function renderRow(ui: ReactElement): string {
  const qc = new QueryClient()
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('MessageRow', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  const activeQueryClients = new Set<QueryClient>()

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await Promise.all([...activeQueryClients].map((client) => client.cancelQueries()))
    for (const client of activeQueryClients) client.clear()
    activeQueryClients.clear()
    await dom.cleanup()
  })

  function trackQueryClient(client: QueryClient): QueryClient {
    activeQueryClients.add(client)
    return client
  }

  test('renders mobile meta row with time and Mark read', () => {
    const message = {
      id: 'm1',
      senderType: 'agent',
      senderId: 'abcdefgh',
      subject: 'Hello',
      content: 'world',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      readAt: null,
      senderAgent: { id: 'a1', squadId: null, name: 'A', agentTypeId: 'engineer', ownerUserId: null },
      metadata: {},
    } as unknown as InboxMessageResponse

    const html = renderRow(<MessageRow message={message} onMarkAsRead={() => {}} />)

    expect(html).toContain('data-testid="inbox-row-meta-mobile"')
    expect(html).toContain('md:hidden')
    expect(html).toContain('1m ago')
    // The unread gutter dot uses the theme's notification badge color.
    expect(html).toContain('rounded-full bg-badge')
    expect(html).toContain('Mark read')
    expect(html).toContain('hidden md:flex')
  })

  test('keeps compact rows on the single-line controls layout', () => {
    const message = {
      id: 'm1',
      senderType: 'agent',
      senderId: 'abcdefgh',
      content: 'world',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      readAt: null,
      senderAgent: { id: 'a1', squadId: null, name: 'A', agentTypeId: 'engineer', ownerUserId: null },
      metadata: {},
    } as unknown as InboxMessageResponse

    const html = renderRow(<MessageRow message={message} onMarkAsRead={() => {}} compact />)

    expect(html).not.toContain('data-testid="inbox-row-meta-mobile"')
    expect(html).toContain('Read')
    expect(html).not.toContain('Mark read')
  })

  test('does not create a broken chat link for a system sender', () => {
    const html = renderRow(
      <MessageRow message={makeMessage({ senderType: 'system', senderId: 'system', senderAgent: undefined })} />
    )
    expect(html).not.toContain('/chat/undefined')
    expect(html).toContain('system')
  })

  test('shows work stream link in expanded detail when metadata is present', async () => {
    await renderInteractiveRow({
      metadata: { workStreamId: 'ws-9', squadId: 'sq-2', event: 'review' },
    })

    await expandRow()

    expect(container.innerHTML).toContain('href="/squads/sq-2/work?ws=ws-9"')
    expect(container.textContent).toContain('View work stream')
  })

  test('Mark read is a ghost row control, and the row keeps its resting tint while it is hovered', async () => {
    await renderInteractiveRow()

    const markRead = findButtons(container).filter((button) => button.textContent === 'Mark read')
    // One in the mobile meta line, one in the desktop controls column.
    expect(markRead).toHaveLength(2)
    for (const button of markRead) {
      expect(button.classList.contains('ficus-button-ghost')).toBe(true)
      expect(button.classList.contains('ficus-button-link')).toBe(false)
      expect(button.hasAttribute('data-mark-read')).toBe(true)
    }
    const row = container.firstElementChild!
    expect(row.classList.contains('bg-accent/5')).toBe(true)
    expect(row.classList.contains('has-[[data-mark-read]:hover]:bg-accent/5')).toBe(true)
  })

  test('omits work stream link from collapsed row preview when metadata is present', async () => {
    await renderInteractiveRow({
      metadata: { workStreamId: 'ws-9', squadId: 'sq-2', event: 'review' },
    })

    expect(container.innerHTML).not.toContain('/squads/sq-2/work')
    expect(container.textContent).not.toContain('View work stream')
  })

  test('omits work stream link from expanded detail when metadata is unrelated', async () => {
    await renderInteractiveRow({ metadata: { foo: 'bar' } })

    await expandRow()

    expect(container.innerHTML).not.toContain('/work?ws=')
    expect(container.textContent).not.toContain('View work stream')
  })

  async function renderInteractiveRow(overrides: Partial<InboxMessageResponse> = {}) {
    const message = makeMessage(overrides)
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={trackQueryClient(new QueryClient())}>
          <MemoryRouter>
            <MessageRow message={message} onMarkAsRead={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
  }

  async function expandRow() {
    const expandButton = findButtons(container).find((button) => button.getAttribute('aria-label') === 'Expand')
    if (!expandButton) throw new Error('Missing expand button')

    await dom.act(async () => {
      expandButton.click()
    })
  }

  function findButtons(element: Element): HTMLButtonElement[] {
    const buttons: HTMLButtonElement[] = []
    for (const child of Array.from(element.children)) {
      if (child.tagName.toLowerCase() === 'button') buttons.push(child as HTMLButtonElement)
      buttons.push(...findButtons(child))
    }
    return buttons
  }
})

function makeMessage(overrides: Partial<InboxMessageResponse> = {}): InboxMessageResponse {
  return {
    id: 'm1',
    senderType: 'agent',
    senderId: 'abcdefgh',
    subject: 'Hello',
    content: 'world',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    readAt: null,
    senderAgent: { id: 'a1', squadId: null, name: 'A', agentTypeId: 'engineer', ownerUserId: null },
    metadata: {},
    ...overrides,
  } as unknown as InboxMessageResponse
}

describe('MessageRow attachment download links', () => {
  test('renders a download link per attachment unconditionally (without expanding)', () => {
    const message = {
      id: 'm1',
      senderType: 'system',
      senderId: null,
      subject: 'Test',
      content: 'hello',
      createdAt: new Date().toISOString(),
      readAt: null,
      metadata: {},
      attachments: [
        {
          id: 'a1',
          messageId: 'm1',
          filename: 'note.txt',
          contentType: 'text/plain',
          byteSize: 5,
          sha256: 'x',
          createdAt: new Date().toISOString(),
        },
      ],
    } as unknown as InboxMessageResponse

    const html = renderRow(<MessageRow message={message} />)

    expect(html).toContain('note.txt')
    expect(html).toContain('/api/inbox/attachments/a1')
  })

  test('renders no attachment links when attachments is absent', () => {
    const message = makeMessage()
    const html = renderRow(<MessageRow message={message} />)
    expect(html).not.toContain('/api/inbox/attachments/')
  })
})

describe('formatSender', () => {
  test('uses the flat participant name and keeps sender identity and squad chat link', () => {
    const message = makeMessage({
      senderId: 'agent-123456789',
      senderAgent: {
        id: 'agent-123456789',
        name: 'Summary Name',
        agentTypeId: 'engineer',
        squadId: 'squad-1',
        ownerUserId: null,
      },
    })
    expect(formatSender(message)).toBe('Summary Name [agent-12]')
    const html = renderRow(<MessageRow message={message} />)
    expect(html).toContain('Summary Name')
    expect(html).toContain('/chat/agent-123456789')
    const squadHtml = renderRow(<MessageRow message={message} squads={[{ id: 'squad-1', name: 'Squad' } as Squad]} />)
    expect(squadHtml).toContain('/squads/squad-1?agent=agent-123456789')
  })

  test('formats workspace voice assistant sender with name, type, and stable ID', () => {
    const message = {
      senderType: 'voice_assistant',
      senderId: 'workspace:voiceuser',
      metadata: {},
      senderAgent: null,
    } as InboxMessageResponse

    expect(formatSender(message)).toBe('Voice Workspace Agent (voice_assistant) [workspace:voiceuser]')
  })
})

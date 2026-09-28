import { expect, mock, test } from 'bun:test'
import type { AssistantActivityUpdate } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { shouldAcknowledgeAssistantUpdate, summarizeAssistantTasks } from '../lib/assistantActivityPresentation'
import { AssistantUpdateList, type AssistantUpdateObserverFactory } from './AssistantUpdateList'

test('acknowledgment requires a visible surface, a visible document, an intersecting card, and unseen state', () => {
  const cases: Array<[boolean, boolean, boolean, boolean, boolean]> = [
    [true, true, true, false, true],
    [false, true, true, false, false],
    [true, false, true, false, false],
    [true, true, false, false, false],
    [true, true, true, true, false],
    [false, false, false, true, false],
  ]
  for (const [surfaceVisible, documentVisible, intersects, alreadySeen, expected] of cases)
    expect(shouldAcknowledgeAssistantUpdate({ surfaceVisible, documentVisible, intersects, alreadySeen })).toBe(
      expected
    )
})

test('task summaries name what needs attention first', () => {
  expect(summarizeAssistantTasks({ workingTasks: 2, waitingTasks: 1, needsInputTasks: 1, unavailableTasks: 0 })).toBe(
    '1 task needs your input · 2 working · 1 waiting'
  )
  expect(summarizeAssistantTasks({ workingTasks: 0, waitingTasks: 0, needsInputTasks: 0, unavailableTasks: 0 })).toBe(
    ''
  )
})

const update = (index: number, seen = false): AssistantActivityUpdate => ({
  messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  taskId: '10000000-0000-4000-8000-000000000001',
  requestId: null,
  sequence: index,
  reportedStatus: index === 2 ? 'needs-input' : null,
  content: `Update ${index}`,
  subject: null,
  senderName: 'Assistant task',
  processedAt: null,
  seenAt: seen ? '2026-09-15T00:00:00.000Z' : null,
  createdAt: '2026-09-15T00:00:00.000Z',
})
const task = {
  id: '10000000-0000-4000-8000-000000000001',
  currentRequestId: '20000000-0000-4000-8000-000000000001',
  agentId: null,
  kind: 'background' as const,
  squadId: null,
  label: 'Compare options',
  status: 'needs-input' as const,
  unavailable: false,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
}

async function fixture(visible: boolean, initial: Partial<Parameters<typeof AssistantUpdateList>[0]> = {}) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let emit: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | undefined
  const observed: Element[] = []
  const disconnect = mock(() => {})
  const createObserver: AssistantUpdateObserverFactory = (onChange) => {
    emit = onChange
    return { observe: (element) => observed.push(element), unobserve: () => {}, disconnect }
  }
  let documentVisible = true
  const onSeen = mock(async (_ids: string[]) => {})
  const onSeenThrough = mock(async (_sequence: number) => {})
  const onExpandedChange = mock((_expanded: boolean) => {})
  const { root, container } = dom.createRoot()
  const render = (props: Partial<Parameters<typeof AssistantUpdateList>[0]> = {}) =>
    root.render(
      <AssistantUpdateList
        updates={[update(1), update(2), update(3, true)]}
        tasks={[task]}
        visible={visible}
        latestSequence={3}
        hasMore={false}
        onSeen={onSeen}
        onSeenThrough={onSeenThrough}
        onExpandedChange={onExpandedChange}
        dependencies={{ createObserver, documentVisible: () => documentVisible }}
        {...props}
      />
    )
  await dom.act(async () => render(initial))
  return {
    dom,
    container,
    render,
    onSeen,
    onSeenThrough,
    onExpandedChange,
    observed,
    disconnect,
    intersect: (ids: string[], isIntersecting = true) =>
      dom.act(async () => {
        emit!(ids.map((id) => ({ target: container.querySelector(`[data-update-id="${id}"]`)!, isIntersecting })))
      }),
    setDocumentVisible: (value: boolean) => {
      documentVisible = value
    },
  }
}

test('renders unread updates newest first with their task label and status, and only visible intersecting cards are acknowledged', async () => {
  const f = await fixture(true)
  try {
    // Read cards stay behind the toggle; unread ones list newest first.
    expect(
      [...f.container.querySelectorAll<HTMLElement>('[data-update-id]')].map((card) => card.dataset.updateId)
    ).toEqual([update(2).messageId, update(1).messageId])
    expect(f.observed).toHaveLength(2)
    const showRead = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.startsWith('Show read')
    )!
    expect(showRead.textContent).toBe('Show read (1)')
    await f.dom.act(async () => showRead.click())
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(3)
    expect(showRead.textContent).toBe('Hide read')
    expect(f.container.textContent).toContain('Compare options')
    expect(f.container.textContent).toContain('Needs your input')
    expect(f.container.textContent).toContain('2 unread')
    // Rendering alone acknowledges nothing.
    expect(f.onSeen).not.toHaveBeenCalled()
    await f.intersect([update(1).messageId])
    expect(f.onSeen).toHaveBeenCalledTimes(1)
    expect(f.onSeen).toHaveBeenCalledWith([update(1).messageId])
    // An already-seen card never round-trips again; a hidden document defers.
    await f.intersect([update(3).messageId])
    expect(f.onSeen).toHaveBeenCalledTimes(1)
    f.setDocumentVisible(false)
    await f.intersect([update(2).messageId])
    expect(f.onSeen).toHaveBeenCalledTimes(1)
    f.setDocumentVisible(true)
    await f.dom.act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(f.onSeen).toHaveBeenCalledTimes(2)
    // The first card was already acknowledged in this session and is not re-sent.
    expect(f.onSeen).toHaveBeenLastCalledWith([update(2).messageId])
  } finally {
    await f.dom.cleanup()
  }
})

test('a hidden mounted list never acknowledges, and Mark updates read uses the displayed snapshot', async () => {
  const f = await fixture(false)
  try {
    await f.intersect([update(1).messageId, update(2).messageId])
    expect(f.onSeen).not.toHaveBeenCalled()
    // The explicit action still works and sends the sequence the list was rendered with, even if a
    // newer update has since been fetched into the caller's cache.
    await f.dom.act(async () =>
      f.render({ latestSequence: 3, updates: [update(1), update(2), update(3, true), update(4)] })
    )
    const button = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === 'Mark updates read'
    )!
    expect(button).toBeTruthy()
    await f.dom.act(async () => button.click())
    expect(f.onSeenThrough).toHaveBeenCalledWith(3)
  } finally {
    await f.dom.cleanup()
  }
})

test('a failed acknowledgment keeps unread markers and surfaces a status', async () => {
  const f = await fixture(true)
  try {
    f.onSeen.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    await f.intersect([update(1).messageId])
    expect(f.container.querySelectorAll('[data-unread="true"]')).toHaveLength(2)
    expect(f.container.textContent).toContain('Read state could not be saved')
  } finally {
    await f.dom.cleanup()
    expect(f.disconnect).toHaveBeenCalled()
  }
})

test('the section opens for unread updates, stays open with viewed cards after they are read, and toggles by hand', async () => {
  const f = await fixture(true)
  try {
    const region = () => f.container.querySelector<HTMLElement>('#assistant-task-updates')!
    const toggle = () => f.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    // Two unread cards: open by default and observed; the host is told so it can yield the chat area.
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(f.onExpandedChange).toHaveBeenLastCalledWith(true)
    expect(region().hidden).toBe(false)
    expect(toggle().textContent).toContain('2 unread')
    // Reading them (here or elsewhere) keeps the section open and the cards in view, now read, so
    // nothing vanishes while you are looking at it.
    await f.dom.act(async () => f.render({ updates: [update(1, true), update(2, true), update(3, true)] }))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(f.onExpandedChange).toHaveBeenLastCalledWith(true)
    expect(region().hidden).toBe(false)
    expect(
      [...f.container.querySelectorAll<HTMLElement>('[data-update-id]')].map((card) => card.dataset.updateId)
    ).toEqual([update(2).messageId, update(1).messageId])
    expect(f.container.querySelectorAll('[data-unread]')).toHaveLength(0)
    // The header always counts unread, including zero.
    expect(toggle().textContent).toContain('0 unread')
    // Closing is the user's call; it stays closed and drops the retained cards.
    await f.dom.act(async () => toggle().click())
    expect(region().hidden).toBe(true)
    expect(f.onExpandedChange).toHaveBeenLastCalledWith(false)
    // Manual toggle opens the section without acknowledging anything; read history is a toggle away.
    await f.dom.act(async () => toggle().click())
    expect(region().hidden).toBe(false)
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(0)
    expect(f.container.textContent).toContain('All caught up.')
    const showRead = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.startsWith('Show read')
    )!
    await f.dom.act(async () => showRead.click())
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(3)
    expect(f.onSeen).not.toHaveBeenCalled()
    await f.dom.act(async () => toggle().click())
    expect(region().hidden).toBe(true)
    // A new unread update reopens a section the user closed.
    await f.dom.act(async () => f.render({ updates: [update(1, true), update(2, true), update(3, true), update(4)] }))
    expect(region().hidden).toBe(false)
    expect(toggle().textContent).toContain('1 unread')
    // Open, the section grows to fill the chat area on phones and stays bounded on wider screens.
    const section = f.container.querySelector<HTMLElement>('section[aria-label="Task updates"]')!
    expect(section.className).toContain('flex-1 md:flex-none')
    expect(region().className).toContain('flex-1 md:max-h-80 md:flex-none')
    await f.dom.act(async () => toggle().click())
    expect(section.className).not.toContain('flex-1')
  } finally {
    await f.dom.cleanup()
  }
})

test('a history that is already read starts collapsed, and a viewed card stays after it is acknowledged', async () => {
  const f = await fixture(true, { updates: [update(1, true), update(2, true)], latestSequence: 2 })
  try {
    const toggle = () => f.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    // A new update arrives and opens the section; seeing it on screen acknowledges it.
    await f.dom.act(async () => f.render({ updates: [update(1, true), update(2, true), update(3)], latestSequence: 3 }))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await f.intersect([update(3).messageId])
    expect(f.onSeen).toHaveBeenCalledWith([update(3).messageId])
    // The refetch reports it seen: the card is still there and the section still open.
    await f.dom.act(async () =>
      f.render({ updates: [update(1, true), update(2, true), update(3, true)], latestSequence: 3 })
    )
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(f.container.querySelector(`[data-update-id="${update(3).messageId}"]`)).not.toBeNull()
    expect(f.container.querySelector(`[data-update-id="${update(3).messageId}"]`)?.hasAttribute('data-unread')).toBe(
      false
    )
    // Only the older read history sits behind the toggle.
    expect(f.container.textContent).toContain('Show read (2)')
  } finally {
    await f.dom.cleanup()
  }
})

test('Mark updates read clears the cards but keeps the section open', async () => {
  const f = await fixture(true)
  try {
    const markAll = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Mark updates read'
    )!
    await f.dom.act(async () => markAll.click())
    expect(f.onSeenThrough).toHaveBeenCalledWith(3)
    await f.dom.act(async () => f.render({ updates: [update(1, true), update(2, true), update(3, true)] }))
    const toggle = f.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(0)
    expect(f.container.textContent).toContain('All caught up.')
  } finally {
    await f.dom.cleanup()
  }
})

test('Hide marks one card read and keeps it out of view until the section is toggled', async () => {
  const f = await fixture(true)
  try {
    const hideButtons = () => [...f.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Hide update"]')]
    const hideFor = (id: string) =>
      f.container.querySelector<HTMLButtonElement>(`[data-update-id="${id}"] button[aria-label="Hide update"]`)!
    expect(hideButtons()).toHaveLength(2)
    await f.dom.act(async () => hideFor(update(1).messageId).click())
    expect(f.onSeen).toHaveBeenCalledWith([update(1).messageId])
    expect(f.container.querySelector(`[data-update-id="${update(1).messageId}"]`)).toBeNull()
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(1)
    // A failed acknowledgment puts the card back.
    f.onSeen.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    await f.dom.act(async () => hideFor(update(2).messageId).click())
    expect(f.container.querySelector(`[data-update-id="${update(2).messageId}"]`)).not.toBeNull()
    expect(f.container.textContent).toContain('Read state could not be saved')
    // Toggling the section brings hidden unread cards back (the fixture never re-renders seen state).
    const toggle = f.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    await f.dom.act(async () => toggle.click())
    await f.dom.act(async () => toggle.click())
    expect(f.container.querySelectorAll('[data-update-id]')).toHaveLength(2)
  } finally {
    await f.dom.cleanup()
  }
})

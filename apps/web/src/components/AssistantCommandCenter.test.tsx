import { expect, mock, test } from 'bun:test'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { queries, integrationQueries } from '../queryOptions'
import { PermissionsProvider } from '../hooks/usePermissions'
import { AssistantCommandCenter } from './AssistantCommandCenter'
import type { AssistantConversationDestination, CommandDestination } from '../lib/commandCenterSearch'
import { assistantQueryKeys } from '../queryKeys'

const ownerUserId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
const activityConversationId = '6a1c0b4e-8c2d-4f3e-9a7b-1c2d3e4f5a6b'
const activityPage = {
  totals: {
    unreadConversations: 1,
    unreadUpdates: 2,
    workingTasks: 1,
    waitingTasks: 0,
    needsInputTasks: 1,
    unavailableTasks: 0,
  },
  conversations: [
    {
      id: activityConversationId,
      title: 'Hosting comparison',
      updatedAt: '2026-09-15T10:00:00.000Z',
      latestUpdateSequence: 4,
      unreadUpdates: 2,
      workingTasks: 1,
      waitingTasks: 0,
      needsInputTasks: 1,
      unavailableTasks: 0,
      latestUpdate: {
        messageId: '00000000-0000-4000-8000-000000000004',
        preview: 'Which region should the deployment use?',
        createdAt: '2026-09-15T10:00:00.000Z',
      },
    },
  ],
  hasMore: false,
}

async function fixture(
  pendingWork?: Promise<any>,
  initialStack: CommandDestination[] = [],
  delayedQuery = false,
  options: { activity?: boolean | 'quiet' } = {}
) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  if (options.activity)
    client.setQueryData(
      assistantQueryKeys.activity(ownerUserId, 0),
      options.activity === 'quiet'
        ? { ...activityPage, conversations: [{ ...activityPage.conversations[0], unreadUpdates: 0 }] }
        : activityPage
    )
  const squad = { id: 'ficus', name: 'Ficus', purpose: 'Build software', managerAgentId: 'manager' }
  const work = {
    id: 'work',
    squadId: 'ficus',
    title: 'Fix OAuth',
    status: 'active',
    derivedState: 'in_progress',
    agentIds: ['worker'],
    assigneeAgentId: 'worker',
    description: 'Investigate login',
    priority: 'high',
  }
  const worker = {
    id: 'worker',
    squadId: 'ficus',
    agentTypeId: 'engineer',
    status: 'active',
    metadata: { purpose: 'Fix OAuth implementation' },
  }
  for (const [key, value] of [
    [queries.squads.list().queryKey, [squad]],
    [queries.squads.allWorkStreams().queryKey, [work]],
    [queries.squads.workStreamDetail('work').queryKey, work],
    [queries.squads.agents('ficus').queryKey, [worker]],
    [queries.agents.detail('worker').queryKey, worker],
    [queries.agents.detail('manager').queryKey, { ...worker, id: 'manager', agentTypeId: 'manager' }],
    [
      queries.agentTypes.list().queryKey,
      [
        { id: 'engineer', name: 'Engineer' },
        { id: 'consultant', name: 'Consultant' },
      ],
    ],
    [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
    [queries.actions.pending().queryKey, []],
    [integrationQueries.catalog().queryKey, { integrations: [] }],
  ] as const)
    client.setQueryData(key, value)
  let workFetch: Promise<unknown> | undefined
  if (pendingWork) {
    client.removeQueries({ queryKey: queries.squads.workStreamDetail('work').queryKey })
    workFetch = client.fetchQuery({ ...queries.squads.workStreamDetail('work'), queryFn: () => pendingWork })
  }
  const chats = mock((props: any) => (
    <div data-chat>
      {props.header}
      {props.initialMessage?.content ?? props.agentId}
      <input aria-label="Inline draft" defaultValue="" />
    </div>
  ))
  const ask = mock()
  const navigated = mock()
  const location = { current: '' }
  function LocationProbe() {
    const current = useLocation()
    location.current = current.pathname + current.search
    return null
  }
  const queryChanged = mock()
  const opened: AssistantConversationDestination[] = []
  let commitQuery!: (query: string) => void
  function Harness() {
    const [query, setQuery] = useState('')
    commitQuery = setQuery
    const [stack, setStack] = useState<CommandDestination[]>(initialStack)
    return (
      <AssistantCommandCenter
        active
        {...(delayedQuery ? { query, onQueryChange: queryChanged } : {})}
        stack={stack}
        onPush={(next) => {
          if (next.kind === 'assistant') opened.push(next)
          else setStack((current) => [...current, next])
        }}
        onBack={() => setStack((current) => current.slice(0, -1))}
        onAsk={ask}
        canAsk
        onNavigate={navigated}
        onBrowseAssistant={() => {}}
        dependencies={{ ChatComponent: chats as any }}
      />
    )
  }
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({
            permissions: ['chat:send'],
            identity: { type: 'user', userId: ownerUserId },
            can: (p) => p === 'chat:send',
            isLoading: false,
            isError: false,
          })}
        >
          <MemoryRouter>
            <Harness />
            <LocationProbe />
          </MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const type = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) =>
    dom.act(async () => {
      const proto =
        element.tagName === 'TEXTAREA'
          ? dom.window.HTMLTextAreaElement.prototype
          : element.tagName === 'SELECT'
            ? dom.window.HTMLSelectElement.prototype
            : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  const click = async (selector: string) =>
    dom.act(async () => container.querySelector<HTMLButtonElement>(selector)!.click())
  return {
    dom,
    client,
    work,
    workFetch,
    container,
    chats,
    ask,
    navigated,
    location,
    opened,
    commitQuery,
    queryChanged,
    type,
    click,
    cleanup: async () => {
      await dom.cleanup()
      client.clear()
    },
  }
}

test('work opens inline, assigned chats stay mounted, and Back restores the query and selected result', async () => {
  const f = await fixture()
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    await f.type(input, 'OAuth')
    expect(f.container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(f.container.querySelector('[role="option"]')?.textContent).toContain('In Progress')
    expect(f.container.querySelector('[role="option"]')?.textContent).not.toContain('in_progress')
    await f.dom.act(async () =>
      input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Fix OAuth implementation')
    const footer = f.container.querySelector('footer')!
    expect(footer.textContent).toContain('Enter to open · Shift+Enter for its page · ↑ ↓ select · Esc back')
    expect(footer.textContent).toContain('Assistant conversations')
    expect(footer.parentElement).toBe(f.container.querySelector('[data-command-preview]')!.parentElement)
    expect(footer.closest('[style*="display: none"]')).toBeNull()
    await f.click('[data-command-preview] button')
    expect(f.container.querySelector('footer')).toBeNull()
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/squads/ficus/agents?agent=worker')
    const draft = f.container.querySelector<HTMLInputElement>('[aria-label="Inline draft"]')!
    await f.type(draft, 'A draft to keep')
    await f.click('[aria-label="Back to preview"]')
    await f.click('[data-command-preview] button')
    expect(f.container.querySelector<HTMLInputElement>('[aria-label="Inline draft"]')?.value).toBe('A draft to keep')
    await f.click('[aria-label="Back to preview"]')
    await f.click('[aria-label="Back to search"]')
    expect(input.value).toBe('OAuth')
    expect(document.activeElement).toBe(input)
    expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fix OAuth')
    expect(f.ask).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

test('a squad-targeted request opens a consultant chat with the exact initial prompt', async () => {
  const f = await fixture()
  try {
    await f.type(f.container.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Ficus')
    await f.click('[role="option"]')
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(document.activeElement === input).toBe(true)
    expect(f.container.querySelector('textarea') === null).toBe(true)
    await f.type(input, 'Research database options')
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    const props = f.chats.mock.calls.at(-1)![0]
    expect(props.scope).toEqual({ type: 'consultant', id: 'ficus' })
    expect(props.initialMessage).toEqual({ content: 'Research database options' })
    expect(props.enableFullscreen).toBe(false)
    await f.dom.act(async () => props.onAgentCreated('new-consultant'))
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/squads/ficus/agents?agent=new-consultant')
    expect(f.ask).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

test('Shift+Enter goes to the result page and closes the Assistant; Enter still opens it inline', async () => {
  const f = await fixture()
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    const shiftEnter = () =>
      f.dom.act(async () =>
        input.dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
        )
      )
    await f.type(input, 'Ficus')
    expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Squad')
    expect(f.container.querySelector('footer')?.textContent).toContain('Shift+Enter for its page')
    await shiftEnter()
    expect(f.location.current).toBe('/squads/ficus')
    expect(f.navigated).toHaveBeenCalledTimes(1)
    expect(f.container.querySelector('[data-command-preview]')).toBeNull()

    await f.type(input, 'OAuth')
    await shiftEnter()
    expect(f.location.current).toBe('/squads/ficus/work?ws=work')

    // Plain Enter keeps the nested Assistant view, and doesn't leave the page.
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Fix OAuth')
    expect(f.navigated).toHaveBeenCalledTimes(2)
  } finally {
    await f.cleanup()
  }
})

test('Enter opens the first match by default; the inline icon always asks', async () => {
  const f = await fixture()
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(f.container.querySelector('select')).toBeNull()
    await f.type(input, 'OAuth')
    expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fix OAuth')
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Fix OAuth')
    await f.click('[aria-label="Back to search"]')
    await f.click('[aria-label="Ask Assistant"]')
    expect(f.ask.mock.calls).toEqual([['OAuth']])
    expect(f.container.querySelector('[data-command-preview]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('no matches defaults to Ask, and arriving results select the first row', async () => {
  const f = await fixture()
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    await f.type(input, 'New discovery')
    const askButton = f.container.querySelector<HTMLButtonElement>('[aria-label="Ask Assistant"]')!
    expect(askButton.dataset.enterTarget).toBe('true')
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(f.ask.mock.calls).toEqual([['New discovery']])
    await f.dom.act(async () => {
      f.client.setQueryData(queries.squads.allWorkStreams().queryKey, [{ ...f.work, title: 'New discovery' }])
      await new Promise<void>((resolve) => notifyManager.schedule(resolve))
    })
    expect(askButton.dataset.enterTarget).toBeUndefined()
    expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('New discovery')
    await f.type(input, 'Nothing matching now')
    expect(askButton.dataset.enterTarget).toBe('true')
  } finally {
    await f.cleanup()
  }
})

test('conversation results show non-idle activity indicators and update when status changes', async () => {
  const f = await fixture()
  try {
    const consultant = {
      id: 'consultant',
      squadId: 'ficus',
      agentTypeId: 'consultant',
      status: 'active',
      createdAt: '2026-09-06',
      metadata: { purpose: 'Explore options' },
    }
    await f.dom.act(async () =>
      f.client.setQueryData(queries.agents.list({ agentTypeId: 'consultant' }).queryKey, [consultant])
    )
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    await f.type(input, 'Explore')
    expect(f.container.querySelector('[role="option"] [aria-label="Agent activity: Working"]')).not.toBeNull()
    await f.dom.act(async () =>
      f.client.setQueryData(queries.agents.list({ agentTypeId: 'consultant' }).queryKey, [
        { ...consultant, status: 'idle' },
      ])
    )
    await f.type(input, 'Explore options')
    expect(f.container.querySelector('[role="option"] [role="img"]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('work preview has a skeleton until details arrive, then shows the status pill and content', async () => {
  let resolve!: (value: any) => void
  const pending = new Promise<any>((done) => {
    resolve = done
  })
  const f = await fixture(pending)
  try {
    await f.type(f.container.querySelector<HTMLInputElement>('[role="combobox"]')!, 'OAuth')
    await f.click('[role="option"]')
    const loader = f.container.querySelector('[role="status"][aria-label="Loading work"]')
    expect(loader?.getAttribute('aria-busy')).toBe('true')
    expect(loader?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(f.container.textContent).not.toContain('No assigned conversations yet.')
    await f.dom.act(async () => {
      resolve(f.work)
      await f.workFetch
    })
    for (let attempt = 0; attempt < 50 && f.container.querySelector('[aria-label="Loading work"]'); attempt++) {
      await f.dom.act(async () => await new Promise((done) => setTimeout(done, 10)))
    }
    expect(f.container.querySelector('[aria-label="Loading work"]') === null).toBe(true)
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Investigate login')
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('In Progress')
  } finally {
    resolve(f.work)
    await f.cleanup()
  }
})

test('a restored conversation resolves its purpose in the breadcrumb with a single full-chat link', async () => {
  const f = await fixture(undefined, [
    { kind: 'squad', id: 'ficus', label: 'Squad' },
    { kind: 'chat', id: 'worker', agentId: 'worker', squadId: 'ficus', label: 'Conversation' },
  ])
  try {
    expect(f.container.querySelector('[title="Fix OAuth implementation"]') !== null).toBe(true)
    expect(f.container.querySelectorAll('[aria-label="Open full conversation"]')).toHaveLength(1)
    expect(f.chats.mock.calls.at(-1)![0].header).toBeUndefined()
    await f.click('[aria-label="Back to preview"]')
    expect(f.container.querySelector('[title="Ficus"]') !== null).toBe(true)
  } finally {
    await f.cleanup()
  }
})

for (const status of ['dormant', 'terminated', 'idle']) {
  test(`work omits owner-only chats and shows its ${status} consultant origin read-only`, async () => {
    const f = await fixture()
    try {
      const worker = f.client.getQueryData<any>(queries.agents.detail('worker').queryKey)
      const owner = { ...worker, id: 'owner', agentTypeId: 'manager', metadata: { purpose: 'Squad coordination' } }
      const creator = {
        ...worker,
        id: 'origin',
        agentTypeId: 'consultant',
        status,
        createdAt: '2026-09-06',
        metadata: { purpose: 'Explore OAuth approaches' },
      }
      await f.dom.act(async () => {
        f.client.setQueryData(queries.squads.workStreamDetail('work').queryKey, {
          ...f.work,
          ownerAgentId: owner.id,
          creatorAgentId: creator.id,
          agentIds: ['worker', 'origin'],
        })
        f.client.setQueryData(queries.squads.agents('ficus').queryKey, [
          worker,
          owner,
          ...(status === 'idle' ? [creator] : []),
        ])
        f.client.setQueryData(queries.agents.detail('origin').queryKey, creator)
        f.client.setQueryData(queries.agents.list({ agentTypeId: 'consultant' }).queryKey, [creator])
      })
      // Open a writable conversation first to prove its cached panel cannot leak
      // writable controls when the same chat is later opened as the origin.
      if (status === 'idle') {
        await f.type(f.container.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Explore OAuth approaches')
        await f.click('[role="option"]')
        expect(f.chats.mock.calls.at(-1)![0].inputDisabled).toBe(false)
        await f.click('[aria-label="Back to search"]')
      }
      await f.type(f.container.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Fix OAuth')
      await f.click('[role="option"]')
      const preview = f.container.querySelector('[data-command-preview]')!
      expect(preview.textContent).not.toContain('Squad coordination')
      expect(preview.textContent).toContain('Fix OAuth implementation')
      expect(preview.textContent).toContain('Started here')
      const origins = [...preview.querySelectorAll('button')].filter((button) =>
        button.textContent?.includes('Explore OAuth approaches')
      )
      expect(origins).toHaveLength(1)
      expect(origins[0].querySelector('[role="img"]') === null).toBe(true)
      await f.dom.act(async () => origins[0].click())
      const props = f.chats.mock.calls.at(-1)![0]
      expect(props.agentId).toBe('origin')
      expect(props.readOnly).toBe(true)
      expect(props.inputDisabled).toBe(true)
      expect(props.initialMessage).toBeUndefined()
      expect(f.container.textContent).toContain('Read only')
    } finally {
      await f.cleanup()
    }
  })
}

test('an owner explicitly assigned to the work remains an actionable conversation', async () => {
  const f = await fixture()
  try {
    await f.dom.act(async () =>
      f.client.setQueryData(queries.squads.workStreamDetail('work').queryKey, { ...f.work, ownerAgentId: 'worker' })
    )
    await f.type(f.container.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Fix OAuth')
    await f.click('[role="option"]')
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Fix OAuth implementation')
    expect(f.container.querySelector('[data-command-preview]')?.textContent).not.toContain('Owner')
  } finally {
    await f.cleanup()
  }
})

test('squad completed work starts collapsed and preserves its period after opening work and going back', async () => {
  const f = await fixture(undefined, [{ kind: 'squad', id: 'ficus', label: 'Ficus' }])
  try {
    const completed = {
      ...f.work,
      id: 'completed',
      title: 'Finished deployment',
      status: 'done',
      derivedState: 'done',
      completedAt: new Date(Date.now() - 14 * 86_400_000),
    }
    f.client.setQueryData(queries.squads.allWorkStreams().queryKey, [f.work, completed])
    f.client.setQueryData(queries.squads.workStreamDetail('completed').queryKey, completed)
    expect(f.container.querySelector('[aria-controls="command-completed-work"]')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(f.container.querySelector('#command-completed-work') === null).toBe(true)
    await f.click('[aria-controls="command-completed-work"]')
    expect(f.container.querySelector('#command-completed-work')?.textContent).toContain(
      'No work streams completed in the last 7 days.'
    )
    await f.click('[aria-label="Completed work period"] button:last-child')
    for (
      let attempt = 0;
      attempt < 50 &&
      !f.container.querySelector('#command-completed-work')?.textContent?.includes('Finished deployment');
      attempt++
    ) {
      await f.dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    expect(f.container.querySelector('#command-completed-work')?.textContent).toContain('Finished deployment')
    await f.click('#command-completed-work > button')
    expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Investigate login')
    await f.click('[aria-label="Back to preview"]')
    expect(f.container.querySelector('[aria-controls="command-completed-work"]')?.getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(
      f.container.querySelector('[aria-label="Completed work period"] button:last-child')?.getAttribute('aria-checked')
    ).toBe('true')
    expect(f.container.querySelector('#command-completed-work')?.textContent).toContain('Finished deployment')
  } finally {
    await f.cleanup()
  }
})

test('squad search is scoped, restores its query, and reaches work conversations with arrow keys', async () => {
  const f = await fixture()
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    await f.type(input, 'Ficus')
    await f.click('[role="option"]')
    await f.dom.act(async () =>
      f.client.setQueryData(queries.squads.allWorkStreams().queryKey, [
        f.work,
        { ...f.work, id: 'other', squadId: 'other', title: 'OAuth elsewhere' },
      ])
    )
    await f.type(input, 'OAuth')
    expect(f.container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(f.container.querySelector('[role="option"]')?.textContent).toContain('Fix OAuth')
    await f.dom.act(async () =>
      input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(input.closest('form')!.style.display).toBe('none')
    const preview = f.container.querySelector<HTMLElement>('[data-command-preview]')!
    expect(document.activeElement === preview).toBe(true)
    await f.dom.act(async () =>
      preview.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    const conversation = document.activeElement as HTMLButtonElement
    expect(conversation.textContent).toContain('Fix OAuth implementation')
    // Native button activation (Enter) invokes the same click handler.
    await f.dom.act(async () => conversation.click())
    expect(f.chats.mock.calls.at(-1)![0].agentId).toBe('worker')
    await f.click('[aria-label="Back to preview"]')
    await f.click('[aria-label="Back to preview"]')
    expect(input.value).toBe('OAuth')
    expect(document.activeElement === input).toBe(true)
    await f.click('[aria-label="Back to search"]')
    expect(input.value).toBe('Ficus')
  } finally {
    await f.cleanup()
  }
})

test('squad manager is a pinned row and can be searched and opened with Enter', async () => {
  const f = await fixture(undefined, [{ kind: 'squad', id: 'ficus', label: 'Ficus' }])
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    const preview = f.container.querySelector<HTMLElement>('[data-command-preview]')!
    expect(preview.querySelector('button')?.textContent).toContain('Manager')
    expect(preview.textContent).not.toContain('New conversation')
    await f.type(input, 'manager')
    expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Manager')
    await f.dom.act(async () =>
      input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(f.chats.mock.calls.at(-1)![0].agentId).toBe('manager')
    expect(f.chats.mock.calls.at(-1)![0].keyboardShortcutsEnabled).toBe(true)
    const breadcrumb = f.container.querySelector('[aria-label="Back to preview"]')!.parentElement!
    expect(breadcrumb.querySelector('span[title]')?.textContent).toBe('Manager')
    expect(f.ask).not.toHaveBeenCalled()
    await f.click('[aria-label="Back to preview"]')
    expect(input.value).toBe('manager')
    expect(f.chats.mock.calls.at(-1)![0].keyboardShortcutsEnabled).toBe(false)
    expect(f.container.querySelector('[data-chat]')?.closest('[inert]')).not.toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('empty squad search arrows through preview rows and returns focus to search', async () => {
  const f = await fixture(undefined, [{ kind: 'squad', id: 'ficus', label: 'Ficus' }])
  try {
    const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
    await f.dom.act(async () =>
      input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    expect(document.activeElement?.textContent).toContain('Manager')
    await f.dom.act(async () =>
      document.activeElement!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
      )
    )
    expect(document.activeElement === input).toBe(true)
  } finally {
    await f.cleanup()
  }
})

for (const scoped of [false, true]) {
  test(`${scoped ? 'squad Start' : 'Ask'} is the fallback Enter target and arrow selection stops at both ends`, async () => {
    const f = await fixture(undefined, scoped ? [{ kind: 'squad', id: 'ficus', label: 'Ficus' }] : [])
    try {
      const input = f.container.querySelector<HTMLInputElement>('[role="combobox"]')!
      const button = f.container.querySelector<HTMLButtonElement>(
        scoped ? '[aria-label="Start conversation in squad"]' : '[aria-label="Ask Assistant"]'
      )!
      const arrow = async (key: string) =>
        f.dom.act(async () => input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true })))
      await f.type(input, 'OAuth')
      expect(button.classList.contains('bg-selection')).toBe(false)
      expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fix OAuth')
      await arrow('ArrowUp')
      expect(button.dataset.enterTarget).toBe('true')
      expect(f.container.querySelector('[role="option"][aria-selected="true"]') === null).toBe(true)
      await arrow('ArrowDown')
      expect(button.classList.contains('bg-selection')).toBe(false)
      expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fix OAuth')
      await arrow('ArrowDown')
      expect(f.container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Fix OAuth')
      expect(button.dataset.enterTarget).toBeUndefined()
      await arrow('ArrowUp')
      expect(button.classList.contains('bg-selection')).toBe(true)
      expect(f.container.querySelector('[role="option"][aria-selected="true"]') === null).toBe(true)
      await f.dom.act(async () =>
        input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
      )
      if (scoped) {
        expect(f.chats.mock.calls.at(-1)![0].initialMessage).toEqual({ content: 'OAuth' })
        expect(f.chats.mock.calls.at(-1)![0].scope).toEqual({ type: 'consultant', id: 'ficus' })
      } else expect(f.ask.mock.calls).toEqual([['OAuth']])
    } finally {
      await f.cleanup()
    }
  })
}

for (const type of ['workstream-blocked', 'workstream-review']) {
  test(`${type} preview stays open and drills into work instead of opening a modal`, async () => {
    const f = await fixture(undefined, [{ kind: 'action', id: 'attention', label: 'Needs you' }])
    try {
      await f.dom.act(async () =>
        f.client.setQueryData(queries.actions.pending().queryKey, [
          {
            id: 'attention',
            type,
            canRespond: true,
            squadId: 'ficus',
            squadName: 'Ficus',
            data: {
              workStreamId: 'work',
              workStreamTitle: 'Fix OAuth',
              squadId: 'ficus',
              squadName: 'Ficus',
              prompt: { type: 'text', message: 'Please check this change' },
              wait: { id: 'wait', message: 'Please check this change', completesOnApproval: false },
              focus: { waitId: 'wait' },
              completionMode: 'pr-merge',
            },
          },
        ])
      )
      for (let i = 0; i < 50 && !f.container.querySelector('[data-command-preview] h3'); i++) {
        await f.dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
      }
      const preview = f.container.querySelector<HTMLElement>('[data-command-preview]')!
      expect(preview.textContent).toContain('Please check this change')
      expect(preview.querySelector('[aria-label="Collapse"]') === null).toBe(true)
      expect([...preview.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'View')).toBe(false)
      await f.dom.act(async () => preview.querySelector<HTMLElement>('h3')!.click())
      expect(preview.textContent).toContain('Please check this change')
      await f.click('[data-command-preview] section button')
      expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Investigate login')
      expect(document.querySelector('[role="dialog"]') === null).toBe(true)
      await f.click('[aria-label="Back to preview"]')
      expect(f.container.querySelector('[data-command-preview]')?.textContent).toContain('Please check this change')
    } finally {
      await f.cleanup()
    }
  })
}

test('typing stays synchronous while URL updates are pending and external query restoration still works', async () => {
  const f = await fixture(undefined, [], true)
  try {
    const input = f.container.querySelector<HTMLInputElement>('input[role="combobox"]')!
    await f.type(input, 'alpha omega')
    expect(input.value).toBe('alpha omega')
    await f.type(input, 'Xalpha omega')
    expect(input.value).toBe('Xalpha omega')
    expect(f.queryChanged.mock.calls.at(-1)).toEqual(['Xalpha omega'])
    await f.dom.act(async () => f.commitQuery('Xalpha omega'))
    expect(input.value).toBe('Xalpha omega')
    await f.dom.act(async () => f.commitQuery('restored search'))
    expect(input.value).toBe('restored search')
  } finally {
    await f.cleanup()
  }
})

test('Assistant chats with new updates lead the landing list as chats, take arrow keys and Enter, and disappear while searching', async () => {
  const f = await fixture(undefined, [], false, { activity: true })
  try {
    const rows = () => [...f.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    // A chat like any other (no separate Updates group), saying how many updates are new.
    expect(f.container.querySelector('[role="presentation"]')).toBeNull()
    expect(rows()[0].textContent).toContain('Hosting comparison')
    expect(rows()[0].textContent).toMatch(/\d+ new updates?/)
    expect(rows()[0].textContent).toContain('Which region should the deployment use?')
    expect(rows()[0].textContent).toContain('1 task needs your input')
    expect(rows()[0].querySelector('[aria-label="Unread updates"]')).not.toBeNull()
    expect(rows()[0].getAttribute('aria-selected')).toBe('true')
    const input = f.container.querySelector<HTMLInputElement>('input[role="combobox"]')!
    // Arrow keys move through update rows and ordinary results alike; Up returns to the update row.
    await f.dom.act(async () => {
      input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(rows()[1].getAttribute('aria-selected')).toBe('true')
    expect(rows()[1].textContent).not.toContain('Hosting comparison')
    await f.dom.act(async () => {
      input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(rows()[0].getAttribute('aria-selected')).toBe('true')
    // Enter opens the existing saved conversation through the Assistant stack; no chat is created.
    await f.dom.act(async () => {
      input.form!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(f.opened).toEqual([{ kind: 'assistant', id: activityConversationId, label: 'Assistant' }])
    expect(f.chats).not.toHaveBeenCalled()
    // Searching hides them; clearing the query restores them with the same selection model.
    await f.type(input, 'Fix')
    expect(f.container.textContent).not.toContain('Hosting comparison')
    await f.type(input, '')
    expect(rows()[0].textContent).toContain('Hosting comparison')
  } finally {
    await f.cleanup()
  }
})

test('conversations with only quiet unfinished tasks stay off the top of the landing list', async () => {
  const f = await fixture(undefined, [], false, { activity: 'quiet' })
  try {
    expect(f.container.textContent).not.toContain('Hosting comparison')
    expect(f.container.textContent).not.toContain('new update')
  } finally {
    await f.cleanup()
  }
})

test('a squad preview never shows or queries Assistant updates', async () => {
  const f = await fixture(undefined, [{ kind: 'squad', id: 'ficus', label: 'Ficus' }], false, { activity: true })
  try {
    expect(f.container.textContent).not.toContain('Hosting comparison')
  } finally {
    await f.cleanup()
  }
})

import { PermissionsProvider } from '../hooks/usePermissions'
import { expect, mock, spyOn, test } from 'bun:test'
import { StrictMode, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { assistantApi } from '../api/assistant'
import { AssistantConversationView, type AssistantConversationViewProps } from './AssistantConversationView'
import type { AgentChat, AgentChatController } from './AgentChat'
import type { VoiceAssistantController } from '../voice/useRealtimeVoiceAssistant'

async function fixture(realtime = false) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), {
    permissions: ['chat:send'],
    identity: { type: 'user', userId: 'owner' },
  })
  queryClient.setQueryData(queryKeys.voice.status(), { enabled: false })
  const api = {
    create: mock(async () => ({})),
    history: mock(async () => ({ entries: [], hasMore: false })),
    ensureAgent: mock(async () => ({ agentId: 'brain' })),
    message: mock(async () => ({ id: 'receipt', agentId: 'delegate', delivered: true, kind: 'background' })),
    conversationActivity: mock(async () => ({
      conversation: { latestUpdateSequence: 0 },
      tasks: [],
      updates: [],
      pendingInputs: [],
      hasMore: false,
      beforeSequence: null,
    })),
    append: mock(async () => ({})),
    seenThrough: mock(async () => ({ success: true })),
    inbox: mock(async () => ({})),
    acknowledge: mock(async () => ({})),
    release: mock(async () => ({})),
    correctRouting: mock(async () => ({ hint: {} })),
    previewRouting: mock(async () => ({ hint: null })),
  }
  const sendAccepted = mock((_text: string, options?: { clientId?: string }) => ({
    clientId: options?.clientId ?? 'send',
    accepted: Promise.resolve(),
  }))
  const controller = { items: [], sendAccepted, refresh: mock(() => {}) } as unknown as AgentChatController
  let chatProps: React.ComponentProps<typeof AgentChat> | undefined
  let mounts = 0
  function Chat(input: React.ComponentProps<typeof AgentChat>) {
    chatProps = input
    const onConversation = input.onConversation
    useEffect(() => {
      mounts++
      onConversation?.(controller)
    }, [onConversation])
    return (
      <div data-shared-chat>
        <div data-transcript>{input.beforeConversation}</div>
        {input.initialMessage?.content}
        {input.afterConversation}
      </div>
    )
  }
  const voice = {
    isLiveAudio: false,
    status: 'idle',
    error: null,
    isConnected: false,
    history: [],
    sendText: mock(async () => {}),
    setLiveAudio: mock(async () => {}),
    disconnect: mock(() => {}),
    enqueueMessage: mock(() => {}),
  }
  let definition: VoiceAssistantController<any, any> | undefined
  const props: AssistantConversationViewProps = {
    id: 'conversation',
    realtime,
    compact: false,
    visible: true,
    initialMessage: { id: 'initial', text: 'What needs my attention?' },
    onControls: mock(() => {}),
    onCreated: mock(() => {}),
    onExpand() {},
    positionControl: null,
    dependencies: {
      api: api as any,
      Chat,
      useAssistant: ((value: any) => {
        definition = value
        return voice
      }) as any,
    },
  }
  const { root, container } = dom.createRoot()
  const render = () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({
                can: () => true,
                permissions: ['chat:send'],
                identity: { type: 'user', userId: 'owner' },
                isLoading: false,
                isError: false,
              })}
            >
              <AssistantConversationView {...props} />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>
    )
  return {
    dom,
    container,
    queryClient,
    api,
    props,
    controller,
    sendAccepted,
    voice,
    render,
    get chat() {
      return chatProps!
    },
    get mounts() {
      return mounts
    },
    get definition() {
      return definition!
    },
    cleanup: async () => {
      await dom.cleanup()
      queryClient.clear()
    },
  }
}
for (const realtime of [false, true])
  test(`typed prompts use the shared agent chat with Realtime=${realtime}`, async () => {
    const f = await fixture(realtime)
    try {
      await f.dom.act(async () => f.render())
      expect(f.api.create).toHaveBeenCalledTimes(1)
      expect(f.api.ensureAgent).toHaveBeenCalledTimes(1)
      expect(f.chat.agentId).toBe('brain')
      expect(f.chat.initialMessage).toEqual({ content: 'What needs my attention?' })
      expect(f.voice.sendText).not.toHaveBeenCalled()
      expect(f.api.message).not.toHaveBeenCalled()
      expect(f.api.inbox).not.toHaveBeenCalled()
      await f.dom.act(async () => f.render())
      expect(f.api.ensureAgent).toHaveBeenCalledTimes(1)
    } finally {
      await f.cleanup()
    }
  })
test('a first prompt remains visible while its durable agent binding loads', async () => {
  const f = await fixture()
  let resolve!: (value: { agentId: string }) => void
  f.api.ensureAgent.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  try {
    await f.dom.act(async () => f.render())
    expect(f.container.textContent).toContain('What needs my attention?')
    expect(f.container.textContent).toContain('Loading conversation')
    await f.dom.act(async () => resolve({ agentId: 'brain' }))
    expect(f.container.querySelector('[data-shared-chat]')).not.toBeNull()
  } finally {
    await f.cleanup()
  }
})
test('compact voice mode and hidden panels retain the same mounted chat controller', async () => {
  const f = await fixture(true)
  try {
    await f.dom.act(async () => f.render())
    const mounts = f.mounts
    f.props.compact = true
    f.props.visible = false
    await f.dom.act(async () => f.render())
    expect(f.container.querySelector('[data-shared-chat]')).not.toBeNull()
    expect(f.mounts).toBe(mounts)
    expect(f.chat.keyboardShortcutsEnabled).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('page editor prepares before binding and before each typed dispatch', async () => {
  const f = await fixture()
  const prepare = mock(async () => {})
  f.props.pageEditor = {
    prepare,
    tools: [],
    instructions: 'edit',
    execute: async () => ({ result: {}, followUp: 'never' }),
  }
  try {
    await f.dom.act(async () => f.render())
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.api.create.mock.calls[0]?.[2]).toBe('page-editor')
    await f.chat.beforeSend?.()
    expect(prepare).toHaveBeenCalledTimes(2)
  } finally {
    await f.cleanup()
  }
})
test('voice transcriptions dispatch once to the shared agent and never the legacy task transport', async () => {
  const f = await fixture(true)
  try {
    await f.dom.act(async () => f.render())
    const env = f.definition.useEnvironment()
    const event = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'audio-1',
      transcript: 'Investigate storage',
    }
    await f.dom.act(async () => {
      f.definition.onServerEvent?.(event, {} as never, env)
      f.definition.onServerEvent?.(event, {} as never, env)
    })
    expect(f.sendAccepted).toHaveBeenCalledTimes(1)
    expect(f.sendAccepted.mock.calls[0]).toEqual(['Investigate storage', { clientId: expect.any(String) }])
    expect(f.api.message).not.toHaveBeenCalled()
    expect(f.api.append).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})
test('legacy histories remain readable without being replayed into a new model session', async () => {
  const f = await fixture()
  f.api.history.mockImplementation(
    async () =>
      ({ entries: [{ id: 'legacy', role: 'assistant', text: 'Earlier result', final: true }], hasMore: false }) as any
  )
  try {
    await f.dom.act(async () => f.render())
    expect(f.container.textContent).toContain('Earlier conversation')
    expect(f.container.textContent).toContain('Earlier result')
    expect(f.sendAccepted).not.toHaveBeenCalled()
    expect(f.api.append).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})
test('the earlier conversation starts the transcript as a collapsed disclosure that loads older pages', async () => {
  const f = await fixture()
  f.api.history.mockImplementation(async (_id: string, before?: number) =>
    before
      ? ({ entries: [{ id: 'oldest', role: 'user', text: 'Oldest question', final: true }], hasMore: false } as any)
      : ({
          entries: [{ id: 'legacy', role: 'assistant', text: 'Earlier result', final: true }],
          hasMore: true,
          before: 7,
        } as any)
  )
  try {
    await f.dom.act(async () => f.render())
    // It scrolls with the messages: rendered by the chat's transcript, not as a strip above it.
    const details = f.container.querySelector(
      '[data-transcript] details[data-earlier-conversation]'
    ) as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(f.container.querySelectorAll('details[data-earlier-conversation]')).toHaveLength(1)
    expect(details.className).not.toContain('max-h')
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Earlier conversation')

    const load = [...details.querySelectorAll('button')].find((b) => b.textContent === 'Load earlier messages')!
    await f.dom.act(async () => load.click())
    await waitFor(() => expect(details.textContent).toContain('Oldest question'))
    expect(f.api.history).toHaveBeenLastCalledWith('conversation', 7)
    expect(details.textContent!.indexOf('Oldest question')).toBeLessThan(details.textContent!.indexOf('Earlier result'))
    expect([...details.querySelectorAll('button')].some((b) => b.textContent === 'Load earlier messages')).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('binding failure is retryable and cannot fall back to a different helper', async () => {
  const f = await fixture()
  f.api.ensureAgent.mockImplementationOnce(async () => {
    throw new Error('Temporary failure')
  })
  try {
    await f.dom.act(async () => f.render())
    expect(f.container.textContent).toContain('Temporary failure')
    expect(f.api.message).not.toHaveBeenCalled()
    await f.dom.act(async () => {
      f.container.querySelector('button')!.click()
    })
    expect(f.chat.agentId).toBe('brain')
  } finally {
    await f.cleanup()
  }
})
test('a seen task question outside the latest update page is directly answerable with a correlated receipt', async () => {
  const f = await fixture()
  f.queryClient.setQueryData(queryKeys.agentQuestions.byAgent('delegate', 'open'), [])
  const task = {
    id: 'task',
    currentRequestId: 'request',
    agentId: 'delegate',
    kind: 'background',
    squadId: null,
    label: 'Inspect storage',
    status: 'needs-input',
    unavailable: false,
    createdAt: '',
    updatedAt: '',
  }
  f.api.conversationActivity.mockImplementation(
    async () =>
      ({
        conversation: { latestUpdateSequence: 1 },
        tasks: [task],
        updates: [],
        pendingInputs: [
          {
            messageId: 'question',
            taskId: 'task',
            requestId: 'request',
            sequence: 1,
            reportedStatus: 'needs-input',
            content: 'Which directory?',
            subject: null,
            senderName: 'Worker',
            seenAt: '2026-09-20',
            processedAt: null,
            createdAt: '',
          },
        ],
        hasMore: false,
        beforeSequence: null,
      }) as any
  )
  try {
    await f.dom.act(async () => f.render())
    await f.dom.act(async () =>
      waitFor(() => expect(f.container.querySelector('[data-assistant-questions]')).not.toBeNull())
    )
    const region = f.container.querySelector('[data-assistant-questions]')!
    expect(region.textContent).toContain('Which directory?')
    await f.dom.act(async () =>
      fireEvent.change(region.querySelector('textarea')!, { target: { value: 'Only the cache' } })
    )
    await f.dom.act(async () => {
      ;[...region.querySelectorAll('button')].find((button) => button.textContent === 'Submit Answer')!.click()
    })
    expect(f.api.message.mock.calls.at(-1)).toEqual([
      'conversation',
      'Only the cache',
      expect.any(String),
      { inReplyTo: 'question' },
    ])
    expect(f.api.append).not.toHaveBeenCalled() // Server stores the accepted answer; browser never duplicates it.
    expect(f.voice.sendText).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

test('the first voice click waits for the durable conversation and then starts audio once', async () => {
  const f = await fixture(true)
  f.props.visible = false
  f.props.initialMessage = undefined
  try {
    await f.dom.act(async () => f.render())
    expect(f.api.ensureAgent).not.toHaveBeenCalled()
    const controls = (f.props.onControls as ReturnType<typeof mock>).mock.calls.at(-1)![0]
    await f.dom.act(async () => {
      await controls.startVoice()
    })
    await waitFor(() => expect(f.voice.setLiveAudio).toHaveBeenCalledTimes(1))
    expect(f.api.ensureAgent).toHaveBeenCalledTimes(1)
    expect(f.voice.setLiveAudio).toHaveBeenCalledWith(true)
  } finally {
    await f.cleanup()
  }
})

test('assistant summaries show nested conversations as full rows and task updates as compact chips', async () => {
  const f = await fixture()
  const { queries, assistantQueries } = await import('../queryOptions')
  f.queryClient.setQueryData(queries.agents.detail('delegate').queryKey, {
    id: 'delegate',
    squadId: 'ficus',
    agentTypeId: 'engineer',
    status: 'active',
    metadata: { name: 'Riley', purpose: 'Fix inline PR rows' },
  } as any)
  const covered = [
    {
      messageId: 'update-1',
      taskId: 'task-1',
      taskLabel: 'Fix inline PR rows',
      requestId: 'request-1',
      sequence: 1,
      reportedStatus: 'working',
      content: 'Found the row components.',
      subject: null,
      senderName: 'Riley',
      processedAt: null,
      summarized: true,
      seenAt: null,
      createdAt: new Date().toISOString(),
    },
  ]
  // Mounting refreshes Assistant queries, so the sources load through the API like they do live.
  const readUpdates = spyOn(assistantApi, 'readUpdates').mockImplementation(async () => covered as any)
  f.queryClient.setQueryData(assistantQueries.updates('owner', 'conversation', ['update-1']).queryKey, covered as any)
  const onOpenConversation = mock(() => {})
  f.props.onOpenConversation = onOpenConversation
  await f.dom.act(async () => f.render())
  await waitFor(() => expect(f.chat.renderMessageFooter).toBeDefined())
  const item = {
    kind: 'persisted',
    message: { role: 'assistant', metadata: { assistantUpdateIds: ['update-1'] } },
    blocks: [
      {
        type: 'tool_use',
        toolCall: {
          toolName: 'navigate',
          args: JSON.stringify({ path: '/settings?section=appearance', prompt: true }),
          result: 'Link to /settings?section=appearance shown to user.',
          isError: false,
        },
      },
      {
        type: 'tool_use',
        toolCall: {
          toolName: 'delegate_task',
          result: JSON.stringify({ id: 'receipt', agentId: 'delegate' }),
          isError: false,
        },
      },
    ],
  } as any
  const footerRoot = f.dom.createRoot()
  await f.dom.act(async () =>
    footerRoot.root.render(
      <QueryClientProvider client={f.queryClient}>{f.chat.renderMessageFooter!(item)}</QueryClientProvider>
    )
  )
  const footer = footerRoot.container
  // A full row: the agent's resolved label as the title and an action subtitle, not a bare text link.
  const row = footer.querySelector<HTMLButtonElement>('button[aria-label="Open conversation: Fix inline PR rows"]')!
  expect(row).not.toBeNull()
  expect(row.textContent).toContain('Fix inline PR rows')
  expect(row.textContent).toContain('Open conversation')
  await f.dom.act(async () => fireEvent.click(row))
  expect(onOpenConversation).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'delegate' }))

  // An offered page is a row too, named from the navigation definitions.
  const page = footer.querySelector<HTMLButtonElement>('button[aria-label="Go to Appearance"]')!
  expect(page.textContent).toContain('Appearance')
  expect(page.textContent).toContain('Settings')

  // Each update it covers is one muted line under it; the reply already said what matters.
  const updates = footer.querySelector('[aria-label="Task updates"]')!
  const chip = updates.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(chip.getAttribute('aria-expanded')).toBe('false')
  expect(chip.textContent).toContain('Fix inline PR rows')
  expect(chip.textContent).toContain('Working')
  expect(chip.querySelector('[aria-label="Unread"]')).not.toBeNull()
  // Under a reply there is no preview, and the report itself stays folded away.
  expect(chip.textContent).not.toContain('Found the row components.')
  expect(updates.textContent).not.toContain('Found the row components.')
  await f.dom.act(async () => fireEvent.click(chip))
  expect(chip.getAttribute('aria-expanded')).toBe('true')
  const report = updates.querySelector(`[id="${chip.getAttribute('aria-controls')}"]`)!
  expect(report.textContent).toContain('Found the row components.')
  expect(report.textContent).toContain('Riley')
  await f.dom.act(async () => fireEvent.click(chip))
  expect(updates.textContent).not.toContain('Found the row components.')
  readUpdates.mockRestore()
  await f.cleanup()
})

test('routine progress no reply covers shows as one coalesced chip at its time', async () => {
  const f = await fixture()
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 9, minute)).toISOString()
  const persisted = (id: string, role: string, minute: number, metadata: object = {}) =>
    ({ kind: 'persisted', id, message: { id, role, content: id, createdAt: at(minute), metadata }, blocks: [] }) as any
  const request = persisted('request', 'human', 0)
  const delegated = persisted('delegated', 'assistant', 1)
  // A hidden inbox delivery is not a place to show anything.
  const delivery = persisted('delivery', 'human', 5, { source: 'inbox' })
  const finished = persisted('finished', 'assistant', 9, { assistantUpdateIds: ['done'] })
  ;(f.controller as { items: unknown[] }).items = [request, delegated, delivery, finished]
  const update = (messageId: string, sequence: number, minute: number, reportedStatus: string, extra: object = {}) => ({
    messageId,
    taskId: 'task-1',
    requestId: 'request-1',
    sequence,
    reportedStatus,
    content: `Report ${messageId}`,
    subject: null,
    senderName: 'Riley',
    processedAt: at(minute),
    summarized: false,
    seenAt: null,
    createdAt: at(minute),
    ...extra,
  })
  f.api.conversationActivity.mockImplementation(
    async () =>
      ({
        conversation: { latestUpdateSequence: 4, unreadUpdates: 0 },
        tasks: [{ id: 'task-1', label: 'File nav focus outline', status: 'completed' }],
        updates: [
          update('w1', 1, 2, 'working'),
          update('w2', 2, 4, 'working', { content: 'Reproduced the **clipped** outline\nin Safari.' }),
          update('w3', 3, 6, 'waiting'),
          update('done', 4, 8, 'completed', { summarized: true }),
        ],
        pendingInputs: [],
        hasMore: false,
        beforeSequence: null,
      }) as any
  )
  try {
    await f.dom.act(async () => f.render())
    await waitFor(() => expect(f.api.conversationActivity).toHaveBeenCalled())
    const footerOf = async (item: unknown) => {
      const footer = f.dom.createRoot()
      await f.dom.act(async () =>
        footer.root.render(
          <QueryClientProvider client={f.queryClient}>
            <MemoryRouter>{f.chat.renderMessageFooter!(item as any)}</MemoryRouter>
          </QueryClientProvider>
        )
      )
      return footer.container
    }
    // w1 and w2 follow the delegation reply; w3 arrived after a hidden delivery, so it still sits there.
    await waitFor(async () =>
      expect((await footerOf(delegated)).querySelector('[aria-label="Task progress"]')).not.toBeNull()
    )
    const slot = (await footerOf(delegated)).querySelector('[aria-label="Task progress"]')!
    const chips = slot.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')
    expect(chips).toHaveLength(1)
    const chip = chips[0]!
    expect(chip.textContent).toContain('File nav focus outline')
    expect(chip.textContent).toContain('Waiting')
    expect(chip.textContent).toContain('3 updates')
    // No reply summarizes it, so the line previews the latest report.
    expect(chip.textContent).toContain('Report w3')
    await f.dom.act(async () => fireEvent.click(chip))
    const items = slot.querySelectorAll('li')
    expect([...items].map((li) => li.textContent?.includes('Report w1'))).toEqual([true, false, false])
    expect(items[1]!.textContent).toContain('Reproduced the clipped outline')
    expect(items[1]!.querySelector('strong')?.textContent).toBe('clipped')
    // Nothing routine sits under the user's request, and the summarized completion is not repeated.
    expect((await footerOf(request)).querySelector('[aria-label="Task progress"]')).toBeNull()
    expect((await footerOf(finished)).querySelector('[aria-label="Task progress"]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('viewing a conversation reads its task updates; a hidden or compact one does not', async () => {
  const f = await fixture()
  f.api.conversationActivity.mockImplementation(
    async () =>
      ({
        conversation: { latestUpdateSequence: 5, unreadUpdates: 2 },
        tasks: [],
        updates: [],
        pendingInputs: [],
        hasMore: false,
        beforeSequence: null,
      }) as any
  )
  f.props.visible = false
  await f.dom.act(async () => f.render())
  await waitFor(() => expect(f.api.conversationActivity).toHaveBeenCalled())
  expect(f.api.seenThrough).not.toHaveBeenCalled()
  f.props.visible = true
  await f.dom.act(async () => f.render())
  await waitFor(() => expect(f.api.seenThrough).toHaveBeenCalledWith('conversation', 5))
  await f.cleanup()
})

test('the latest message corrects its routing in place; an older one asks the Assistant in the composer', async () => {
  const f = await fixture()
  try {
    f.queryClient.setQueryData(queryKeys.squads.list('active'), [
      { id: 'squad-chlea', name: 'Chlea', purpose: 'The Chlea app', isAnonymous: false },
      { id: 'squad-billing', name: 'Billing', purpose: 'Invoices', isAnonymous: false },
      { id: 'squad-anon', name: 'Scratch', purpose: '', isAnonymous: true },
    ] as any)
    const human = (id: string, metadata: object, content = 'Fix it') =>
      ({ kind: 'persisted', id, message: { id, role: 'human', content, metadata } }) as any
    const routed = {
      source: 'user_chat',
      assistantRouting: { scope: 'squad', squadId: 'squad-chlea', squadName: 'Chlea', confidence: 0.91 },
    }
    ;(f.controller as { items: unknown[] }).items = [
      human('m-0', routed, 'The export   button\ncrashes'),
      human('m-1', { source: 'user_chat' }),
      human('m-2', { source: 'assistant_routing_correction' }, '[System] You said this is for Chlea.'),
    ]
    await f.dom.act(async () => f.render())
    await waitFor(() => expect(f.chat.renderMessageFooter).toBeDefined())
    expect(f.chat.renderMessageFooter!(human('m-1', { source: 'user_chat' }))).toBeNull()
    // A follow-up's inherited routing reaches only the model: no chip.
    expect(
      f.chat.renderMessageFooter!(
        human('m-1', {
          source: 'user_chat',
          assistantRoutingInherited: { scope: 'squad', squadId: 'squad-chlea', fromMessageId: 'm-0' },
        })
      )
    ).toBeNull()
    const footer = async (item: unknown) => {
      const footerRoot = f.dom.createRoot()
      await f.dom.act(async () =>
        footerRoot.root.render(
          <QueryClientProvider client={f.queryClient}>{f.chat.renderMessageFooter!(item as never)}</QueryClientProvider>
        )
      )
      const chip = footerRoot.container.querySelector<HTMLButtonElement>('[data-assistant-routing] button')!
      expect(chip.textContent).toBe('Chlea')
      await f.dom.act(async () => fireEvent.click(chip))
      return [...f.dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
    }

    // m-1 is the latest message the user sent (the system note after it doesn't count).
    const options = await footer(human('m-1', routed))
    // Anonymous squads are not offered.
    expect(options.map((row) => row.textContent)).toEqual([
      'No squadFicus itself or general work',
      'ChleaThe Chlea app',
      'BillingInvoices',
    ])
    await f.dom.act(async () => fireEvent.click(options[2]!))
    expect(f.api.correctRouting).toHaveBeenCalledWith('conversation', {
      messageId: 'm-1',
      clientId: expect.any(String),
      scope: 'squad',
      squadId: 'squad-billing',
    })
    expect(f.chat.composerDraft).toBeUndefined()

    // m-0's work has already gone somewhere: picking a squad writes a request instead.
    f.api.correctRouting.mockClear()
    const older = await footer(human('m-0', routed, 'The export   button\ncrashes'))
    await f.dom.act(async () => fireEvent.click(older.filter((row) => row.textContent?.startsWith('Billing')).at(-1)!))
    expect(f.api.correctRouting).not.toHaveBeenCalled()
    expect(f.chat.composerDraft).toEqual({ id: 1, text: 'Please move "The export button crashes" to Billing.' })
  } finally {
    await f.cleanup()
  }
})

test("the Assistant's composer routes drafts and sends the user's pick with the message", async () => {
  const f = await fixture()
  try {
    await f.dom.act(async () => f.render())
    await waitFor(() => expect(f.chat.sendOptions).toBeDefined())
    expect(f.chat.onDraftChange).toBeDefined()
    expect(f.chat.composerStatus).toBeDefined()
    // Nothing picked or previewed: the message is routed by the turn as usual.
    expect(f.chat.sendOptions!('The checkout button is broken')).toBeUndefined()
    // A paused draft asks where it would go.
    await f.dom.act(async () => f.chat.onDraftChange!('The checkout button is broken'))
    await waitFor(() =>
      expect(f.api.previewRouting).toHaveBeenCalledWith(
        'conversation',
        'The checkout button is broken',
        expect.anything()
      )
    )
  } finally {
    await f.cleanup()
  }
})

test('page editors are not routed while typing', async () => {
  const f = await fixture()
  try {
    f.props.pageEditor = { prepare: async () => {} } as never
    await f.dom.act(async () => f.render())
    await waitFor(() => expect(f.chat.onDraftChange).toBeDefined())
    await f.dom.act(async () => f.chat.onDraftChange!('The checkout button is broken'))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(f.api.previewRouting).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

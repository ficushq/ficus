import { PermissionsProvider } from '../hooks/usePermissions'
import { expect, mock, test } from 'bun:test'
import { StrictMode, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
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

test('assistant summaries show nested conversations as full rows and task updates as cards', async () => {
  const f = await fixture()
  const { queries, assistantQueries } = await import('../queryOptions')
  f.queryClient.setQueryData(queries.agents.detail('delegate').queryKey, {
    id: 'delegate',
    squadId: 'ficus',
    agentTypeId: 'engineer',
    status: 'active',
    metadata: { name: 'Riley', purpose: 'Fix inline PR rows' },
  } as any)
  f.queryClient.setQueryData(assistantQueries.updates('owner', 'conversation', ['update-1']).queryKey, [
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
      seenAt: null,
      createdAt: new Date().toISOString(),
    },
  ])
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

  // The task updates it covers show inline under it, no toggle, and nothing to mark: viewing reads them.
  const updates = footer.querySelector('[aria-label="Task updates"]')!
  expect(updates.querySelector('[aria-expanded]')).toBeNull()
  const card = updates.querySelector('li')!
  expect(card.textContent).toContain('Fix inline PR rows')
  expect(card.textContent).toContain('Riley')
  expect(card.textContent).toContain('Found the row components.')
  expect(card.querySelector('button')).toBeNull()
  await f.cleanup()
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

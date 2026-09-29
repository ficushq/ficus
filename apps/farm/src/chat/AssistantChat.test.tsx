import { afterEach, describe, expect, it } from 'bun:test'
import { AssistantChat } from './AssistantChat'
import { keyDown, makeAgent, makeFakeClient, makeMessage, render, typeInto, waitFor } from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  localStorage.clear()
})

const composer = (root: ParentNode) => root.querySelector<HTMLTextAreaElement>('textarea.g-chat-input')

const history = (id: string) => ({
  conversation: { id, kind: 'assistant', title: 'Assistant', createdAt: '', updatedAt: '' },
  entries: [],
  hasMore: false,
})

const activity = (unreadUpdates: number, latestUpdateSequence: number) => ({
  conversation: { id: 'c', title: 'Assistant', updatedAt: '', latestUpdateSequence, unreadUpdates },
  tasks: [],
  updates: [],
  pendingInputs: [],
  hasMore: false,
  beforeSequence: null,
})

describe('AssistantChat', () => {
  it("shows a reply's task updates inline under it, and having the chat open reads them", async () => {
    const fake = makeFakeClient({
      agents: { 'asst-agent': makeAgent({ id: 'asst-agent', agentTypeId: 'assistant', squadId: null }) },
      messages: {
        'asst-agent': [
          makeMessage({
            id: 'reply-1',
            agentId: 'asst-agent',
            role: 'assistant',
            content: 'Riley found the row components.',
            metadata: { assistantUpdateIds: ['u1'] },
          }),
        ],
      },
      routes: {
        'GET /assistant/c1': history('c1'),
        'POST /assistant/c1/agent': { agentId: 'asst-agent' },
        'GET /assistant/c1/activity': activity(1, 3),
        'POST /assistant/c1/updates/read': [
          {
            messageId: 'u1',
            taskId: 't1',
            taskLabel: 'Fix inline PR rows',
            requestId: 'r1',
            sequence: 3,
            reportedStatus: 'working',
            content: 'Found the row components.',
            subject: null,
            senderName: 'Riley',
            processedAt: null,
            seenAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
        'POST /assistant/c1/updates/seen-through': { success: true },
      },
    })
    const view = await render(<AssistantChat conversationId="c1" onClose={() => {}} />, { client: fake.client })
    mounted.push(view.unmount)
    await waitFor(() => expect(view.container.querySelector('[aria-label="Task updates"] li')).not.toBeNull())
    const card = view.container.querySelector('[aria-label="Task updates"] li')!
    expect(card.textContent).toContain('Fix inline PR rows')
    expect(card.textContent).toContain('Working')
    expect(card.textContent).toContain('Riley')
    expect(card.textContent).toContain('Found the row components.')
    await waitFor(() =>
      expect(fake.requests.find((r) => r.path === '/assistant/c1/updates/seen-through')?.options?.body).toEqual({
        sequence: 3,
      })
    )
  })

  it('collapses a long task update to a few lines, with Show more / Show less', async () => {
    const report = `${'finding '.repeat(80)}THE_TAIL`
    const fake = makeFakeClient({
      agents: { 'asst-agent': makeAgent({ id: 'asst-agent', agentTypeId: 'assistant', squadId: null }) },
      messages: {
        'asst-agent': [
          makeMessage({
            id: 'reply-1',
            agentId: 'asst-agent',
            role: 'assistant',
            content: 'The audit is complete.',
            metadata: { assistantUpdateIds: ['u1'] },
          }),
        ],
      },
      routes: {
        'GET /assistant/c1': history('c1'),
        'POST /assistant/c1/agent': { agentId: 'asst-agent' },
        'GET /assistant/c1/activity': activity(0, 3),
        'POST /assistant/c1/updates/read': [
          {
            messageId: 'u1',
            taskId: 't1',
            taskLabel: 'Audit access',
            requestId: 'r1',
            sequence: 3,
            reportedStatus: 'completed',
            content: report,
            subject: null,
            senderName: 'Drift',
            processedAt: null,
            seenAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      },
    })
    const view = await render(<AssistantChat conversationId="c1" onClose={() => {}} />, { client: fake.client })
    mounted.push(view.unmount)
    await waitFor(() => expect(view.container.querySelector('[aria-label="Task updates"] li')).not.toBeNull())
    const card = view.container.querySelector('[aria-label="Task updates"] li')!
    const toggle = () => card.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(card.textContent).not.toContain('THE_TAIL')
    expect(toggle().textContent).toBe('Show more')
    toggle().click()
    await waitFor(() => expect(card.textContent).toContain('THE_TAIL'))
    expect(toggle().textContent).toBe('Show less')
    toggle().click()
    await waitFor(() => expect(card.textContent).not.toContain('THE_TAIL'))
  })

  it('creates a conversation when there is none, ensures its agent, and chats with it', async () => {
    const fake = makeFakeClient({
      agents: { 'asst-agent': makeAgent({ id: 'asst-agent', agentTypeId: 'assistant', squadId: null }) },
      messages: {
        'asst-agent': [
          makeMessage({
            id: 'inbox-1',
            agentId: 'asst-agent',
            role: 'human',
            content: 'Task update delivered',
            metadata: { source: 'inbox' },
          }),
        ],
      },
      routes: {
        'GET /assistant': { conversations: [], hasMore: false },
        'POST /assistant': { id: 'new-id', kind: 'assistant', title: '', createdAt: '', updatedAt: '' },
        'GET /assistant/new-id': history('new-id'),
        'POST /assistant/new-id/agent': { agentId: 'asst-agent' },
        'GET /assistant/new-id/activity': activity(0, 0),
      },
    })
    const view = await render(<AssistantChat onClose={() => {}} newId={() => 'new-id'} />, { client: fake.client })
    mounted.push(view.unmount)

    await waitFor(() => expect(composer(view.container)?.disabled).toBe(false))
    expect(fake.requests.map((r) => `${r.options?.method ?? 'GET'} ${r.path}`)).toEqual([
      'GET /assistant?q=&offset=0',
      'POST /assistant',
      'GET /assistant/new-id',
      'POST /assistant/new-id/agent',
      // Nothing new to read in a brand-new conversation.
      'GET /assistant/new-id/activity',
    ])
    expect(fake.requests[1].options?.body).toEqual({ id: 'new-id', title: undefined, kind: 'assistant' })
    // The assistant's inbox deliveries stay hidden, like the web.
    expect(view.container.textContent).not.toContain('Task update delivered')
    expect(composer(view.container)?.placeholder).toBe('Ask anything…')

    typeInto(composer(view.container)!, 'What needs watering?')
    await keyDown(composer(view.container)!, { key: 'Enter' })
    await waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0]).toMatchObject({
      agentId: 'asst-agent',
      content: 'What needs watering?',
      deliveryMode: 'steer',
    })
  })

  it('opens the latest existing conversation without creating one', async () => {
    const fake = makeFakeClient({
      agents: { a2: makeAgent({ id: 'a2', squadId: null }) },
      routes: {
        'GET /assistant': {
          conversations: [{ id: 'c-old', kind: 'assistant', title: 'Old', createdAt: '', updatedAt: '' }],
          hasMore: false,
        },
        'GET /assistant/c-old': {
          ...history('c-old'),
          entries: [{ id: 'e1', role: 'user', text: 'Earlier question', final: true }],
        },
        'POST /assistant/c-old/agent': { agentId: 'a2' },
      },
    })
    const view = await render(<AssistantChat onClose={() => {}} />, { client: fake.client })
    mounted.push(view.unmount)
    await waitFor(() => expect(composer(view.container)).not.toBeNull())
    expect(fake.requests.some((r) => r.path === '/assistant' && r.options?.method === 'POST')).toBe(false)
    // Earlier messages are simply the top of the conversation, not tucked away.
    const log = view.container.querySelector('[role="log"]')
    expect(log?.textContent).toContain('Earlier question')
    expect(view.container.querySelector('details')).toBeNull()
  })

  it('shows a retryable error when the conversation cannot load', async () => {
    const fake = makeFakeClient({ routes: {} })
    const view = await render(<AssistantChat conversationId="missing" onClose={() => {}} />, { client: fake.client })
    mounted.push(view.unmount)
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('unexpected request')
    )
    expect(view.container.querySelector('[role="alert"] button')?.textContent).toBe('Retry')
  })
})

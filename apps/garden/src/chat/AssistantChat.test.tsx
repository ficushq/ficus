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

describe('AssistantChat', () => {
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
    expect(view.container.querySelector('details.g-chat-archive')?.textContent).toContain('Earlier question')
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

import { afterEach, describe, expect, it } from 'bun:test'
import type { QuestionData } from '@ficus/shared'
import { ChatPanel } from './ChatPanel'
import {
  act,
  byText,
  click,
  keyDown,
  makeAgent,
  makeFakeClient,
  makeMessage,
  render,
  typeInto,
  waitFor,
  type FakeClientOptions,
} from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  localStorage.clear()
})

async function openChat(opts: FakeClientOptions = {}) {
  const fake = makeFakeClient({ agents: { 'agent-1': makeAgent() }, ...opts })
  let closed = 0
  const view = await render(<ChatPanel agentId="agent-1" title="Farmer" subtitle="Squad" onClose={() => closed++} />, {
    client: fake.client,
  })
  mounted.push(view.unmount)
  await waitFor(() => expect(fake.stream('agent-1')).toBeDefined())
  return { ...fake, ...view, closed: () => closed }
}

const textarea = (root: ParentNode) => {
  const el = root.querySelector<HTMLTextAreaElement>('textarea.g-chat-input')
  if (!el) throw new Error('no composer')
  return el
}

const pressEnter = (el: HTMLElement, init: KeyboardEventInit = {}) => keyDown(el, { key: 'Enter', ...init })

async function streamText(fake: Awaited<ReturnType<typeof openChat>>, text: string) {
  await act(async () => {
    fake.stream('agent-1')?.onEvent({ type: 'agent', agentId: 'agent-1' })
    fake.stream('agent-1')?.onEvent({ type: 'text', text, streamGroupId: 'S1' })
    await Promise.resolve()
  })
}

describe('ChatPanel', () => {
  it('renders the conversation history with a live log region and a labelled composer', async () => {
    const chat = await openChat({
      messages: {
        'agent-1': [
          makeMessage({ id: 'm1', role: 'human', content: 'How is the harvest?' }),
          makeMessage({
            id: 'm2',
            role: 'assistant',
            content: 'Great',
            createdAt: new Date('2026-01-01T00:00:01Z'),
            metadata: {
              content: [
                {
                  type: 'tool_use',
                  id: 't1',
                  toolCall: {
                    toolCallId: 't1',
                    toolName: 'bash',
                    args: JSON.stringify({ command: 'ls crops' }),
                    result: 'ok',
                    isError: false,
                  },
                },
                { type: 'text', id: 'x1', content: '**Great** harvest' },
              ],
            },
          }),
        ],
      },
    })
    await waitFor(() => expect(chat.container.textContent).toContain('How is the harvest?'))
    const log = chat.container.querySelector('[role="log"]')
    expect(log?.getAttribute('aria-live')).toBe('polite')
    expect(chat.container.querySelector('strong')?.textContent).toBe('Great')
    // Tool call collapsed to one line with its summary.
    const toolRow = byText(chat.container, '.g-chat-tool button', /bash/)
    expect(toolRow.getAttribute('aria-expanded')).toBe('false')
    expect(toolRow.textContent).toContain('ls crops')
    const label = chat.container.querySelector(`label[for="${textarea(chat.container).id}"]`)
    expect(label?.textContent).toBe('Message')
    expect(chat.container.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('sends on Enter with the default steer delivery; Shift+Enter does not send', async () => {
    const chat = await openChat()
    await waitFor(() => expect(textarea(chat.container).disabled).toBe(false))
    const input = textarea(chat.container)
    typeInto(input, 'Water the tomatoes')
    await pressEnter(input, { shiftKey: true })
    expect(chat.sent).toHaveLength(0)
    await pressEnter(input)
    await waitFor(() => expect(chat.sent).toHaveLength(1))
    expect(chat.sent[0]).toMatchObject({ agentId: 'agent-1', content: 'Water the tomatoes', deliveryMode: 'steer' })
    await waitFor(() => expect(textarea(chat.container).value).toBe(''))
  })

  it('shows the delivery control only while a turn is active and sends with the chosen mode', async () => {
    const idle = await openChat()
    await waitFor(() => expect(textarea(idle.container).disabled).toBe(false))
    expect(idle.container.querySelector('select[aria-label="Message delivery"]')).toBeNull()
    expect(byText(idle.container, 'button[type="submit"]', 'Send')).toBeTruthy()
    idle.unmount()
    mounted.length = 0

    const busy = await openChat({ activeExecution: { active: true, status: 'running', executionId: 'e1' } })
    await waitFor(() => expect(busy.container.querySelector('select[aria-label="Message delivery"]')).not.toBeNull())
    const select = busy.container.querySelector<HTMLSelectElement>('select[aria-label="Message delivery"]')!
    expect(select.value).toBe('steer')
    expect(byText(busy.container, 'button[type="submit"]', 'Interrupt')).toBeTruthy()

    act(() => {
      select.value = 'follow-up'
      select.dispatchEvent(
        new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change', { bubbles: true })
      )
    })
    await waitFor(() => byText(busy.container, 'button[type="submit"]', 'Follow up'))
    await waitFor(() => expect(textarea(busy.container).disabled).toBe(false))
    typeInto(textarea(busy.container), 'And the beans')
    await click(byText(busy.container, 'button[type="submit"]', 'Follow up'))
    await waitFor(() => expect(busy.sent).toHaveLength(1))
    expect(busy.sent[0]).toMatchObject({ content: 'And the beans', deliveryMode: 'follow-up' })
  })

  it('offers Stop while a reply streams and calls through to stop the agent', async () => {
    const chat = await openChat()
    expect(chat.container.querySelector('.g-chat-stop')).toBeNull()
    await streamText(chat, 'Digging…')
    await waitFor(() => expect(chat.container.textContent).toContain('Digging…'))
    await click(await waitForEl(chat.container, '.g-chat-stop'))
    await waitFor(() => expect(chat.stopped).toEqual(['agent-1']))
  })

  it('clears queued messages after a confirming second tap and restores their text', async () => {
    const chat = await openChat({ activeExecution: { active: true, status: 'running', executionId: 'e1' } })
    await streamText(chat, 'Working on it')
    await waitFor(() => expect(textarea(chat.container).disabled).toBe(false))
    typeInto(textarea(chat.container), 'Also prune the roses')
    await pressEnter(textarea(chat.container))
    await waitFor(() => expect(chat.sent).toHaveLength(1))
    const clear = await waitForEl(chat.container, '.g-chat-clear')
    expect(clear.textContent).toBe('Clear 1 pending message')
    await click(clear)
    expect(chat.cleared).toEqual([])
    await click(byText(chat.container, '.g-chat-clear', 'Tap again to clear'))
    await waitFor(() => expect(chat.cleared).toEqual(['agent-1']))
    await waitFor(() => expect(textarea(chat.container).value).toBe('Also prune the roses'))
  })

  it('answers a blocking question inline with the formatted answer and hides the composer', async () => {
    const questionData: QuestionData = {
      questions: [
        { id: 'crop', type: 'select', question: 'Which crop?', options: [{ value: 'kale' }, { value: 'corn' }] },
        { id: 'notes', type: 'text', question: 'Anything else?', optional: true },
        { id: 'days', type: 'multi-select', question: 'Days', options: [{ value: 'mon' }, { value: 'tue' }] },
      ],
    }
    const chat = await openChat({
      agents: { 'agent-1': makeAgent({ status: 'waiting-input', questionData }) },
    })
    const card = await waitForEl(chat.container, '.g-chat-ask')
    expect(chat.container.querySelector('textarea.g-chat-input')).toBeNull()
    const submit = byText<HTMLButtonElement>(card, 'button[type="submit"]', 'Submit answers')
    expect(submit.disabled).toBe(true)
    await waitFor(() => expect(card.querySelector<HTMLInputElement>('input[type="radio"]')!.disabled).toBe(false))
    await click(card.querySelector('input[type="radio"][value="corn"]'))
    await click(byText(card, 'label', 'mon').querySelector('input'))
    await click(byText(card, 'label', 'tue').querySelector('input'))
    await waitFor(() => expect(submit.disabled).toBe(false))
    await click(submit)
    await waitFor(() => expect(chat.sent).toHaveLength(1))
    expect(chat.sent[0].content).toBe(JSON.stringify({ crop: 'corn', days: 'mon, tue' }, null, 2))
    await waitFor(() => expect(chat.container.textContent).toContain('Sending answer…'))
  })

  it('sends a lone question’s raw value', async () => {
    const chat = await openChat({
      agents: {
        'agent-1': makeAgent({
          status: 'waiting-input',
          questionData: { questions: [{ id: 'q', type: 'text', question: 'Name the field' }] },
        }),
      },
    })
    const card = await waitForEl(chat.container, '.g-chat-ask')
    // Answering waits for chat:send permission, like the composer.
    await waitFor(() => expect(card.querySelector('textarea')!.disabled).toBe(false))
    typeInto(card.querySelector('textarea')!, '  North meadow ')
    await click(byText(card, 'button[type="submit"]', 'Submit answer'))
    await waitFor(() => expect(chat.sent.map((s) => s.content)).toEqual(['North meadow']))
  })

  it('closes on Escape and from the close button', async () => {
    const chat = await openChat()
    const dialog = chat.container.querySelector<HTMLElement>('[role="dialog"]')!
    await keyDown(dialog, { key: 'Escape' })
    await click(chat.container.querySelector('button[aria-label="Close chat"]'))
    expect(chat.closed()).toBe(2)
  })

  it('moves focus to the composer on open and back to the opener on close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const chat = await openChat()
    await waitFor(() => expect(document.activeElement === textarea(chat.container)).toBe(true))
    chat.unmount()
    mounted.length = 0
    expect(document.activeElement === opener).toBe(true)
    opener.remove()
  })

  it('keeps the composer read-only without chat:send permission', async () => {
    const chat = await openChat({ permissions: ['squads:read'] })
    await waitFor(() =>
      expect(textarea(chat.container).placeholder).toBe('You do not have permission to send chat messages')
    )
    expect(textarea(chat.container).disabled).toBe(true)
  })
})

async function waitForEl(root: ParentNode, selector: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null
  await waitFor(() => {
    found = root.querySelector<HTMLElement>(selector)
    expect(found).not.toBeNull()
  })
  return found!
}

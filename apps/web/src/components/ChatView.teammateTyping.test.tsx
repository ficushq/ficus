import { afterEach, expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { MemoryRouter } from 'react-router-dom'
import type { AgentChatTypingClientMessage } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { WebSocketContext, type WebSocketContextValue } from '../hooks/useWebSocket'
import { ChatView } from './ChatView'

const AGENT = '11111111-1111-4111-8111-111111111111'

const permissions = () => ({
  can: () => true,
  isLoading: false,
  isError: false,
  permissions: ['agents:write'],
  identity: { type: 'user' as const, userId: 'me' },
})

const dependencies = {
  useImageSrcsHook: () => ({}),
  usePermissionsHook: permissions,
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

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function render(props: Partial<React.ComponentProps<typeof ChatView>> = {}, savedDraft?: string) {
  const listeners = new Map<string, Set<(entry: { event: string; data: unknown }) => void>>()
  const sent: AgentChatTypingClientMessage[] = []
  const socket: WebSocketContextValue = {
    subscribe: ((topic: string, callback: (entry: { event: string; data: unknown }) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, new Set())
      listeners.get(topic)!.add(callback)
      return () => listeners.get(topic)?.delete(callback)
    }) as WebSocketContextValue['subscribe'],
    isConnected: true,
    send: (message) => {
      sent.push(message)
      return true
    },
  }
  dom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
      if (savedDraft && props.inputStorageKey)
        window.localStorage.setItem(`chat-draft:${props.inputStorageKey}`, savedDraft)
    },
  })
  const onSend = mock(async () => {})
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <WebSocketContext.Provider value={socket}>
          <ChatView items={[]} agentId={AGENT} onSend={onSend} dependencies={dependencies} {...props} />
        </WebSocketContext.Provider>
      </MemoryRouter>
    )
  )
  const textarea = dom.window.document.querySelector('textarea') as HTMLTextAreaElement
  const emit = (data: unknown) =>
    dom!.act(async () => {
      for (const callback of listeners.get(`agents:${AGENT}`) ?? []) callback({ event: 'agentChat.typing', data })
    })
  const type = (value: string) => dom!.act(async () => fireEvent.input(textarea, { target: { value } }))
  return { sent, emit, type, textarea, onSend, root, listeners }
}

const typing = (state: boolean) => ({ type: 'agentChat.typing', agentId: AGENT, typing: state })

test("typing in the composer tells teammates; clearing it and sending stop at once; teammates' bubbles show above it", async () => {
  const { sent, emit, type, onSend } = await render({ showTeammateTyping: true })
  expect(sent).toEqual([])

  await type('Hel')
  await type('Hello')
  expect(sent).toEqual([typing(true)])
  await type('')
  expect(sent).toEqual([typing(true), typing(false)])

  await emit({ agentId: AGENT, userId: 'alice', typing: true, name: 'Alice' })
  const indicator = dom!.window.document.querySelector('[data-testid="teammates-typing"]')!
  expect(indicator.textContent).toContain('Alice')
  // At the end of the transcript, before the composer.
  const form = dom!.window.document.querySelector('form')!
  expect(indicator.compareDocumentPosition(form) & dom!.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  await type('Ship it')
  expect(sent.at(-1)).toEqual(typing(true))
  await dom!.act(async () => {
    form.dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(sent.at(-1)).toEqual(typing(false))

  await emit({ agentId: AGENT, userId: 'alice', typing: false })
  expect(dom!.window.document.querySelector('[data-testid="teammates-typing"]')).toBeNull()
})

test('opening a chat with a saved draft is not typing', async () => {
  const { sent, textarea } = await render(
    { showTeammateTyping: true, inputStorageKey: 'typing-draft' },
    'a saved draft'
  )
  expect(textarea.value).toBe('a saved draft')
  expect(sent).toEqual([])
})

test('off by default: nothing is sent or shown', async () => {
  const { sent, type, listeners } = await render()
  await type('private thoughts')
  expect(sent).toEqual([])
  expect(listeners.get(`agents:${AGENT}`)?.size ?? 0).toBe(0)
})

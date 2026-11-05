import { afterEach, expect, test } from 'bun:test'
import type { AgentChatTypingClientMessage, AgentChatTypingEventData } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { WebSocketContext, type WebSocketContextValue } from './useWebSocket'
import { useAgentChatTyping, type AgentChatTyping } from './useAgentChatTyping'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const ME = 'me'
// Short, but with wide margins between them, so a busy machine's late timers don't change the outcome.
const timing = { idleMs: 200, heartbeatMs: 40, staleMs: 200 }

type Entry = { event: string; data: unknown }

/** A stand-in socket: records what the page sends and lets the test deliver events on a topic. */
function fakeSocket() {
  const listeners = new Map<string, Set<(entry: Entry) => void>>()
  const sent: AgentChatTypingClientMessage[] = []
  const value: WebSocketContextValue = {
    subscribe: ((topic: string, callback: (entry: Entry) => void) => {
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
  const emit = (
    topic: string,
    data: AgentChatTypingEventData | Record<string, unknown>,
    event = 'agentChat.typing'
  ) => {
    for (const callback of listeners.get(topic) ?? []) callback({ event, data })
  }
  return { value, sent, emit, listeners }
}

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function mount(socket: ReturnType<typeof fakeSocket>, agentId: string | undefined = AGENT) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  const latest: { current: AgentChatTyping | null } = { current: null }
  function Probe({ agentId }: { agentId?: string }) {
    latest.current = useAgentChatTyping(agentId, { selfUserId: ME, timing })
    return null
  }
  const render = async (nextAgentId: string | undefined, value = socket.value) =>
    dom!.act(async () =>
      root.render(
        <WebSocketContext.Provider value={value}>
          <Probe agentId={nextAgentId} />
        </WebSocketContext.Provider>
      )
    )
  await render(agentId)
  return { latest, render, root }
}

const sleep = (ms: number) => dom!.act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
const typingOn = (userId: string, name: string, agentId = AGENT): AgentChatTypingEventData => ({
  agentId,
  userId,
  typing: true,
  name,
})

test('shows every teammate typing, one entry per person, never yourself, and drops them on stop', async () => {
  const socket = fakeSocket()
  const { latest } = await mount(socket)
  await dom!.act(async () => {
    socket.emit(`agents:${AGENT}`, typingOn('alice', 'Alice'))
    socket.emit(`agents:${AGENT}`, typingOn('bob', 'Bob'))
    // Another of Alice's tabs: still one Alice.
    socket.emit(`agents:${AGENT}`, typingOn('alice', 'Alice'))
    // Your own typing (from another tab or device) is never shown.
    socket.emit(`agents:${AGENT}`, typingOn(ME, 'Me'))
    // Other events on the topic, and another agent's typing, are not typing here.
    socket.emit(`agents:${AGENT}`, { messageId: 'm1', agentId: AGENT }, 'message.created')
    socket.emit(`agents:${AGENT}`, typingOn('carol', 'Carol', OTHER_AGENT))
  })
  expect(latest.current!.typers).toEqual([
    { userId: 'alice', name: 'Alice' },
    { userId: 'bob', name: 'Bob' },
  ])

  await dom!.act(async () => socket.emit(`agents:${AGENT}`, { agentId: AGENT, userId: 'alice', typing: false }))
  expect(latest.current!.typers).toEqual([{ userId: 'bob', name: 'Bob' }])
})

test('a typer not heard from in a while drops on their own; heartbeats keep them', async () => {
  const socket = fakeSocket()
  const { latest } = await mount(socket)
  await dom!.act(async () => {
    socket.emit(`agents:${AGENT}`, typingOn('alice', 'Alice'))
    socket.emit(`agents:${AGENT}`, typingOn('bob', 'Bob'))
  })
  for (let beat = 0; beat < 5; beat++) {
    await sleep(50)
    await dom!.act(async () => socket.emit(`agents:${AGENT}`, typingOn('bob', 'Bob')))
  }
  // Alice's "stopped" was lost: she still goes after the stale timeout, while Bob keeps typing.
  expect(latest.current!.typers).toEqual([{ userId: 'bob', name: 'Bob' }])
  await sleep(300)
  expect(latest.current!.typers).toEqual([])
})

test('typing says so at once, again while it goes on, and stops when idle', async () => {
  const socket = fakeSocket()
  const { latest } = await mount(socket)
  await dom!.act(async () => latest.current!.composerChanged(true))
  expect(socket.sent).toEqual([{ type: 'agentChat.typing', agentId: AGENT, typing: true }])
  // More keystrokes right away say nothing new.
  await dom!.act(async () => latest.current!.composerChanged(true))
  expect(socket.sent).toHaveLength(1)

  // Keep typing: heartbeats, then silence stops it.
  for (let key = 0; key < 4; key++) {
    await sleep(50)
    await dom!.act(async () => latest.current!.composerChanged(true))
  }
  const heartbeats = socket.sent.filter((message) => message.typing).length
  expect(heartbeats).toBeGreaterThanOrEqual(3)
  expect(socket.sent.some((message) => !message.typing)).toBe(false)
  await sleep(300)
  expect(socket.sent.at(-1)).toEqual({ type: 'agentChat.typing', agentId: AGENT, typing: false })
  const settled = socket.sent.length
  await sleep(100)
  // Stopped means stopped: no more heartbeats.
  expect(socket.sent).toHaveLength(settled)
})

test('clearing the composer, sending, leaving the chat and switching agents stop straight away', async () => {
  const socket = fakeSocket()
  const { latest, render, root } = await mount(socket)
  const stopped = (agentId = AGENT) => ({ type: 'agentChat.typing', agentId, typing: false })

  await dom!.act(async () => latest.current!.composerChanged(true))
  await dom!.act(async () => latest.current!.composerChanged(false))
  expect(socket.sent.at(-1)).toEqual(stopped())

  await dom!.act(async () => latest.current!.composerChanged(true))
  await dom!.act(async () => latest.current!.stopTyping())
  expect(socket.sent.at(-1)).toEqual(stopped())
  // Already stopped: nothing more to say.
  const count = socket.sent.length
  await dom!.act(async () => latest.current!.stopTyping())
  expect(socket.sent).toHaveLength(count)

  await dom!.act(async () => latest.current!.composerChanged(true))
  await render(OTHER_AGENT)
  expect(socket.sent.at(-1)).toEqual(stopped(AGENT))
  await dom!.act(async () => latest.current!.composerChanged(true))
  expect(socket.sent.at(-1)).toEqual({ type: 'agentChat.typing', agentId: OTHER_AGENT, typing: true })

  await dom!.act(async () => root.unmount())
  expect(socket.sent.at(-1)).toEqual(stopped(OTHER_AGENT))
})

test('a dropped connection clears everyone; without an agent nothing is sent or shown', async () => {
  const socket = fakeSocket()
  const { latest, render } = await mount(socket)
  await dom!.act(async () => socket.emit(`agents:${AGENT}`, typingOn('alice', 'Alice')))
  expect(latest.current!.typers).toHaveLength(1)
  await render(AGENT, { ...socket.value, isConnected: false })
  expect(latest.current!.typers).toEqual([])

  await render(undefined)
  expect(socket.listeners.get(`agents:${AGENT}`)?.size ?? 0).toBe(0)
  const count = socket.sent.length
  await dom!.act(async () => latest.current!.composerChanged(true))
  expect(socket.sent).toHaveLength(count)
})

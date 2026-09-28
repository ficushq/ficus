import { describe, expect, it } from 'bun:test'
import { queryKeys, type WsClient, type WsClientOptions } from '@ficus/client-core'
import type { AgentEventEntry } from '@ficus/client-react'
import { conversationKeysForAgentEvent, createAgentEventHub, type Timers } from './agentEvents'

class FakeSocket implements WsClient {
  subscribed: string[] = []
  unsubscribed: string[] = []
  closed = false
  constructor(readonly options: WsClientOptions) {}
  subscribe(topic: string) {
    this.subscribed.push(topic)
  }
  unsubscribe(topic: string) {
    this.unsubscribed.push(topic)
  }
  close() {
    this.closed = true
  }
  /** Simulate the server. */
  open() {
    this.options.onOpen?.()
  }
  deliver(message: unknown) {
    this.options.onMessage(message)
  }
  drop() {
    this.options.onClose?.({ code: 1006, reason: '' })
  }
}

function manualTimers() {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    pending,
    runAll: () => {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, t] of due) t.fn()
    },
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  let tickets = 0
  let failTicket = false
  const clock = manualTimers()
  const hub = createAgentEventHub({
    fetchTicket: async () => {
      if (failTicket) throw new Error('offline')
      tickets += 1
      return { ticket: `t${tickets}` }
    },
    socketUrl: (ticket) => `ws://test/ws?ticket=${ticket}`,
    connect: (options) => {
      const socket = new FakeSocket(options)
      sockets.push(socket)
      return socket
    },
    backoff: (attempt) => 100 * (attempt + 1),
    idleMs: 5000,
    timers: clock.timers,
  })
  return {
    hub,
    sockets,
    clock,
    tickets: () => tickets,
    failTickets: (fail: boolean) => {
      failTicket = fail
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('agent event hub', () => {
  it('opens one socket lazily with a fresh ticket and the subscribed agent topics', async () => {
    const { hub, sockets } = setup()
    expect(sockets).toHaveLength(0)
    hub.subscribe('a1', () => {})
    await flush()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].options.url).toBe('ws://test/ws?ticket=t1')
    expect(sockets[0].options.topics).toEqual(['agents:a1'])
    expect(sockets[0].options.reconnect).toBe(false)
  })

  it('subscribes and unsubscribes topics as listeners come and go', async () => {
    const { hub, sockets } = setup()
    const offA = hub.subscribe('a1', () => {})
    await flush()
    const offB = hub.subscribe('a2', () => {})
    const offB2 = hub.subscribe('a2', () => {})
    expect(sockets[0].subscribed).toEqual(['agents:a2'])
    offB()
    expect(sockets[0].unsubscribed).toEqual([])
    offB2()
    expect(sockets[0].unsubscribed).toEqual(['agents:a2'])
    offA()
    expect(sockets[0].unsubscribed).toEqual(['agents:a2', 'agents:a1'])
    expect(sockets).toHaveLength(1)
  })

  it('dispatches events on an agent topic to that agent’s listeners only', async () => {
    const { hub, sockets } = setup()
    const a: AgentEventEntry[] = []
    const b: AgentEventEntry[] = []
    hub.subscribe('a1', (e) => a.push(e))
    hub.subscribe('a2', (e) => b.push(e))
    await flush()
    sockets[0].deliver({ type: 'event', topic: 'agents:a1', event: 'message.created', data: { messageId: 'm1' } })
    sockets[0].deliver({ type: 'event', topic: 'agents', event: 'agent.updated', data: {} })
    sockets[0].deliver({ type: 'pong' })
    expect(a).toEqual([{ event: 'message.created', data: { messageId: 'm1' } }])
    expect(b).toEqual([])
  })

  it('keeps delivering to other listeners when one throws', async () => {
    const { hub, sockets } = setup()
    const seen: string[] = []
    const originalError = console.error
    console.error = () => {}
    try {
      hub.subscribe('a1', () => {
        throw new Error('boom')
      })
      hub.subscribe('a1', (e) => seen.push(e.event))
      await flush()
      sockets[0].deliver({ type: 'event', topic: 'agents:a1', event: 'execution.started', data: {} })
    } finally {
      console.error = originalError
    }
    expect(seen).toEqual(['execution.started'])
  })

  it('reconnects after a drop with a NEW ticket and the current topics, backing off', async () => {
    const { hub, sockets, clock, tickets } = setup()
    hub.subscribe('a1', () => {})
    await flush()
    sockets[0].open()
    hub.subscribe('a2', () => {})
    sockets[0].drop()
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([100])
    clock.runAll()
    await flush()
    expect(tickets()).toBe(2)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].options.url).toBe('ws://test/ws?ticket=t2')
    expect(sockets[1].options.topics).toEqual(['agents:a1', 'agents:a2'])
  })

  it('backs off further while tickets fail, and resets after a successful open', async () => {
    const { hub, sockets, clock, failTickets } = setup()
    failTickets(true)
    hub.subscribe('a1', () => {})
    await flush()
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([100])
    clock.runAll()
    await flush()
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([200])
    failTickets(false)
    clock.runAll()
    await flush()
    expect(sockets).toHaveLength(1)
    sockets[0].open()
    sockets[0].drop()
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([100])
  })

  it('closes an idle socket after the linger, without reconnecting', async () => {
    const { hub, sockets, clock } = setup()
    const off = hub.subscribe('a1', () => {})
    await flush()
    off()
    expect(sockets[0].closed).toBe(false)
    clock.runAll()
    expect(sockets[0].closed).toBe(true)
    sockets[0].drop()
    expect(clock.pending.size).toBe(0)
  })

  it('reuses the open socket when a chat reopens within the linger', async () => {
    const { hub, sockets, clock } = setup()
    const off = hub.subscribe('a1', () => {})
    await flush()
    off()
    hub.subscribe('a1', () => {})
    expect(clock.pending.size).toBe(0)
    expect(sockets[0].closed).toBe(false)
    expect(sockets[0].subscribed).toEqual(['agents:a1'])
  })

  it('dispose closes the socket and ignores later subscriptions', async () => {
    const { hub, sockets } = setup()
    hub.subscribe('a1', () => {})
    await flush()
    hub.dispose()
    expect(sockets[0].closed).toBe(true)
    hub.subscribe('a2', () => {})
    await flush()
    expect(sockets).toHaveLength(1)
  })
})

describe('conversationKeysForAgentEvent', () => {
  it('refreshes the active-execution backstop on execution frames and history on terminal ones', () => {
    expect(conversationKeysForAgentEvent('a1', 'execution.started')).toEqual([queryKeys.agents.activeExecution('a1')])
    expect(conversationKeysForAgentEvent('a1', 'execution.completed')).toEqual([
      queryKeys.agents.activeExecution('a1'),
      queryKeys.agents.messagesInfinite('a1'),
    ])
    expect(conversationKeysForAgentEvent('a1', 'agent.queue-cleared')).toEqual([
      queryKeys.agents.messagesInfinite('a1'),
    ])
    expect(conversationKeysForAgentEvent('a1', 'message.created')).toEqual([])
  })
})

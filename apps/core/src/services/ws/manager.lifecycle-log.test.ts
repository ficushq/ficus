import { describe, expect, test } from 'bun:test'
import { WebSocketManager } from './manager'
import type { Identity } from '../rbac'

/**
 * Socket open/close evidence. A live-update stall in a client leaves no trace
 * unless Core says when each socket came and went, so these lines are the
 * server half of the investigation record (the client logs its own view).
 */

function recordingLog() {
  const lines: Array<{ level: 'info' | 'warn' | 'error'; args: unknown[] }> = []
  return {
    lines,
    log: {
      info: (...args: unknown[]) => void lines.push({ level: 'info', args }),
      warn: (...args: unknown[]) => void lines.push({ level: 'warn', args }),
      error: (...args: unknown[]) => void lines.push({ level: 'error', args }),
    },
  }
}

function openSocket(onSend?: () => void) {
  return {
    readyState: WebSocket.OPEN,
    send: (_data: string) => {
      onSend?.()
      return 0
    },
  } as any
}

/** `actions` is the one topic a user may subscribe to without a database permission check. */
const topic = 'actions'

const user: Identity = { type: 'user', userId: 'user-1' }

describe('WebSocketManager socket lifecycle log', () => {
  test('an open logs the client, who it is and how many sockets are now open', () => {
    const { lines, log } = recordingLog()
    const manager = new WebSocketManager(undefined, { log, now: () => 10_000 })

    manager.addClient(openSocket(), user)
    manager.addClient(openSocket(), { type: 'agent', agentId: 'agent-1', squadId: null })

    expect(lines).toEqual([
      { level: 'info', args: ['Socket opened', { clientId: 'client-1', identity: 'user user-1', open: 1 }] },
      { level: 'info', args: ['Socket opened', { clientId: 'client-2', identity: 'agent agent-1', open: 2 }] },
    ])
  })

  test('a close logs the close code and reason, the age, the subscriptions and how many remain', async () => {
    const { lines, log } = recordingLog()
    let now = 10_000
    const manager = new WebSocketManager(undefined, { log, now: () => now })
    const ws = openSocket()
    const clientId = manager.addClient(ws, user)
    await manager.subscribe(clientId, topic)
    manager.addClient(openSocket(), user)
    lines.length = 0

    now = 10_000 + 95_500
    manager.removeByWs(ws, { code: 1001, reason: 'going away' })

    expect(lines).toEqual([
      {
        level: 'info',
        args: [
          'Socket closed',
          {
            clientId: 'client-1',
            identity: 'user user-1',
            cause: 'closed',
            code: 1001,
            reason: 'going away',
            ageSeconds: 96,
            subscriptions: 1,
            open: 1,
          },
        ],
      },
    ])
  })

  test('a socket forgotten because a send threw logs that cause, without a close code', async () => {
    const { lines, log } = recordingLog()
    const manager = new WebSocketManager(undefined, { log, now: () => 10_000 })
    let gone = false
    const ws = openSocket(() => {
      if (gone) throw new Error('socket gone')
    })
    const clientId = manager.addClient(ws, user)
    await manager.subscribe(clientId, topic)
    lines.length = 0

    gone = true
    manager.broadcastActionCenterInvalidation(['user-1'])

    expect(lines).toEqual([
      {
        level: 'info',
        args: [
          'Socket closed',
          {
            clientId: 'client-1',
            identity: 'user user-1',
            cause: 'send-failed',
            code: null,
            reason: null,
            ageSeconds: 0,
            subscriptions: 1,
            open: 0,
          },
        ],
      },
    ])
  })

  test('forgetting a socket twice logs one close', () => {
    const { lines, log } = recordingLog()
    const manager = new WebSocketManager(undefined, { log, now: () => 0 })
    const ws = openSocket()
    const clientId = manager.addClient(ws, user)
    lines.length = 0

    manager.removeByWs(ws, { code: 1000, reason: '' })
    manager.removeClient(clientId)
    manager.removeByWs(ws)

    expect(lines.filter((line) => line.args[0] === 'Socket closed')).toHaveLength(1)
  })
})

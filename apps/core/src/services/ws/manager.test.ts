import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, assistantConversations, squads, systemTokens, users } from '../../db/schema'
import { WebSocketManager } from './manager'
import type { Identity } from '../rbac'

const adminIdentity: Identity = { type: 'legacy' }
const squadAId = '22222222-2222-4222-8222-222222222222'
const squadBId = '33333333-3333-4333-8333-333333333333'
const privateAgentId = '44444444-4444-4444-8444-444444444444'
const unownedAgentId = '55555555-5555-4555-8555-555555555555'
const missingAgentId = '66666666-6666-4666-8666-666666666666'
const ownerUserId = '77777777-7777-4777-8777-777777777777'
const foreignUserId = '88888888-8888-4888-8888-888888888888'
const orphanReaderTypeId = 'ws-orphan-reader'
const activityReaderTypeId = 'ws-activity-reader'
const systemTokenIds: string[] = []

async function activitySystemIdentity(name: string, scopes: string[]): Promise<Extract<Identity, { type: 'system' }>> {
  const id = crypto.randomUUID()
  systemTokenIds.push(id)
  await db.insert(systemTokens).values({ id, name, tokenHash: crypto.randomUUID(), scopes })
  return { type: 'system', systemTokenId: id, name, scopes }
}
const squadAAgentIdentity: Identity = {
  type: 'agent',
  agentId: '11111111-1111-4111-8111-111111111111',
  squadId: squadAId,
}

function openSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: mock((_data: string) => 0),
  } as any
}

/**
 * Wait until the socket has actually sent a frame.
 *
 * Replaces `await Bun.sleep(20)` followed by an immediate
 * `ws.send.mock.calls[0][0]`. Access revocation is asynchronous, so under load
 * 20 ms was a guess that sometimes lost: the dereference then threw
 * `TypeError: undefined is not an object`, which named neither the event that
 * failed to arrive nor the fact that it was a timing loss
 * (docs/history/design/ci-stability-and-flake-eradication.md, catalogue entry 15).
 *
 * This is not a longer sleep. It returns as soon as the frame lands — normally
 * within a millisecond, so the happy path is FASTER than the fixed wait — and
 * only the failure path waits, ending in a named diagnostic rather than a
 * dereference of undefined. The purge assertions that follow are unchanged.
 */
async function waitForSentFrame(ws: { send: { mock: { calls: unknown[][] } } }, what: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (ws.send.mock.calls.length === 0) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after 2000ms waiting for the socket to send ${what}; no frame was sent`)
    }
    await Bun.sleep(1)
  }
}

describe('WebSocketManager', () => {
  let manager: WebSocketManager

  beforeEach(async () => {
    manager = new WebSocketManager()
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
  })

  afterEach(async () => {
    for (const id of systemTokenIds.splice(0)) await db.delete(systemTokens).where(eq(systemTokens.id, id))
    await db.delete(agents).where(eq(agents.id, squadAAgentIdentity.agentId))
    await db.delete(agents).where(eq(agents.id, privateAgentId))
    await db.delete(agents).where(eq(agents.id, unownedAgentId))
    await db.delete(squads).where(eq(squads.id, squadAId))
    await db.delete(agentTypes).where(eq(agentTypes.id, orphanReaderTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, activityReaderTypeId))
    await db.delete(users).where(eq(users.id, ownerUserId))
    await db.delete(users).where(eq(users.id, foreignUserId))
  })

  test('removes a client by socket idempotently', () => {
    const mockWs = { send: mock(() => {}) } as any
    manager.addClient(mockWs, adminIdentity)

    manager.removeByWs(mockWs)
    manager.removeByWs(mockWs)

    expect(manager.getClientByWs(mockWs)).toBeUndefined()
    expect(manager.getDiagnostics().clients).toBe(0)
  })

  test('adds and removes clients', () => {
    const mockWs = { send: mock(() => {}) } as any
    const clientId = manager.addClient(mockWs, adminIdentity)
    expect(clientId).toBeDefined()
    manager.removeClient(clientId)
  })

  test('subscribes client to topic', async () => {
    const mockWs = { send: mock(() => {}) } as any
    const clientId = manager.addClient(mockWs, adminIdentity)
    await manager.subscribe(clientId, 'squads')
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribed', topic: 'squads' }))
  })

  test('does not send to a closing client', async () => {
    const closingWs = { readyState: WebSocket.CLOSING, send: mock(() => {}) } as any
    const client = manager.addClient(closingWs, adminIdentity)
    await manager.subscribe(client, 'squads')
    await manager.broadcast('squads', 'squad.created', { squadId: '123' })
    expect(closingWs.send).not.toHaveBeenCalled()
    expect(manager.getDiagnostics().clients).toBe(0)
  })

  describe('broadcast close fence', () => {
    test('does not send an in-flight broadcast after its registration is removed during authorization', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ws.send.mockClear()
      ;(manager as any).canReceive = mock(async () => {
        authorizationStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      manager.removeClient(clientId)
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(ws.send).not.toHaveBeenCalled()
    })

    test('does not send when the socket closes during authorization', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ws.send.mockClear()
      ;(manager as any).canReceive = mock(async () => {
        authorizationStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      ws.readyState = WebSocket.CLOSED
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(ws.send).not.toHaveBeenCalled()
    })

    test('does not send after the client unsubscribes during authorization', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ;(manager as any).canReceive = mock(async () => {
        authorizationStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      manager.unsubscribe(clientId, 'squads')
      ws.send.mockClear()
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(ws.send).not.toHaveBeenCalled()
    })

    test('rejects a replacement registration reusing the removed client id', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const oldWs = openSocket()
      const oldClientId = manager.addClient(oldWs, adminIdentity)
      await manager.subscribe(oldClientId, 'squads')
      oldWs.send.mockClear()
      let authorizationCalls = 0

      ;(manager as any).canReceive = mock(async () => {
        authorizationCalls += 1
        if (authorizationCalls === 1) {
          authorizationStarted.resolve()
          return releaseAuthorization.promise
        }
        return true
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      manager.removeClient(oldClientId)
      ;(manager as any).clientIdCounter -= 1
      const replacementWs = openSocket()
      const replacementClientId = manager.addClient(replacementWs, adminIdentity)
      expect(replacementClientId).toBe(oldClientId)
      await manager.subscribe(replacementClientId, 'squads')
      replacementWs.send.mockClear()
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(oldWs.send).not.toHaveBeenCalled()
      expect(replacementWs.send).not.toHaveBeenCalled()
      expect(authorizationCalls).toBe(1)
    })

    test('does not send when asynchronous authorization denies the active registration', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ws.send.mockClear()
      ;(manager as any).canReceive = mock(async () => {
        authorizationStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      releaseAuthorization.resolve(false)
      await broadcasting

      expect(ws.send).not.toHaveBeenCalled()
    })

    test('sends once to an active authorized registration', async () => {
      const authorizationStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ws.send.mockClear()
      ;(manager as any).canReceive = mock(async () => {
        authorizationStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await authorizationStarted.promise
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'event',
          topic: 'squads',
          event: 'squad.updated',
          data: { squadId: squadAId },
        })
      )
    })

    test('sends to an active client while excluding a neighboring client removed during authorization', async () => {
      const bothAuthorizationCallsStarted = Promise.withResolvers<void>()
      const releaseAuthorization = Promise.withResolvers<boolean>()
      const activeWs = openSocket()
      const removedWs = openSocket()
      const activeClientId = manager.addClient(activeWs, adminIdentity)
      const removedClientId = manager.addClient(removedWs, adminIdentity)
      await manager.subscribe(activeClientId, 'squads')
      await manager.subscribe(removedClientId, 'squads')
      activeWs.send.mockClear()
      removedWs.send.mockClear()
      let arrivals = 0
      ;(manager as any).canReceive = mock(async () => {
        arrivals += 1
        if (arrivals === 2) bothAuthorizationCallsStarted.resolve()
        return releaseAuthorization.promise
      })

      const broadcasting = manager.broadcast('squads', 'squad.updated', { squadId: squadAId })
      await bothAuthorizationCallsStarted.promise
      manager.removeClient(removedClientId)
      releaseAuthorization.resolve(true)
      await broadcasting

      expect(activeWs.send).toHaveBeenCalledTimes(1)
      expect(removedWs.send).not.toHaveBeenCalled()
    })

    test('revalidates a removed registration independently in concurrent broadcasts', async () => {
      const bothAuthorizationCallsStarted = Promise.withResolvers<void>()
      const releases = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()]
      const ws = openSocket()
      const clientId = manager.addClient(ws, adminIdentity)
      await manager.subscribe(clientId, 'squads')
      ws.send.mockClear()
      let authorizationCalls = 0
      ;(manager as any).canReceive = mock(async () => {
        const callIndex = authorizationCalls++
        if (authorizationCalls === 2) bothAuthorizationCallsStarted.resolve()
        return releases[callIndex].promise
      })

      const firstBroadcast = manager.broadcast('squads', 'squad.updated', { sequence: 1 })
      const secondBroadcast = manager.broadcast('squads', 'squad.updated', { sequence: 2 })
      await bothAuthorizationCallsStarted.promise
      manager.removeClient(clientId)
      releases[1].resolve(true)
      releases[0].resolve(true)
      await Promise.all([firstBroadcast, secondBroadcast])

      expect(authorizationCalls).toBe(2)
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  test('resolves null-event instance topic scope once for multiple eligible clients', async () => {
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
    await db
      .insert(agents)
      .values({ id: squadAAgentIdentity.agentId, agentTypeId: 'worker', squadId: squadAId })
      .onConflictDoNothing()
    const firstWs = openSocket()
    const secondWs = openSocket()
    const firstClientId = manager.addClient(firstWs, squadAAgentIdentity)
    const secondClientId = manager.addClient(secondWs, squadAAgentIdentity)
    const topic = `agents:${squadAAgentIdentity.agentId}` as const
    await manager.subscribe(firstClientId, topic)
    await manager.subscribe(secondClientId, topic)
    firstWs.send.mockClear()
    secondWs.send.mockClear()
    const resolveTopicScope = mock(async () => ({ kind: 'squad', squadId: squadAId }))
    ;(manager as any).resolveTopicScope = resolveTopicScope

    await manager.broadcast(topic, 'execution.updated', { executionId: 'exec-1' })

    expect(resolveTopicScope).toHaveBeenCalledTimes(1)
    expect(firstWs.send).toHaveBeenCalledTimes(1)
    expect(secondWs.send).toHaveBeenCalledTimes(1)
  })

  test('does not resolve null-event instance topic scope without an eligible subscriber', async () => {
    const ws = openSocket()
    const clientId = manager.addClient(ws, adminIdentity)
    await manager.subscribe(clientId, 'squads')
    const resolveTopicScope = mock(async () => ({ kind: 'unresolved' }))
    ;(manager as any).resolveTopicScope = resolveTopicScope

    await manager.broadcast(`agents:${squadAAgentIdentity.agentId}`, 'execution.updated', { executionId: 'exec-1' })

    expect(resolveTopicScope).not.toHaveBeenCalled()
  })

  test('broadcasts to subscribed clients', async () => {
    const mockWs1 = { send: mock(() => {}) } as any
    const mockWs2 = { send: mock(() => {}) } as any
    const client1 = manager.addClient(mockWs1, adminIdentity)
    manager.addClient(mockWs2, adminIdentity)
    await manager.subscribe(client1, 'squads')
    await manager.broadcast('squads', 'squad.created', { squadId: '123' })
    expect(mockWs1.send).toHaveBeenCalledTimes(2)
    expect(mockWs2.send).toHaveBeenCalledTimes(0)
  })

  test('broadcasts to specific entity subscribers', async () => {
    const mockWs = { send: mock(() => {}) } as any
    const clientId = manager.addClient(mockWs, adminIdentity)
    await manager.subscribe(clientId, 'squads:abc-123')
    await manager.broadcast('squads:abc-123', 'squad.updated', { squadId: 'abc-123' })
    await manager.broadcast('squads:other-id', 'squad.updated', { squadId: 'other-id' })
    expect(mockWs.send).toHaveBeenCalledTimes(2)
  })

  test('rejects invalid topics', async () => {
    const mockWs = { send: mock(() => {}) } as any
    const clientId = manager.addClient(mockWs, adminIdentity)
    await manager.subscribe(clientId, 'invalid-topic')
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Invalid topic: invalid-topic' }))
  })

  test('authorizes squad-less agent subscriptions by private owner and system permission', async () => {
    await db.insert(users).values([
      { id: ownerUserId, email: 'ws-owner@example.com' },
      { id: foreignUserId, email: 'ws-foreign@example.com' },
    ])
    await db.insert(agents).values([
      { id: privateAgentId, agentTypeId: 'system-manager', ownerUserId },
      { id: unownedAgentId, agentTypeId: 'artifact-builder' },
    ])

    const cases: Array<{ identity: Identity; topic: string; allowed: boolean }> = [
      { identity: { type: 'user', userId: ownerUserId }, topic: `agents:${privateAgentId}`, allowed: true },
      {
        identity: { type: 'agent', agentId: privateAgentId, squadId: null, userId: ownerUserId },
        topic: `agents:${privateAgentId}`,
        allowed: true,
      },
      { identity: { type: 'user', userId: foreignUserId }, topic: `agents:${privateAgentId}`, allowed: false },
      { identity: adminIdentity, topic: `agents:${privateAgentId}`, allowed: false },
      {
        identity: { type: 'system', systemTokenId: 'reader', name: 'reader', scopes: ['agents:read'] },
        topic: `agents:${privateAgentId}`,
        allowed: false,
      },
      {
        identity: { type: 'system', systemTokenId: 'reader', name: 'reader', scopes: ['agents:read'] },
        topic: `agents:${unownedAgentId}`,
        allowed: true,
      },
      {
        identity: { type: 'system', systemTokenId: 'none', name: 'none', scopes: [] },
        topic: `agents:${unownedAgentId}`,
        allowed: false,
      },
      { identity: squadAAgentIdentity, topic: `agents:${unownedAgentId}`, allowed: false },
      { identity: adminIdentity, topic: `agents:${unownedAgentId}`, allowed: true },
      { identity: adminIdentity, topic: `agents:${missingAgentId}`, allowed: false },
    ]

    for (const entry of cases) {
      const ws = openSocket()
      const clientId = manager.addClient(ws, entry.identity)
      await manager.subscribe(clientId, entry.topic)
      expect(ws.send).toHaveBeenLastCalledWith(
        JSON.stringify(
          entry.allowed
            ? { type: 'subscribed', topic: entry.topic }
            : { type: 'error', code: 'FORBIDDEN_TOPIC', topic: entry.topic, message: 'Forbidden topic' }
        )
      )
      manager.removeClient(clientId)
    }
  })

  test('denies a squad-bound agent identity from an unowned squad-less agent', async () => {
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
    await db.insert(agentTypes).values({
      id: orphanReaderTypeId,
      name: 'WS orphan reader',
      model: 'test:model',
      systemPrompt: 'test',
      extraScopes: ['agents:read'],
    })
    await db.insert(agents).values([
      { id: squadAAgentIdentity.agentId, agentTypeId: orphanReaderTypeId, squadId: squadAId },
      { id: unownedAgentId, agentTypeId: 'artifact-builder' },
    ])
    const ws = openSocket()
    const clientId = manager.addClient(ws, squadAAgentIdentity)

    await manager.subscribe(clientId, `agents:${unownedAgentId}`)

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        code: 'FORBIDDEN_TOPIC',
        topic: `agents:${unownedAgentId}`,
        message: 'Forbidden topic',
      })
    )
  })

  test('delivers saved Assistant activity only to the conversation owner, even on the collection topic', async () => {
    await db.insert(users).values([
      { id: ownerUserId, email: 'ws-owner@example.com' },
      { id: foreignUserId, email: 'ws-foreign@example.com' },
    ])
    const conversationId = crypto.randomUUID()
    await db.insert(assistantConversations).values({ id: conversationId, ownerUserId })
    const recipientId = `assistant:${conversationId}`
    const ownerWs = openSocket(),
      foreignWs = openSocket(),
      adminWs = openSocket(),
      ownerInstanceWs = openSocket()
    try {
      const owner = manager.addClient(ownerWs, { type: 'user', userId: ownerUserId })
      const foreign = manager.addClient(foreignWs, { type: 'user', userId: foreignUserId })
      const admin = manager.addClient(adminWs, adminIdentity)
      const ownerInstance = manager.addClient(ownerInstanceWs, { type: 'user', userId: ownerUserId })
      await manager.subscribe(owner, 'inbox')
      await manager.subscribe(foreign, 'inbox')
      await manager.subscribe(admin, 'inbox')
      await manager.subscribe(ownerInstance, `inbox:${recipientId}`)
      // The foreign user cannot even subscribe to the owner's instance topic.
      await manager.subscribe(foreign, `inbox:${recipientId}`)
      expect(foreignWs.send.mock.calls.map(([frame]: [string]) => JSON.parse(frame).type)).toContain('error')
      const data = { conversationId, recipientId }
      await manager.broadcast('inbox', 'assistant.activityChanged', data)
      await manager.broadcast(`inbox:${recipientId}`, 'assistant.activityChanged', data)
      await manager.broadcast('inbox', 'inbox.messageReceived', {
        messageId: 'm1',
        recipientType: 'voice_assistant',
        recipientId,
        senderAgentId: null,
      })
      const events = (ws: { send: { mock: { calls: unknown[][] } } }) =>
        ws.send.mock.calls
          .map(([frame]) => JSON.parse(frame as string))
          .filter((frame) => frame.type === 'event')
          .map((frame) => `${frame.topic}:${frame.event}`)
      expect(events(ownerWs)).toEqual(['inbox:assistant.activityChanged', 'inbox:inbox.messageReceived'])
      expect(events(ownerInstanceWs)).toEqual([`inbox:${recipientId}:assistant.activityChanged`])
      expect(events(foreignWs)).toEqual([])
      // Full squad access does not widen a private conversation's activity.
      expect(events(adminWs)).toEqual([])
    } finally {
      await db.delete(assistantConversations).where(eq(assistantConversations.id, conversationId))
    }
  })

  test('preserves merge-base legacy access to foreign inbox topics', async () => {
    const ws = openSocket()
    const clientId = manager.addClient(ws, adminIdentity)

    await manager.subscribe(clientId, `inbox:${foreignUserId}`)
    await manager.broadcast(`inbox:${foreignUserId}`, 'inbox.messageReceived', {
      recipientId: foreignUserId,
      messageId: 'm1',
    })

    expect(ws.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'subscribed', topic: `inbox:${foreignUserId}` }))
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'event',
        topic: `inbox:${foreignUserId}`,
        event: 'inbox.messageReceived',
        data: { recipientId: foreignUserId, messageId: 'm1' },
      })
    )
  })

  test('reauthorizes private agent instance and collection delivery against the current owner', async () => {
    await db.insert(users).values([
      { id: ownerUserId, email: 'ws-owner@example.com' },
      { id: foreignUserId, email: 'ws-foreign@example.com' },
    ])
    await db.insert(agents).values({ id: privateAgentId, agentTypeId: 'system-manager', ownerUserId })

    const ownerWs = openSocket()
    const foreignWs = openSocket()
    const ownerClient = manager.addClient(ownerWs, { type: 'user', userId: ownerUserId })
    const foreignClient = manager.addClient(foreignWs, adminIdentity)
    await manager.subscribe(ownerClient, `agents:${privateAgentId}`)
    await manager.subscribe(ownerClient, 'agents')
    await manager.subscribe(foreignClient, 'agents')
    ownerWs.send.mockClear()
    foreignWs.send.mockClear()

    await manager.broadcast(`agents:${privateAgentId}`, 'message.created', { agentId: privateAgentId, messageId: 'm1' })
    await manager.broadcast('agents', 'message.created', { agentId: privateAgentId, messageId: 'm1' })

    expect(ownerWs.send).toHaveBeenCalledTimes(2)
    expect(foreignWs.send).not.toHaveBeenCalled()

    await db.update(agents).set({ ownerUserId: foreignUserId }).where(eq(agents.id, privateAgentId))
    await manager.broadcast(`agents:${privateAgentId}`, 'message.updated', { agentId: privateAgentId, messageId: 'm1' })
    await manager.broadcast('agents', 'message.updated', { agentId: privateAgentId, messageId: 'm1' })
    expect(ownerWs.send).toHaveBeenCalledTimes(2)
    expect(foreignWs.send).not.toHaveBeenCalled()

    await db.delete(agents).where(eq(agents.id, privateAgentId))
    await manager.broadcast(`agents:${privateAgentId}`, 'message.updated', { agentId: privateAgentId, messageId: 'm1' })
    expect(ownerWs.send).toHaveBeenCalledTimes(2)
  })

  test('delivers private agent deletion frames only to the former owner after row deletion', async () => {
    await db.insert(users).values([
      { id: ownerUserId, email: 'ws-owner@example.com' },
      { id: foreignUserId, email: 'ws-foreign@example.com' },
    ])
    await db.insert(agents).values({ id: privateAgentId, agentTypeId: 'system-manager', ownerUserId })
    const ownerWs = openSocket()
    const adminWs = openSocket()
    const foreignWs = openSocket()
    const ownerClient = manager.addClient(ownerWs, { type: 'user', userId: ownerUserId })
    const adminClient = manager.addClient(adminWs, adminIdentity)
    const foreignClient = manager.addClient(foreignWs, { type: 'user', userId: foreignUserId })
    await manager.subscribe(ownerClient, `agents:${privateAgentId}`)
    await manager.subscribe(ownerClient, 'agents')
    await manager.subscribe(adminClient, 'agents')
    await manager.subscribe(foreignClient, 'agents')
    ownerWs.send.mockClear()
    adminWs.send.mockClear()
    foreignWs.send.mockClear()
    await db.delete(agents).where(eq(agents.id, privateAgentId))
    const payload = { agentId: privateAgentId, squadId: null, ownerUserId }

    await manager.broadcast(`agents:${privateAgentId}`, 'agent.deleted', payload)
    await manager.broadcast('agents', 'agent.deleted', payload)

    const instanceFrame = JSON.stringify({
      type: 'event',
      topic: `agents:${privateAgentId}`,
      event: 'agent.deleted',
      data: payload,
    })
    const collectionFrame = JSON.stringify({ type: 'event', topic: 'agents', event: 'agent.deleted', data: payload })
    expect(ownerWs.send).toHaveBeenNthCalledWith(1, instanceFrame)
    expect(ownerWs.send).toHaveBeenNthCalledWith(2, collectionFrame)
    expect(adminWs.send).not.toHaveBeenCalled()
    expect(foreignWs.send).not.toHaveBeenCalled()
  })

  test('fails closed when a deleted instance payload omits or mismatches its topic agent id', async () => {
    await db.insert(users).values({ id: ownerUserId, email: 'ws-owner@example.com' })
    await db.insert(agents).values({ id: privateAgentId, agentTypeId: 'system-manager', ownerUserId })
    const ownerWs = openSocket()
    const ownerClient = manager.addClient(ownerWs, { type: 'user', userId: ownerUserId })
    await manager.subscribe(ownerClient, `agents:${privateAgentId}`)
    ownerWs.send.mockClear()
    await db.delete(agents).where(eq(agents.id, privateAgentId))

    await manager.broadcast(`agents:${privateAgentId}`, 'agent.deleted', {
      agentId: unownedAgentId,
      squadId: null,
      ownerUserId,
    })
    await manager.broadcast(`agents:${privateAgentId}`, 'agent.deleted', { squadId: null, ownerUserId })

    expect(ownerWs.send).not.toHaveBeenCalled()
  })

  test('delivers unowned deletion frames through agents:read while denying an unprivileged user', async () => {
    await db.insert(users).values({ id: foreignUserId, email: 'ws-foreign@example.com' })
    await db.insert(agents).values({ id: unownedAgentId, agentTypeId: 'artifact-builder' })
    const adminWs = openSocket()
    const deniedWs = openSocket()
    const adminClient = manager.addClient(adminWs, adminIdentity)
    const deniedClient = manager.addClient(deniedWs, { type: 'user', userId: foreignUserId })
    await manager.subscribe(adminClient, `agents:${unownedAgentId}`)
    await manager.subscribe(adminClient, 'agents')
    await manager.subscribe(deniedClient, 'agents')
    adminWs.send.mockClear()
    deniedWs.send.mockClear()
    await db.delete(agents).where(eq(agents.id, unownedAgentId))
    const payload = { agentId: unownedAgentId, squadId: null, ownerUserId: null }

    await manager.broadcast(`agents:${unownedAgentId}`, 'agent.deleted', payload)
    await manager.broadcast('agents', 'agent.deleted', payload)

    expect(adminWs.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'event', topic: `agents:${unownedAgentId}`, event: 'agent.deleted', data: payload })
    )
    expect(adminWs.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'event', topic: 'agents', event: 'agent.deleted', data: payload })
    )
    expect(deniedWs.send).not.toHaveBeenCalled()
  })

  test('authorizes system-manager sandbox status only for its user', async () => {
    const ownerWs = openSocket()
    const foreignWs = openSocket()
    const ownerClient = manager.addClient(ownerWs, { type: 'user', userId: ownerUserId })
    const foreignClient = manager.addClient(foreignWs, { type: 'user', userId: foreignUserId })
    await manager.subscribe(ownerClient, 'agents')
    await manager.subscribe(foreignClient, 'agents')
    ownerWs.send.mockClear()
    foreignWs.send.mockClear()
    const payload = { sandboxId: `system_manager_${ownerUserId}`, status: 'running' }

    await manager.broadcast('agents', 'sandbox.status', payload)

    expect(ownerWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'event', topic: 'agents', event: 'sandbox.status', data: payload })
    )
    expect(foreignWs.send).not.toHaveBeenCalled()
  })

  test('ignores stale payload squad after an agent becomes private', async () => {
    await db.insert(users).values({ id: ownerUserId, email: 'ws-owner@example.com' })
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
    await db.insert(agents).values([
      // The subscriber must exist as a live agent row: since #1223, agent
      // identity resolution fails closed when the agents row is missing.
      { id: squadAAgentIdentity.agentId, agentTypeId: 'worker', squadId: squadAId },
      { id: privateAgentId, agentTypeId: 'worker', squadId: squadAId },
    ])
    const oldSquadWs = openSocket()
    const oldSquadClient = manager.addClient(oldSquadWs, squadAAgentIdentity)
    await manager.subscribe(oldSquadClient, `agents:${privateAgentId}`)
    await manager.subscribe(oldSquadClient, 'agents')
    expect(oldSquadWs.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'subscribed', topic: `agents:${privateAgentId}` })
    )
    expect(oldSquadWs.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'subscribed', topic: 'agents' }))
    oldSquadWs.send.mockClear()

    await db.update(agents).set({ squadId: null, ownerUserId }).where(eq(agents.id, privateAgentId))
    const stalePayload = { agentId: privateAgentId, messageId: 'm1', squadId: squadAId }
    await manager.broadcast(`agents:${privateAgentId}`, 'message.updated', stalePayload)
    await manager.broadcast('agents', 'message.updated', stalePayload)

    expect(oldSquadWs.send).not.toHaveBeenCalled()
  })

  test('denies inaccessible squad instance subscription', async () => {
    const mockWs = { send: mock(() => {}) } as any
    const clientId = manager.addClient(mockWs, squadAAgentIdentity)
    await manager.subscribe(clientId, `squads:${squadBId}`)
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        code: 'FORBIDDEN_TOPIC',
        topic: `squads:${squadBId}`,
        message: 'Forbidden topic',
      })
    )
    await manager.broadcast(`squads:${squadBId}`, 'squad.updated', { squadId: squadBId })
    expect(mockWs.send).toHaveBeenCalledTimes(1)
  })

  test('filters collection broadcasts by accessible squad', async () => {
    const adminWs = { send: mock(() => {}) } as any
    const userWs = { send: mock(() => {}) } as any
    const adminClient = manager.addClient(adminWs, adminIdentity)
    const userClient = manager.addClient(userWs, squadAAgentIdentity)
    await manager.subscribe(adminClient, 'squads')
    await manager.subscribe(userClient, 'squads')
    await manager.broadcast('squads', 'squad.updated', { squadId: squadBId })
    expect(adminWs.send).toHaveBeenCalledTimes(2)
    expect(userWs.send).toHaveBeenCalledTimes(1)
  })

  test('delivers null-scope events on authorized instance topics', async () => {
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
    await db
      .insert(agents)
      .values({ id: squadAAgentIdentity.agentId, agentTypeId: 'worker', squadId: squadAId })
      .onConflictDoNothing()

    const userWs = { send: mock(() => {}) } as any
    const userClient = manager.addClient(userWs, squadAAgentIdentity)

    await manager.subscribe(userClient, `agents:${squadAAgentIdentity.agentId}`)
    await manager.broadcast(`agents:${squadAAgentIdentity.agentId}`, 'execution.updated', {
      executionId: 'exec-1',
      agentId: squadAAgentIdentity.agentId,
      status: 'running',
    })

    expect(userWs.send).toHaveBeenCalledTimes(2)
  })

  test('blocks null-scope instance events when current topic owner is no longer accessible', async () => {
    await db.insert(squads).values({ id: squadAId, name: 'Squad A', purpose: 'test' }).onConflictDoNothing()
    await db.insert(squads).values({ id: squadBId, name: 'Squad B', purpose: 'test' }).onConflictDoNothing()
    await db
      .insert(agents)
      .values({ id: squadAAgentIdentity.agentId, agentTypeId: 'worker', squadId: squadAId })
      .onConflictDoNothing()

    const userWs = { send: mock(() => {}) } as any
    const userClient = manager.addClient(userWs, squadAAgentIdentity)

    await manager.subscribe(userClient, `agents:${squadAAgentIdentity.agentId}`)
    await db.update(agents).set({ squadId: squadBId }).where(eq(agents.id, squadAAgentIdentity.agentId))
    manager.invalidateAccessCache()
    await manager.broadcast(`agents:${squadAAgentIdentity.agentId}`, 'execution.updated', {
      executionId: 'exec-1',
      agentId: squadAAgentIdentity.agentId,
      status: 'running',
    })

    expect(userWs.send).toHaveBeenCalledTimes(1)
  })

  test('broadcasts global events but fails closed for missing agent collection events', async () => {
    const adminWs = { send: mock(() => {}) } as any
    const userWs = { send: mock(() => {}) } as any
    const adminClient = manager.addClient(adminWs, adminIdentity)
    const userClient = manager.addClient(userWs, squadAAgentIdentity)
    await manager.subscribe(adminClient, 'worker')
    await manager.subscribe(userClient, 'worker')
    await manager.broadcast('worker', 'worker.status', { status: 'ok' })
    expect(adminWs.send).toHaveBeenCalledTimes(2)
    expect(userWs.send).toHaveBeenCalledTimes(2)
    await manager.subscribe(adminClient, 'agents')
    await manager.subscribe(userClient, 'agents')
    await manager.broadcast('agents', 'message.created', { agentId: '11111111-1111-4111-8111-111111111112' })
    expect(adminWs.send).toHaveBeenCalledTimes(3)
    expect(userWs.send).toHaveBeenCalledTimes(3)
  })

  test('Activity subscription and delivery revalidate squads:read and redact per recipient', async () => {
    const identity = await activitySystemIdentity('activity-test', ['squads:read', 'workstreams:read'])
    const ws = openSocket()
    const client = manager.addClient(ws, identity)
    const topic = `squadActivity:${squadAId}`
    await manager.subscribe(client, topic)
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribed', topic }))
    ws.send.mockClear()
    await manager.broadcastActivity({
      squadId: squadAId,
      operation: 'upsert',
      item: {
        id: `30:${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        agentId: null,
        agentTypeId: 'engineer',
        kind: 'workstream',
        summary: '[ws-abcd created] See #241',
        preview: [{ text: '[ws-abcd created] See ' }, { text: '#241', bold: true, href: 'ficus:ws:241' }],
        ref: { type: 'workstream', workStreamId: crypto.randomUUID() },
      },
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: true,
    })
    const delivered = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(delivered.data.item.agentTypeId).toBeNull()
    expect(delivered.data.item.summary).toBe('[ws-abcd created] See #241')
    expect(delivered.data.item.preview).toEqual([
      { text: '[ws-abcd created] See ' },
      { text: '#241', bold: true, href: 'ficus:ws:241' },
    ])

    identity.scopes.splice(0)
    ws.send.mockClear()
    await manager.broadcastActivity({ ...delivered.data, squadId: squadAId })
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      event: 'squadActivity.accessRevoked',
      data: { squadId: squadAId },
    })
  })

  test('fences an in-flight old access result before a downgrade purge', async () => {
    const lookups: Array<ReturnType<typeof Promise.withResolvers<any>>> = []
    let initial = true
    const raceManager = new WebSocketManager(async () => {
      if (initial) {
        initial = false
        return { agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' as const } }
      }
      const lookup = Promise.withResolvers<any>()
      lookups.push(lookup)
      return lookup.promise
    })
    const identity = await activitySystemIdentity('activity-generation-race', [
      'squads:read',
      'agents:read',
      'workstreams:read',
    ])
    const ws = openSocket()
    const client = raceManager.addClient(ws, identity)
    const topic = `squadActivity:${squadAId}`
    await raceManager.subscribe(client, topic)
    ws.send.mockClear()
    const item = {
      id: `30:${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      agentId: null,
      agentTypeId: null,
      kind: 'workstream' as const,
      summary: '[ws stale]',
      preview: [{ text: '[ws stale]' }],
      ref: { type: 'workstream' as const, workStreamId: crypto.randomUUID() },
    }
    const broadcast = raceManager.broadcastActivity({
      squadId: squadAId,
      operation: 'upsert',
      item,
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    })
    expect(lookups).toHaveLength(1)
    const revalidation = raceManager.revalidateActivitySubscriptions(squadAId)
    expect(lookups).toHaveLength(2)

    lookups[0].resolve({ agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' } })
    await broadcast
    expect(ws.send).not.toHaveBeenCalled()
    lookups[1].resolve(null)
    await revalidation
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      event: 'squadActivity.accessRevoked',
      data: { squadId: squadAId },
    })
  })

  test('ignores an older overlapping Activity revalidation result', async () => {
    const lookups: Array<ReturnType<typeof Promise.withResolvers<any>>> = []
    let initial = true
    const raceManager = new WebSocketManager(async () => {
      if (initial) {
        initial = false
        return { agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' as const } }
      }
      const lookup = Promise.withResolvers<any>()
      lookups.push(lookup)
      return lookup.promise
    })
    const identity = await activitySystemIdentity('activity-overlap-race', ['squads:read', 'workstreams:read'])
    const ws = openSocket()
    const client = raceManager.addClient(ws, identity)
    await raceManager.subscribe(client, `squadActivity:${squadAId}`)
    ws.send.mockClear()
    const older = raceManager.revalidateActivitySubscriptions(squadAId)
    const newer = raceManager.revalidateActivitySubscriptions(squadAId)
    expect(lookups).toHaveLength(2)
    lookups[1].resolve(null)
    await newer
    lookups[0].resolve({ agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' } })
    await older
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(raceManager.getDiagnostics().subscriptions).toBe(0)
  })

  test('revokes Activity immediately when the squad is archived', async () => {
    const ws = openSocket()
    const client = manager.addClient(
      ws,
      await activitySystemIdentity('activity-archive-test', ['squads:read', 'workstreams:read'])
    )
    await manager.subscribe(client, `squadActivity:${squadAId}`)
    ws.send.mockClear()
    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, squadAId))
    await manager.revalidateActivitySubscriptions(squadAId)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(0)
  })

  test('revokes Activity immediately when the system token is revoked', async () => {
    const identity = await activitySystemIdentity('activity-revoked-token', ['squads:read', 'workstreams:read'])
    const ws = openSocket()
    const client = manager.addClient(ws, identity)
    await manager.subscribe(client, `squadActivity:${squadAId}`)
    ws.send.mockClear()
    await db.update(systemTokens).set({ revokedAt: new Date() }).where(eq(systemTokens.id, identity.systemTokenId))
    await manager.revalidateActivitySubscriptions(squadAId)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(0)
  })

  test('revokes Activity immediately when the subscribed agent is deleted', async () => {
    await db
      .insert(agentTypes)
      .values({
        id: activityReaderTypeId,
        name: 'Activity Reader',
        model: 'test:model',
        systemPrompt: 'test',
        extraScopes: ['squads:read', 'workstreams:read'],
      })
      .onConflictDoNothing()
    await db
      .insert(agents)
      .values({ id: squadAAgentIdentity.agentId, squadId: squadAId, agentTypeId: activityReaderTypeId })
      .onConflictDoNothing()
    const ws = openSocket()
    const client = manager.addClient(ws, squadAAgentIdentity)
    await manager.subscribe(client, `squadActivity:${squadAId}`)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ type: 'subscribed' })
    ws.send.mockClear()
    await db.delete(agents).where(eq(agents.id, squadAAgentIdentity.agentId))
    await manager.revalidateActivitySubscriptions(squadAId)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(0)
  })

  test('purges regular-agent Activity across inbox all to own to none transitions', async () => {
    await db
      .insert(agentTypes)
      .values({
        id: activityReaderTypeId,
        name: 'Activity Reader',
        model: 'test:model',
        systemPrompt: 'test',
        extraScopes: ['squads:read', 'workstreams:read', 'inbox:read-squad'],
      })
      .onConflictDoNothing()
    await db
      .insert(agents)
      .values({ id: squadAAgentIdentity.agentId, squadId: squadAId, agentTypeId: activityReaderTypeId })
      .onConflictDoNothing()
    const ws = openSocket()
    const client = manager.addClient(ws, squadAAgentIdentity)
    await manager.subscribe(client, `squadActivity:${squadAId}`)
    ws.send.mockClear()

    await db
      .update(agentTypes)
      .set({ extraScopes: ['squads:read', 'workstreams:read'] })
      .where(eq(agentTypes.id, activityReaderTypeId))
    await manager.revalidateActivitySubscriptions(squadAId)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(1)

    ws.send.mockClear()
    await db.delete(agents).where(eq(agents.id, squadAAgentIdentity.agentId))
    await manager.revalidateActivitySubscriptions(squadAId)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(0)
  })

  test('rejects malformed Activity topics and bounds denied-topic bookkeeping', async () => {
    let lookups = 0
    const boundedManager = new WebSocketManager(async () => {
      lookups++
      return null
    })
    const ws = openSocket()
    const client = boundedManager.addClient(ws, adminIdentity)
    await boundedManager.subscribe(client, 'squadActivity:not-a-uuid')
    expect(lookups).toBe(0)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ type: 'error' })
    ws.send.mockClear()
    for (let index = 0; index < 500; index++) {
      const squadId = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
      await boundedManager.subscribe(client, `squadActivity:${squadId}`)
      boundedManager.unsubscribe(client, `squadActivity:${squadId}`)
    }
    expect(lookups).toBe(500)
    expect(boundedManager.getDiagnostics()).toMatchObject({
      subscriptions: 0,
      activityAccessSignatures: 0,
      activityTopicGenerations: 0,
    })
  })

  test('coalesces duplicate pending Activity subscriptions into one lookup', async () => {
    const lookup = Promise.withResolvers<any>()
    let lookupCount = 0
    const coalescingManager = new WebSocketManager(async () => {
      lookupCount++
      return lookup.promise
    })
    const ws = openSocket()
    const client = coalescingManager.addClient(ws, adminIdentity)
    const topic = `squadActivity:${crypto.randomUUID()}`
    const subscriptions = Array.from({ length: 500 }, () => coalescingManager.subscribe(client, topic))
    expect(lookupCount).toBe(1)
    expect(coalescingManager.getDiagnostics().activityTopicGenerations).toBe(1)
    lookup.resolve(null)
    await Promise.all(subscriptions)
    expect(coalescingManager.getDiagnostics()).toMatchObject({ subscriptions: 0, activityTopicGenerations: 0 })
  })

  test('caps distinct pending Activity subscriptions and cleans them after denial', async () => {
    const lookups: Array<ReturnType<typeof Promise.withResolvers<any>>> = []
    const cappedManager = new WebSocketManager(async () => {
      const lookup = Promise.withResolvers<any>()
      lookups.push(lookup)
      return lookup.promise
    })
    const ws = openSocket()
    const client = cappedManager.addClient(ws, adminIdentity)
    const subscriptions = Array.from({ length: 65 }, () =>
      cappedManager.subscribe(client, `squadActivity:${crypto.randomUUID()}`)
    )
    expect(lookups).toHaveLength(64)
    expect(cappedManager.getDiagnostics().activityTopicGenerations).toBe(64)
    for (const lookup of lookups) lookup.resolve(null)
    await Promise.all(subscriptions)
    expect(cappedManager.getDiagnostics()).toMatchObject({ subscriptions: 0, activityTopicGenerations: 0 })
  })

  test('allows unrelated Activity subscriptions to authorize concurrently', async () => {
    const lookups = new Map<string, ReturnType<typeof Promise.withResolvers<any>>>()
    const concurrentManager = new WebSocketManager(async (_identity, squadId) => {
      const lookup = Promise.withResolvers<any>()
      lookups.set(squadId, lookup)
      return lookup.promise
    })
    const ws = openSocket()
    const client = concurrentManager.addClient(ws, adminIdentity)
    const squadA = crypto.randomUUID()
    const squadB = crypto.randomUUID()
    const first = concurrentManager.subscribe(client, `squadActivity:${squadA}`)
    const second = concurrentManager.subscribe(client, `squadActivity:${squadB}`)
    lookups.get(squadB)!.resolve({ agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' } })
    lookups.get(squadA)!.resolve({ agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' } })
    await Promise.all([first, second])
    expect(concurrentManager.getDiagnostics()).toMatchObject({
      subscriptions: 2,
      activityAccessSignatures: 2,
      activityTopicGenerations: 2,
    })
  })

  test('cleans pending Activity generations invalidated by revalidation', async () => {
    const lookup = Promise.withResolvers<any>()
    const pendingManager = new WebSocketManager(async () => lookup.promise)
    const ws = openSocket()
    const client = pendingManager.addClient(ws, adminIdentity)
    const squadId = crypto.randomUUID()
    const subscription = pendingManager.subscribe(client, `squadActivity:${squadId}`)
    expect(pendingManager.getDiagnostics().activityTopicGenerations).toBe(1)
    await pendingManager.revalidateActivitySubscriptions(squadId)
    expect(pendingManager.getDiagnostics().activityTopicGenerations).toBe(0)
    lookup.resolve({ agentsRead: true, workstreamsRead: true, inbox: { mode: 'none' } })
    await subscription
    expect(pendingManager.getDiagnostics()).toMatchObject({ subscriptions: 0, activityTopicGenerations: 0 })
  })

  test('contains asynchronous Activity subscription lookup failures', async () => {
    const failedManager = new WebSocketManager(async () => {
      throw new Error('database unavailable')
    })
    const ws = openSocket()
    failedManager.addClient(ws, adminIdentity)
    failedManager.handleMessage(
      ws,
      JSON.stringify({ type: 'subscribe', topic: `squadActivity:${crypto.randomUUID()}` })
    )
    for (let attempt = 0; attempt < 20 && ws.send.mock.calls.length === 0; attempt++) await Promise.resolve()
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      type: 'error',
      message: 'Subscription failed',
    })
    expect(failedManager.getDiagnostics().activityTopicGenerations).toBe(0)
  })

  test('denies Activity topic subscription without squads:read', async () => {
    const ws = openSocket()
    const client = manager.addClient(ws, await activitySystemIdentity('activity-denied', ['workstreams:read']))
    const topic = `squadActivity:${squadAId}`
    await manager.subscribe(client, topic)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ code: 'FORBIDDEN_TOPIC', topic })
  })

  test('purges on partial Activity signature changes and unsubscribes only after squad revocation', async () => {
    const scopes = ['squads:read', 'agents:read', 'workstreams:read', 'inbox:read']
    const identity = await activitySystemIdentity('activity-signature-test', scopes)
    const ws = openSocket()
    const client = manager.addClient(ws, identity)
    const topic = `squadActivity:${squadAId}`
    await manager.subscribe(client, topic)
    ws.send.mockClear()

    scopes.splice(scopes.indexOf('agents:read'), 1)
    manager.invalidateAccessCache()
    await waitForSentFrame(ws, 'squadActivity.accessRevoked for agents:read')
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      event: 'squadActivity.accessRevoked',
      data: { squadId: squadAId },
    })
    expect(manager.getDiagnostics().subscriptions).toBe(1)

    for (const permission of ['workstreams:read', 'inbox:read']) {
      ws.send.mockClear()
      scopes.splice(scopes.indexOf(permission), 1)
      manager.invalidateAccessCache()
      await waitForSentFrame(ws, `squadActivity.accessRevoked for ${permission}`)
      expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
        event: 'squadActivity.accessRevoked',
      })
      expect(manager.getDiagnostics().subscriptions).toBe(1)
    }

    ws.send.mockClear()
    scopes.splice(scopes.indexOf('squads:read'), 1)
    manager.invalidateAccessCache()
    await waitForSentFrame(ws, 'squadActivity.accessRevoked for squads:read')
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(0)
  })

  describe('Action Center invalidation', () => {
    test('allows only user identities to subscribe and sends an empty snapshot hint', async () => {
      const userWs = openSocket()
      const userClient = manager.addClient(userWs, { type: 'user', userId: ownerUserId })

      await manager.subscribe(userClient, 'actions')

      expect((userWs.send.mock.calls as Array<[string]>).map(([message]) => JSON.parse(message))).toEqual([
        { type: 'subscribed', topic: 'actions' },
        { type: 'event', topic: 'actions', event: 'actions.invalidated', data: {} },
      ])

      const forbiddenIdentities: Identity[] = [
        adminIdentity,
        squadAAgentIdentity,
        { type: 'system', systemTokenId: 'system', name: 'system', scopes: [] },
      ]
      for (const identity of forbiddenIdentities) {
        const ws = openSocket()
        const client = manager.addClient(ws, identity)
        await manager.subscribe(client, 'actions')
        expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toEqual({
          type: 'error',
          code: 'FORBIDDEN_TOPIC',
          topic: 'actions',
          message: 'Forbidden topic',
        })
      }
    })

    test('targets every live subscribed socket in the canonical user audience with no sensitive payload', async () => {
      const firstWs = openSocket()
      const secondWs = openSocket()
      const unrelatedWs = openSocket()
      const first = manager.addClient(firstWs, { type: 'user', userId: ownerUserId })
      const second = manager.addClient(secondWs, { type: 'user', userId: ownerUserId })
      const unrelated = manager.addClient(unrelatedWs, { type: 'user', userId: foreignUserId })
      await Promise.all([
        manager.subscribe(first, 'actions'),
        manager.subscribe(second, 'actions'),
        manager.subscribe(unrelated, 'actions'),
      ])
      firstWs.send.mockClear()
      secondWs.send.mockClear()
      unrelatedWs.send.mockClear()

      manager.broadcastActionCenterInvalidation([ownerUserId, ownerUserId])

      const expected = { type: 'event', topic: 'actions', event: 'actions.invalidated', data: {} }
      expect(JSON.parse(firstWs.send.mock.calls[0][0] as string)).toEqual(expected)
      expect(JSON.parse(secondWs.send.mock.calls[0][0] as string)).toEqual(expected)
      expect(unrelatedWs.send).not.toHaveBeenCalled()
      expect(firstWs.send.mock.calls[0][0] as string).not.toMatch(
        /questionId|answer|agentId|squadId|workStreamId|actionId|recipientId/
      )
    })

    test('continues canonical fanout after one audience socket send fails', async () => {
      let shouldThrow = false
      const failingWs = {
        readyState: WebSocket.OPEN,
        send: mock((_data: string) => {
          if (shouldThrow) throw new Error('socket closed')
          return 0
        }),
      } as any
      const healthyWs = openSocket()
      const failing = manager.addClient(failingWs, { type: 'user', userId: ownerUserId })
      const healthy = manager.addClient(healthyWs, { type: 'user', userId: ownerUserId })
      await manager.subscribe(failing, 'actions')
      await manager.subscribe(healthy, 'actions')
      failingWs.send.mockClear()
      healthyWs.send.mockClear()
      shouldThrow = true

      expect(() => manager.broadcastActionCenterInvalidation([ownerUserId])).not.toThrow()

      expect(healthyWs.send).toHaveBeenCalledTimes(1)
      expect(manager.getClientByWs(failingWs)).toBeUndefined()
    })

    test('fails closed through generic broadcast', async () => {
      const ws = openSocket()
      const client = manager.addClient(ws, { type: 'user', userId: ownerUserId })
      await manager.subscribe(client, 'actions')
      ws.send.mockClear()
      ;(manager as any).canReceive = mock(async () => true)

      await manager.broadcast('actions', 'actions.invalidated', {})

      expect(ws.send).not.toHaveBeenCalled()
    })

    test('fences unsubscribe, disconnect, and replacement registrations', async () => {
      const oldWs = openSocket()
      const oldClient = manager.addClient(oldWs, { type: 'user', userId: ownerUserId })
      await manager.subscribe(oldClient, 'actions')
      oldWs.send.mockClear()
      manager.unsubscribe(oldClient, 'actions')
      manager.broadcastActionCenterInvalidation([ownerUserId])
      expect(oldWs.send).toHaveBeenCalledTimes(1)

      oldWs.send.mockClear()
      manager.removeClient(oldClient)
      ;(manager as any).clientIdCounter -= 1
      const replacementWs = openSocket()
      const replacement = manager.addClient(replacementWs, { type: 'user', userId: ownerUserId })
      expect(replacement).toBe(oldClient)
      manager.broadcastActionCenterInvalidation([ownerUserId])
      expect(oldWs.send).not.toHaveBeenCalled()
      expect(replacementWs.send).not.toHaveBeenCalled()

      await manager.subscribe(replacement, 'actions')
      replacementWs.send.mockClear()
      manager.broadcastActionCenterInvalidation([ownerUserId])
      expect(replacementWs.send).toHaveBeenCalledTimes(1)
      replacementWs.readyState = WebSocket.CLOSED
      manager.broadcastActionCenterInvalidation([ownerUserId])
      expect(replacementWs.send).toHaveBeenCalledTimes(1)
    })
  })

  test('turns a newly hidden tombstone into a purge instead of preserving stale Activity', async () => {
    const scopes = ['squads:read', 'workstreams:read']
    const ws = openSocket()
    const client = manager.addClient(ws, await activitySystemIdentity('activity-tombstone-test', scopes))
    const topic = `squadActivity:${squadAId}`
    await manager.subscribe(client, topic)
    ws.send.mockClear()
    scopes.splice(scopes.indexOf('workstreams:read'), 1)
    await manager.broadcastActivity({
      squadId: squadAId,
      operation: 'delete',
      item: {
        id: `30:${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        agentId: null,
        agentTypeId: null,
        kind: 'workstream',
        summary: '[ws-abcd deleted]',
        preview: [{ text: '[ws-abcd deleted]' }],
        ref: { type: 'workstream', workStreamId: crypto.randomUUID() },
      },
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    })
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({ event: 'squadActivity.accessRevoked' })
    expect(manager.getDiagnostics().subscriptions).toBe(1)
  })
})

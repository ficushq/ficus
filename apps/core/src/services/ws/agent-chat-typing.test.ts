import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { UNNAMED_PERSON } from '@ficus/shared'
import { agents, db, squads } from '../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import {
  AgentChatTypingRegistry,
  AGENT_CHAT_TYPING_HEARTBEAT_GAP_MS,
  type AgentChatTypingStop,
} from './agent-chat-typing'
import { WebSocketManager } from './manager'

describe('AgentChatTypingRegistry', () => {
  function registry(
    options: { ttlMs?: number; onExpire?: (clientId: string, stop: AgentChatTypingStop) => void } = {}
  ) {
    let now = 1_000_000
    const typing = new AgentChatTypingRegistry({
      ttlMs: options.ttlMs ?? 60_000,
      now: () => now,
      onExpire: options.onExpire ?? (() => {}),
    })
    return { typing, advance: (ms: number) => (now += ms) }
  }

  test('passes on the first typing straight away, then at most one heartbeat per gap', () => {
    const { typing, advance } = registry()
    const first = typing.typing('c1', 'u1', 'a1')
    expect(first).toMatchObject({ agentId: 'a1', userId: 'u1' })
    expect(typing.typing('c1', 'u1', 'a1')).toBeNull()
    advance(AGENT_CHAT_TYPING_HEARTBEAT_GAP_MS - 1)
    expect(typing.typing('c1', 'u1', 'a1')).toBeNull()
    advance(1)
    // The same entry again: still the same typing, just "still typing".
    expect(typing.typing('c1', 'u1', 'a1')).toBe(first!)
    expect(typing.size()).toBe(1)
    withdrawAll(typing, ['c1'])
  })

  test('a flood of starts and stops is bounded by the per-connection budget', () => {
    const { typing } = registry()
    let passed = 0
    let stops = 0
    for (let i = 0; i < 1_000; i++) {
      const entry = typing.typing('c1', 'u1', 'a1')
      if (entry) {
        passed++
        typing.delivered(entry)
      }
      if (typing.stop('c1', 'a1')) stops++
    }
    expect(passed).toBe(5)
    expect(stops).toBe(5)
    withdrawAll(typing, ['c1'])
  })

  test('a stop is passed on only for delivered typing, once the person has no other tab typing there', () => {
    const { typing } = registry()
    // Never delivered (still being checked, or refused): nothing to take back.
    typing.typing('c1', 'u1', 'a1')
    expect(typing.stop('c1', 'a1')).toBeNull()

    const tab1 = typing.typing('c1', 'u1', 'a1')!
    const tab2 = typing.typing('c2', 'u1', 'a1')!
    typing.delivered(tab1)
    typing.delivered(tab2)
    expect(typing.isCurrent('c1', tab1)).toBe(true)
    expect(typing.withdraw('c1')).toEqual([])
    expect(typing.isCurrent('c1', tab1)).toBe(false)
    expect(typing.stop('c2', 'a1')).toEqual({ agentId: 'a1', userId: 'u1' })
    expect(typing.stop('c2', 'a1')).toBeNull()
    expect(typing.size()).toBe(0)
  })

  test('a connection that goes quiet stops typing after the TTL', async () => {
    const expired: Array<[string, AgentChatTypingStop]> = []
    const { typing } = registry({ ttlMs: 20, onExpire: (clientId, stop) => expired.push([clientId, stop]) })
    typing.delivered(typing.typing('c1', 'u1', 'a1')!)
    typing.typing('c1', 'u1', 'a2') // never delivered: expires silently
    await Bun.sleep(60)
    expect(expired).toEqual([['c1', { agentId: 'a1', userId: 'u1' }]])
    expect(typing.size()).toBe(0)
  })

  function withdrawAll(typing: AgentChatTypingRegistry, clientIds: string[]) {
    for (const clientId of clientIds) typing.withdraw(clientId)
  }
})

const prefix = `agent-typing-${crypto.randomUUID()}`
const SQUAD_ID = crypto.randomUUID()
const AGENT_ID = crypto.randomUUID()
/** One of a user's Assistant agents running in the squad: private to its owner. */
const ASSISTANT_AGENT_ID = crypto.randomUUID()
/** An owner-scoped agent (a user's system manager): private to its owner. */
const PRIVATE_AGENT_ID = crypto.randomUUID()
const AGENT_TOPIC = `agents:${AGENT_ID}`

/** Squad members who may read the agent's chat. */
let alice: TestUser
let bob: TestUser
/** A squad member who may also see emails (users:read). */
let carol: TestUser
/** A squad member with no display name. */
let dave: TestUser
/** No access to the squad. */
let outsider: TestUser

function socket() {
  return { readyState: WebSocket.OPEN, send: mock((_data: string) => 0) } as any
}

type Frame = { type: string; event?: string; topic?: string; data?: any; message?: string }
const frames = (ws: ReturnType<typeof socket>): Frame[] =>
  ws.send.mock.calls.map((call: [string]) => JSON.parse(call[0]))
const typingEvents = (ws: ReturnType<typeof socket>) =>
  frames(ws)
    .filter((frame) => frame.event === 'agentChat.typing')
    .map((frame) => frame.data)

function typing(
  manager: WebSocketManager,
  ws: ReturnType<typeof socket>,
  isTyping: boolean,
  agentId: string = AGENT_ID
) {
  manager.handleMessage(ws, JSON.stringify({ type: 'agentChat.typing', agentId, typing: isTyping }))
}

/** A user's connection reading an agent's chat. */
async function reader(manager: WebSocketManager, user: TestUser, topic: string = AGENT_TOPIC) {
  const ws = socket()
  const clientId = manager.addClient(ws, { type: 'user', userId: user.id })
  await manager.subscribe(clientId, topic)
  expect(frames(ws)).toContainEqual({ type: 'subscribed', topic })
  return ws
}

/** A connection that is subscribed to the topic without being allowed to read it (as if access was just lost). */
function staleReader(
  manager: WebSocketManager,
  identity: Parameters<WebSocketManager['addClient']>[1],
  topic = AGENT_TOPIC
) {
  const ws = socket()
  const clientId = manager.addClient(ws, identity)
  ;(manager as unknown as { clients: Map<string, { subscriptions: Set<string> }> }).clients
    .get(clientId)!
    .subscriptions.add(topic)
  return ws
}

beforeAll(async () => {
  alice = await createTestUser({ prefix, displayName: 'Alice' })
  bob = await createTestUser({ prefix, displayName: 'Bob' })
  carol = await createTestUser({ prefix, displayName: 'Carol' })
  dave = await createTestUser({ prefix, displayName: '' })
  outsider = await createTestUser({ prefix, displayName: 'Outsider' })
  await db.insert(squads).values({ id: SQUAD_ID, name: `Typing ${prefix}`, purpose: 'test' })
  await db.insert(agents).values([
    { id: AGENT_ID, agentTypeId: 'worker', squadId: SQUAD_ID },
    { id: ASSISTANT_AGENT_ID, agentTypeId: 'assistant-worker', squadId: SQUAD_ID },
    { id: PRIVATE_AGENT_ID, agentTypeId: 'system-manager', ownerUserId: alice.id },
  ])
  const member = await createTestRole({ prefix, permissions: ['squads:read', 'agents:read'] })
  for (const user of [alice, bob, carol, dave])
    await assignRole({ userId: user.id, roleId: member.id, scope: 'squad', squadId: SQUAD_ID })
  const directory = await createTestRole({ prefix, permissions: ['users:read'] })
  await assignRole({ userId: carol.id, roleId: directory.id, scope: 'system' })
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [AGENT_ID, ASSISTANT_AGENT_ID, PRIVATE_AGENT_ID]))
  await db.delete(squads).where(inArray(squads.id, [SQUAD_ID]))
  await cleanupTestRbac(prefix)
})

describe('typing in agent chats over the WebSocket', () => {
  test("reaches the chat's other readers with the typer's name, never the typer, outsiders or agents", async () => {
    const manager = new WebSocketManager()
    const aliceWs = await reader(manager, alice)
    const aliceOtherTab = await reader(manager, alice)
    const bobWs = await reader(manager, bob)
    const outsiderWs = staleReader(manager, { type: 'user', userId: outsider.id })
    const agentWs = staleReader(manager, { type: 'agent', agentId: AGENT_ID, squadId: SQUAD_ID } as any)

    typing(manager, aliceWs, true)
    await manager.settled()
    // Only the agent id, the typer and their name, and the state: never any draft text.
    expect(typingEvents(bobWs)).toEqual([{ agentId: AGENT_ID, userId: alice.id, typing: true, name: 'Alice' }])
    expect(frames(bobWs).at(-1)).toMatchObject({ type: 'event', topic: AGENT_TOPIC, event: 'agentChat.typing' })
    expect(typingEvents(aliceWs)).toEqual([])
    expect(typingEvents(aliceOtherTab)).toEqual([])
    expect(typingEvents(outsiderWs)).toEqual([])
    expect(typingEvents(agentWs)).toEqual([])

    typing(manager, aliceWs, false)
    await manager.settled()
    expect(typingEvents(bobWs).at(-1)).toEqual({ agentId: AGENT_ID, userId: alice.id, typing: false })
    expect(typingEvents(outsiderWs)).toEqual([])
    expect(typingEvents(agentWs)).toEqual([])
  })

  test('several people typing at once each reach everyone else', async () => {
    const manager = new WebSocketManager()
    const aliceWs = await reader(manager, alice)
    const bobWs = await reader(manager, bob)
    const carolWs = await reader(manager, carol)
    typing(manager, aliceWs, true)
    typing(manager, bobWs, true)
    await manager.settled()
    expect(typingEvents(carolWs).map((data) => data.name)).toEqual(['Alice', 'Bob'])
    expect(typingEvents(aliceWs).map((data) => data.userId)).toEqual([bob.id])
    expect(typingEvents(bobWs).map((data) => data.userId)).toEqual([alice.id])
  })

  test("shows someone's email only to readers who may see emails", async () => {
    const manager = new WebSocketManager()
    const daveWs = await reader(manager, dave)
    const bobWs = await reader(manager, bob)
    const carolWs = await reader(manager, carol)
    typing(manager, daveWs, true)
    await manager.settled()
    expect(typingEvents(carolWs)[0]!.name).toBe(dave.email)
    expect(typingEvents(bobWs)[0]!.name).toBe(UNNAMED_PERSON)
    expect(JSON.stringify(frames(bobWs))).not.toContain(dave.email)
  })

  test('someone who may not read the chat cannot say they are typing in it; agents are ignored', async () => {
    const manager = new WebSocketManager()
    const bobWs = await reader(manager, bob)
    const outsiderWs = staleReader(manager, { type: 'user', userId: outsider.id })
    typing(manager, outsiderWs, true)
    const agentWs = staleReader(manager, {
      type: 'agent',
      agentId: AGENT_ID,
      squadId: SQUAD_ID,
      userId: alice.id,
    } as any)
    typing(manager, agentWs, true)
    await manager.settled()
    expect(typingEvents(bobWs)).toEqual([])
  })

  test('private conversations never share typing: Assistant agents and owner-scoped agents', async () => {
    const manager = new WebSocketManager()
    const assistantTopic = `agents:${ASSISTANT_AGENT_ID}`
    const aliceWs = await reader(manager, alice, assistantTopic)
    const bobWs = await reader(manager, bob, assistantTopic)
    typing(manager, aliceWs, true, ASSISTANT_AGENT_ID)
    typing(manager, bobWs, true, ASSISTANT_AGENT_ID)
    // Even someone subscribed to the private agent's topic hears nothing.
    const privateTopic = `agents:${PRIVATE_AGENT_ID}`
    const aliceTab = await reader(manager, alice, privateTopic)
    const bobPrivate = staleReader(manager, { type: 'user', userId: bob.id }, privateTopic)
    typing(manager, aliceTab, true, PRIVATE_AGENT_ID)
    await manager.settled()
    for (const ws of [aliceWs, bobWs, aliceTab, bobPrivate]) expect(typingEvents(ws)).toEqual([])
  })

  test("closing a typer's last tab stops their typing for everyone else", async () => {
    const manager = new WebSocketManager()
    const aliceWs = await reader(manager, alice)
    const aliceOtherTab = await reader(manager, alice)
    const bobWs = await reader(manager, bob)
    typing(manager, aliceWs, true)
    typing(manager, aliceOtherTab, true)
    await manager.settled()
    expect(typingEvents(bobWs).map((data) => data.typing)).toEqual([true, true])

    // Another tab of theirs is still typing there: still typing.
    manager.removeByWs(aliceWs)
    await manager.settled()
    expect(typingEvents(bobWs).map((data) => data.typing)).toEqual([true, true])

    manager.removeByWs(aliceOtherTab, { code: 1006, reason: '' }, 'error')
    await manager.settled()
    expect(typingEvents(bobWs).at(-1)).toEqual({ agentId: AGENT_ID, userId: alice.id, typing: false })
  })

  test('a typer who goes quiet stops after the TTL', async () => {
    const manager = new WebSocketManager(undefined, { agentChatTypingTtlMs: 40 })
    const aliceWs = await reader(manager, alice)
    const bobWs = await reader(manager, bob)
    typing(manager, aliceWs, true)
    await manager.settled()
    expect(typingEvents(bobWs)).toHaveLength(1)
    const deadline = Date.now() + 2_000
    while (typingEvents(bobWs).length < 2 && Date.now() < deadline) await Bun.sleep(5)
    await manager.settled()
    expect(typingEvents(bobWs)).toEqual([
      expect.objectContaining({ typing: true }),
      { agentId: AGENT_ID, userId: alice.id, typing: false },
    ])
  })

  test('a flood of typing messages becomes a bounded number of broadcasts', async () => {
    const manager = new WebSocketManager()
    const aliceWs = await reader(manager, alice)
    const bobWs = await reader(manager, bob)
    for (let i = 0; i < 500; i++) typing(manager, aliceWs, true)
    await manager.settled()
    expect(typingEvents(bobWs)).toHaveLength(1)

    // Toggling as fast as possible: a few starts and their stops, then nothing.
    for (let i = 0; i < 500; i++) {
      typing(manager, aliceWs, false)
      typing(manager, aliceWs, true)
    }
    await manager.settled()
    expect(typingEvents(bobWs).length).toBeLessThanOrEqual(10)
  })

  test('rejects malformed typing messages', async () => {
    const manager = new WebSocketManager()
    const aliceWs = await reader(manager, alice)
    typing(manager, aliceWs, true, 'not-a-uuid')
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'agentChat.typing', agentId: AGENT_ID, typing: 'yes' }))
    await manager.settled()
    expect(frames(aliceWs).filter((frame) => frame.type === 'error')).toEqual([
      { type: 'error', message: 'Invalid typing' },
      { type: 'error', message: 'Invalid typing' },
    ])
  })
})

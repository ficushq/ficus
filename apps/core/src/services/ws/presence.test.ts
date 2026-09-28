import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads } from '../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { WebSocketManager } from './manager'
import { PresenceRegistry } from './presence'

const SQUAD = { kind: 'squad' as const, squadId: '9a0a4f0e-8b0e-4c3d-9f6a-1d2e3f4a5b6c' }
const OTHER = { kind: 'squad' as const, squadId: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b' }

describe('PresenceRegistry', () => {
  test('a person shows their latest focus across connections and leaves with their last one', () => {
    const registry = new PresenceRegistry()
    expect(registry.announce('c1', 'u1', null, 1)).toEqual({ userId: 'u1', focus: null, since: 1 })
    // The same focus again changes nothing.
    expect(registry.announce('c1', 'u1', null, 2)).toBeNull()
    expect(registry.announce('c2', 'u1', SQUAD, 3)).toEqual({ userId: 'u1', focus: SQUAD, since: 3 })
    // Closing the tab with the latest focus falls back to the other one.
    expect(registry.withdraw('c2')).toEqual({ person: { userId: 'u1', focus: null, since: 1 } })
    expect(registry.withdraw('c1')).toEqual({ left: 'u1' })
    expect(registry.withdraw('c1')).toBeNull()
    expect(registry.people()).toEqual([])
  })

  test('lists everyone present', () => {
    const registry = new PresenceRegistry()
    registry.announce('c1', 'u1', SQUAD, 1)
    registry.announce('c2', 'u2', null, 2)
    expect(
      registry
        .people()
        .map((person) => person.userId)
        .sort()
    ).toEqual(['u1', 'u2'])
  })
})

const prefix = `presence-${crypto.randomUUID()}`
let alice: TestUser
let bob: TestUser

function socket() {
  return { readyState: WebSocket.OPEN, send: mock((_data: string) => 0) } as any
}

type Frame = { type: string; event?: string; data?: any; code?: string; message?: string }
const frames = (ws: ReturnType<typeof socket>): Frame[] =>
  ws.send.mock.calls.map((call: [string]) => JSON.parse(call[0]))
const events = (ws: ReturnType<typeof socket>, event: string) => frames(ws).filter((frame) => frame.event === event)

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(1)
  }
}

beforeAll(async () => {
  alice = await createTestUser({ prefix, displayName: 'Alice' })
  bob = await createTestUser({ prefix, displayName: '' })
  await db.insert(squads).values({ id: SQUAD.squadId, name: `Presence ${prefix}`, purpose: 'test' })
  await db.insert(squads).values({ id: OTHER.squadId, name: `Presence other ${prefix}`, purpose: 'test' })
  // Bob can see the first squad only.
  const role = await createTestRole({ prefix, permissions: ['squads:read', 'agents:read'] })
  await assignRole({ userId: bob.id, roleId: role.id, scope: 'squad', squadId: SQUAD.squadId })
})

afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, SQUAD.squadId))
  await db.delete(squads).where(eq(squads.id, OTHER.squadId))
  await cleanupTestRbac(prefix)
})

describe('farm presence over the WebSocket', () => {
  test('others see you arrive, move and leave, with only the focus they may see', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    const bobClient = manager.addClient(bobWs, { type: 'user', userId: bob.id })
    await manager.subscribe(bobClient, 'presence')
    expect(events(bobWs, 'presence.snapshot')[0]?.data).toEqual({ people: [] })

    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: SQUAD }))
    await until(() => events(bobWs, 'presence.updated').length === 1, 'the first update')
    expect(events(bobWs, 'presence.updated')[0]!.data.person).toMatchObject({
      userId: alice.id,
      name: 'Alice',
      focus: SQUAD,
    })

    // A squad Bob can't see: he sees Alice, but only "around the farm".
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: OTHER }))
    await until(() => events(bobWs, 'presence.updated').length === 2, 'the second update')
    expect(events(bobWs, 'presence.updated')[1]!.data.person).toMatchObject({ userId: alice.id, focus: null })

    // Alice never hears about herself.
    expect(events(aliceWs, 'presence.updated')).toEqual([])

    manager.removeByWs(aliceWs)
    await until(() => events(bobWs, 'presence.left').length === 1, 'the leave')
    expect(events(bobWs, 'presence.left')[0]!.data).toEqual({ userId: alice.id })
  })

  test('a newcomer gets everyone already there; names fall back to email', async () => {
    const manager = new WebSocketManager()
    const bobWs = socket()
    const aliceWs = socket()
    manager.addClient(bobWs, { type: 'user', userId: bob.id })
    manager.handleMessage(bobWs, JSON.stringify({ type: 'presence', focus: null }))
    const aliceClient = manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    await manager.subscribe(aliceClient, 'presence')
    await until(() => events(aliceWs, 'presence.snapshot').length === 1, 'the snapshot')
    expect(events(aliceWs, 'presence.snapshot')[0]!.data.people).toEqual([
      expect.objectContaining({ userId: bob.id, name: bob.email, focus: null }),
    ])
  })

  test('leaving for single-player takes you off the farm; a second tab keeps you on it', async () => {
    const manager = new WebSocketManager()
    const tab1 = socket()
    const tab2 = socket()
    const bobWs = socket()
    manager.addClient(tab1, { type: 'user', userId: alice.id })
    manager.addClient(tab2, { type: 'user', userId: alice.id })
    const bobClient = manager.addClient(bobWs, { type: 'user', userId: bob.id })
    await manager.subscribe(bobClient, 'presence')
    manager.handleMessage(tab1, JSON.stringify({ type: 'presence', focus: null }))
    manager.handleMessage(tab2, JSON.stringify({ type: 'presence', focus: null }))
    await until(() => events(bobWs, 'presence.updated').length >= 1, 'the arrival')
    // A leave is sent synchronously, so its absence is checkable straight away.
    manager.handleMessage(tab1, JSON.stringify({ type: 'presence.leave' }))
    expect(events(bobWs, 'presence.left')).toEqual([])
    manager.handleMessage(tab2, JSON.stringify({ type: 'presence.leave' }))
    await until(() => events(bobWs, 'presence.left').length === 1, 'the leave')
  })

  test('only people may subscribe or announce; malformed focus is refused', async () => {
    const manager = new WebSocketManager()
    const agentWs = socket()
    const agentClient = manager.addClient(agentWs, {
      type: 'agent',
      agentId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b',
      squadId: SQUAD.squadId,
    })
    await manager.subscribe(agentClient, 'presence')
    await manager.subscribe(agentClient, 'farmChat')
    expect(frames(agentWs).filter((frame) => frame.code === 'FORBIDDEN_TOPIC')).toHaveLength(2)
    manager.handleMessage(agentWs, JSON.stringify({ type: 'presence', focus: null }))
    expect(frames(agentWs).at(-1)).toMatchObject({ type: 'error' })

    const aliceWs = socket()
    manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: { kind: 'squad', squadId: 'nope' } }))
    expect(frames(aliceWs).at(-1)).toEqual({ type: 'error', message: 'Invalid presence' })
  })

  test('farm chat reaches everyone subscribed, or only the people in a DM', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    await manager.subscribe(manager.addClient(aliceWs, { type: 'user', userId: alice.id }), 'farmChat')
    await manager.subscribe(manager.addClient(bobWs, { type: 'user', userId: bob.id }), 'farmChat')
    manager.sendFarmChat('farmChat.roomsChanged', {})
    expect(events(aliceWs, 'farmChat.roomsChanged')).toHaveLength(1)
    expect(events(bobWs, 'farmChat.roomsChanged')).toHaveLength(1)
    manager.sendFarmChat('farmChat.messageCreated', { message: { id: 'm' } }, [alice.id])
    expect(events(aliceWs, 'farmChat.messageCreated')).toHaveLength(1)
    expect(events(bobWs, 'farmChat.messageCreated')).toHaveLength(0)
  })
})

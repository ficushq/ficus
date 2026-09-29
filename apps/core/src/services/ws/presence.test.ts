import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { UNNAMED_PERSON, type FarmLook } from '@ficus/shared'
import { db, farmPreferences, roleAssignments, squads } from '../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { WebSocketManager } from './manager'
import { PresenceRegistry } from './presence'
import { directRoom, ensureGeneralRoom } from '../farm-chat'

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
/** farm:read only: sees the farm, never appears on it. */
let viewer: TestUser
/** No farm permissions. */
let outsider: TestUser

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
  // Both are on the farm (farm permissions are instance-wide, whatever their squad roles).
  const farm = await createTestRole({ prefix, permissions: ['farm:read', 'farm:chat'] })
  for (const user of [alice, bob]) await assignRole({ userId: user.id, roleId: farm.id, scope: 'system' })
  viewer = await createTestUser({ prefix, displayName: 'Viewer' })
  const reads = await createTestRole({ prefix, permissions: ['farm:read'] })
  await assignRole({ userId: viewer.id, roleId: reads.id, scope: 'system' })
  outsider = await createTestUser({ prefix, displayName: 'Outsider' })
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

  test('a newcomer gets everyone already there; no email for someone unnamed', async () => {
    const manager = new WebSocketManager()
    const bobWs = socket()
    const aliceWs = socket()
    manager.addClient(bobWs, { type: 'user', userId: bob.id })
    manager.handleMessage(bobWs, JSON.stringify({ type: 'presence', focus: null }))
    await manager.settled()
    const aliceClient = manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    await manager.subscribe(aliceClient, 'presence')
    await until(() => events(aliceWs, 'presence.snapshot').length === 1, 'the snapshot')
    expect(events(aliceWs, 'presence.snapshot')[0]!.data.people).toEqual([
      expect.objectContaining({ userId: bob.id, name: UNNAMED_PERSON, focus: null }),
    ])
    expect(JSON.stringify(frames(aliceWs))).not.toContain(bob.email)
  })

  test('a flood of presence changes is rate-limited per connection', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    const bobClient = manager.addClient(bobWs, { type: 'user', userId: bob.id })
    await manager.subscribe(bobClient, 'presence')
    for (let k = 0; k < 40; k++)
      manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: k % 2 ? SQUAD : OTHER }))
    await manager.settled()
    // A burst of 5 gets through (a little more may refill while they're sent), not 40.
    expect(events(bobWs, 'presence.updated').length).toBeLessThanOrEqual(7)
    expect(events(bobWs, 'presence.updated').length).toBeGreaterThanOrEqual(1)
  })

  test('farm:read sees the farm but never appears on it or waves; no farm permission, not even that', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const viewerWs = socket()
    const outsiderWs = socket()
    const aliceClient = manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    const viewerClient = manager.addClient(viewerWs, { type: 'user', userId: viewer.id })
    const outsiderClient = manager.addClient(outsiderWs, { type: 'user', userId: outsider.id })
    await manager.subscribe(aliceClient, 'presence')
    await manager.subscribe(viewerClient, 'presence')
    await manager.subscribe(outsiderClient, 'presence')
    await manager.subscribe(outsiderClient, 'farmChat')
    expect(frames(outsiderWs).filter((frame) => frame.code === 'FORBIDDEN_TOPIC')).toHaveLength(2)
    expect(events(viewerWs, 'presence.snapshot')).toHaveLength(1)

    manager.handleMessage(viewerWs, JSON.stringify({ type: 'presence', focus: null }))
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: null }))
    await manager.settled()
    manager.handleMessage(viewerWs, JSON.stringify({ type: 'presence.wave', toUserId: alice.id }))
    await manager.settled()
    // Alice only ever sees... nobody: the viewer never appeared, and its wave went nowhere.
    expect(events(aliceWs, 'presence.updated')).toEqual([])
    expect(events(aliceWs, 'presence.waved')).toEqual([])
    // The viewer still sees Alice arrive.
    expect(events(viewerWs, 'presence.updated').map((frame) => frame.data.person.userId)).toEqual([alice.id])
  })

  test('a wave reaches everyone else on the farm, only between people there, and not too often', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    const aliceClient = manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    const bobClient = manager.addClient(bobWs, { type: 'user', userId: bob.id })
    await manager.subscribe(aliceClient, 'presence')
    await manager.subscribe(bobClient, 'presence')
    const wave = (ws: ReturnType<typeof socket>, toUserId: unknown) =>
      manager.handleMessage(ws, JSON.stringify({ type: 'presence.wave', toUserId }))

    // Nobody's on the farm yet: nothing to wave at, or from.
    wave(aliceWs, bob.id)
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: null }))
    await manager.settled()
    wave(aliceWs, bob.id)
    await manager.settled()
    expect(events(bobWs, 'presence.waved')).toEqual([])

    manager.handleMessage(bobWs, JSON.stringify({ type: 'presence', focus: null }))
    await manager.settled()
    wave(aliceWs, bob.id)
    await manager.settled()
    expect(events(bobWs, 'presence.waved').map((frame) => frame.data)).toEqual([
      { fromUserId: alice.id, toUserId: bob.id },
    ])
    // The waver's own farm shows it already; and a second wave straight after is dropped.
    expect(events(aliceWs, 'presence.waved')).toEqual([])
    wave(aliceWs, bob.id)
    await manager.settled()
    expect(events(bobWs, 'presence.waved')).toHaveLength(1)
    // Nor at yourself, or at nonsense.
    wave(bobWs, bob.id)
    wave(bobWs, { id: alice.id })
    await manager.settled()
    expect(events(aliceWs, 'presence.waved')).toEqual([])
    wave(bobWs, alice.id)
    await manager.settled()
    expect(events(aliceWs, 'presence.waved').map((frame) => frame.data)).toEqual([
      { fromUserId: bob.id, toUserId: alice.id },
    ])
  })

  test('people are seen as they chose to look, and a new look shows straight away', async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    manager.addClient(aliceWs, { type: 'user', userId: alice.id })
    const bobClient = manager.addClient(bobWs, { type: 'user', userId: bob.id })
    await manager.subscribe(bobClient, 'presence')
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: null }))
    await until(() => events(bobWs, 'presence.updated').length === 1, 'the arrival')
    // No look chosen yet: the farm picks one.
    expect(events(bobWs, 'presence.updated')[0]!.data.person.look).toBeNull()

    const look: FarmLook = {
      skin: '#8d5a3b',
      hair: 'afro',
      hairColor: '#2a211c',
      hat: 'cowboy',
      hatColor: '#6b5a45',
      shirt: 'flannel',
      shirtColor: '#e36c5a',
      pants: 'long',
      pantsColor: '#4b5d7a',
      shoes: 'boots',
      shoesColor: '#5a3a24',
      piercings: ['ears'],
    }
    await db.insert(farmPreferences).values({ userId: alice.id, settings: { look } })
    manager.refreshPresence(alice.id)
    await until(() => events(bobWs, 'presence.updated').length === 2, 'the new look')
    expect(events(bobWs, 'presence.updated')[1]!.data.person).toMatchObject({ userId: alice.id, look })
    // Someone who isn't on the farm changes nothing.
    manager.refreshPresence(bob.id)
    expect(events(aliceWs, 'presence.updated')).toEqual([])
    await db.delete(farmPreferences).where(eq(farmPreferences.userId, alice.id))
    manager.refreshPresence(alice.id)
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

  test("typing reaches the room's other people, a DM's other person, never yourself, and not too often", async () => {
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const bobWs = socket()
    await manager.subscribe(manager.addClient(aliceWs, { type: 'user', userId: alice.id }), 'farmChat')
    await manager.subscribe(manager.addClient(bobWs, { type: 'user', userId: bob.id }), 'farmChat')
    const general = await ensureGeneralRoom()
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'farmChat.typing', roomId: general.id }))
    await until(() => events(bobWs, 'farmChat.typing').length === 1, 'the typing ping')
    expect(events(bobWs, 'farmChat.typing')[0]!.data).toEqual({ roomId: general.id, userId: alice.id })
    expect(events(aliceWs, 'farmChat.typing')).toEqual([])
    // Again straight away: held back (one every couple of seconds per room).
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'farmChat.typing', roomId: general.id }))
    const dm = await directRoom(alice.id, bob.id)
    manager.handleMessage(bobWs, JSON.stringify({ type: 'farmChat.typing', roomId: dm.id }))
    await until(() => events(aliceWs, 'farmChat.typing').length === 1, 'the DM typing ping')
    expect(events(bobWs, 'farmChat.typing')).toHaveLength(1)
    // Someone outside the DM can't say they're typing in it.
    const carol = await createTestUser({ prefix, displayName: 'Carol' })
    const carolWs = socket()
    await manager.subscribe(manager.addClient(carolWs, { type: 'user', userId: carol.id }), 'farmChat')
    await (manager as unknown as { farmChatTyping: (c: unknown, r: string) => Promise<void> }).farmChatTyping(
      manager.getClientByWs(carolWs),
      dm.id
    )
    expect(events(aliceWs, 'farmChat.typing')).toHaveLength(1)
    expect(events(bobWs, 'farmChat.typing')).toHaveLength(1)
  })

  test('losing the farm takes effect straight away: no more farm chat or presence, and off the farm', async () => {
    const carol = await createTestUser({ prefix, displayName: 'Carol' })
    const farm = await createTestRole({ prefix, permissions: ['farm:read', 'farm:chat'] })
    await assignRole({ userId: carol.id, roleId: farm.id, scope: 'system' })
    const manager = new WebSocketManager()
    const aliceWs = socket()
    const carolWs = socket()
    await manager.subscribe(manager.addClient(aliceWs, { type: 'user', userId: alice.id }), 'presence')
    const carolClient = manager.addClient(carolWs, { type: 'user', userId: carol.id })
    await manager.subscribe(carolClient, 'presence')
    await manager.subscribe(carolClient, 'farmChat')
    manager.handleMessage(carolWs, JSON.stringify({ type: 'presence', focus: null }))
    await until(() => events(aliceWs, 'presence.updated').length === 1, 'Carol arriving')

    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectId, carol.id), eq(roleAssignments.roleId, farm.id)))
    manager.invalidateAccessCache()
    await manager.settled()

    expect(frames(carolWs).filter((frame) => frame.type === 'unsubscribed')).toEqual([
      { type: 'unsubscribed', topic: 'presence' },
      { type: 'unsubscribed', topic: 'farmChat' },
    ] as Frame[])
    expect(events(aliceWs, 'presence.left').map((frame) => frame.data)).toEqual([{ userId: carol.id }])
    manager.sendFarmChat('farmChat.roomsChanged', {})
    expect(events(carolWs, 'farmChat.roomsChanged')).toHaveLength(0)
    manager.handleMessage(aliceWs, JSON.stringify({ type: 'presence', focus: SQUAD }))
    await manager.settled()
    expect(events(carolWs, 'presence.updated')).toHaveLength(0)
  })
})

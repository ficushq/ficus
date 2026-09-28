import type { FarmChatMessage, FarmChatRoom, FarmLook, PresenceFocus, PresencePerson } from '@ficus/shared'
import type { FarmChatApi } from '../multiplayer/chatApi'
import type { DemoMultiplayer, MultiplayerEvent } from '../multiplayer/MultiplayerProvider'

/*
 * Demo mode's neighbours (dev only): two pretend people who wander the sample
 * farm, and an in-memory chat where Rosa answers your DMs. Nothing leaves the
 * browser.
 */

const ME = { userId: 'demo-you', name: 'You' }
const ROSA = { id: 'demo-rosa', name: 'Rosa Díaz' }
const SAM = { id: 'demo-sam', name: 'sam@example.com' }
/** Rosa has dressed herself in the character builder; Sam wears the farm's pick. */
const ROSA_LOOK: FarmLook = {
  skin: '#c68a5f',
  hair: 'long',
  hairColor: '#8c3b22',
  hat: 'sunhat',
  hatColor: '#f2c14e',
  shirt: 'flannel',
  shirtColor: '#e36c5a',
  pants: 'overalls',
  pantsColor: '#4b5d7a',
  shoes: 'boots',
  shoesColor: '#6b5a45',
  piercings: ['ears', 'nose'],
}

const ROSA_ROUTE: Array<PresenceFocus | null> = [
  { kind: 'agent', agentId: 'mgr-platform' },
  { kind: 'workstream', workstreamId: 'ws-3' },
  { kind: 'squad', squadId: 'sq-docs' },
  null,
]
const SAM_ROUTE: Array<PresenceFocus | null> = [null, { kind: 'agent', agentId: 'mgr-docs' }]
const ROSA_LINES = ['Morning! 🌱', 'The docs squad is flying today', 'Anyone looked at the flaky webhook one?']

const iso = () => new Date().toISOString()
let nextId = 0
const id = (prefix: string) => `${prefix}-${++nextId}`

export function demoMultiplayer(): DemoMultiplayer {
  const rooms: FarmChatRoom[] = [
    {
      id: 'room-general',
      kind: 'general',
      name: 'general',
      description: null,
      withUserId: null,
      lastMessageAt: null,
      unread: 0,
    },
    {
      id: 'room-design',
      kind: 'room',
      name: 'design',
      description: 'Pixels and plants',
      withUserId: null,
      lastMessageAt: null,
      unread: 0,
    },
    {
      id: 'room-rosa',
      kind: 'dm',
      name: ROSA.name,
      description: null,
      withUserId: ROSA.id,
      lastMessageAt: null,
      unread: 0,
    },
  ]
  const messages = new Map<string, FarmChatMessage[]>([
    [
      'room-general',
      [
        {
          id: id('m'),
          roomId: 'room-general',
          senderUserId: SAM.id,
          body: 'Welcome to the farm, everyone.',
          createdAt: iso(),
          editedAt: null,
          reactions: [{ emoji: '🌱', userIds: [ROSA.id] }],
        },
      ],
    ],
    ['room-design', []],
    ['room-rosa', []],
  ])
  let emit: (event: MultiplayerEvent) => void = () => {}

  const post = (roomId: string, senderUserId: string, body: string): FarmChatMessage => {
    const message: FarmChatMessage = {
      id: id('m'),
      roomId,
      senderUserId,
      body,
      createdAt: iso(),
      editedAt: null,
      reactions: [],
    }
    messages.get(roomId)?.push(message)
    const room = rooms.find((r) => r.id === roomId)
    if (room) {
      room.lastMessageAt = message.createdAt
      if (senderUserId !== ME.userId) room.unread += 1
    }
    emit({ event: 'farmChat.messageCreated', data: { message } })
    return message
  }

  const find = (roomId: string, messageId: string) => messages.get(roomId)?.find((m) => m.id === messageId)
  const changed = (message: FarmChatMessage) => {
    emit({ event: 'farmChat.messageUpdated', data: { message: { ...message } } })
    return { ...message }
  }
  const react = (message: FarmChatMessage, userId: string, emoji: string, on: boolean) => {
    const entry = message.reactions.find((r) => r.emoji === emoji)
    if (on && !entry) message.reactions.push({ emoji, userIds: [userId] })
    else if (on && entry && !entry.userIds.includes(userId)) entry.userIds.push(userId)
    else if (!on && entry) {
      entry.userIds = entry.userIds.filter((u) => u !== userId)
      if (!entry.userIds.length) message.reactions = message.reactions.filter((r) => r !== entry)
    }
    return changed(message)
  }

  const chat: FarmChatApi = {
    people: async () => [{ id: ME.userId, name: ME.name }, ROSA, SAM],
    rooms: async () => ({ rooms: rooms.map((room) => ({ ...room })), canManageRooms: true }),
    createRoom: async ({ name, description }) => {
      const room: FarmChatRoom = {
        id: id('room'),
        kind: 'room',
        name,
        description: description ?? null,
        withUserId: null,
        lastMessageAt: null,
        unread: 0,
      }
      rooms.push(room)
      messages.set(room.id, [])
      emit({ event: 'farmChat.roomsChanged', data: {} })
      return room
    },
    updateRoom: async (roomId, { name, description }) => {
      const room = rooms.find((r) => r.id === roomId)!
      Object.assign(room, { name, description: description ?? null })
      emit({ event: 'farmChat.roomsChanged', data: {} })
      return room
    },
    deleteRoom: async (roomId) => {
      rooms.splice(
        rooms.findIndex((r) => r.id === roomId),
        1
      )
      emit({ event: 'farmChat.roomsChanged', data: {} })
    },
    directRoom: async (userId) => {
      let room = rooms.find((r) => r.kind === 'dm' && r.withUserId === userId)
      if (!room) {
        room = {
          id: id('room'),
          kind: 'dm',
          name: userId === ROSA.id ? ROSA.name : SAM.name,
          description: null,
          withUserId: userId,
          lastMessageAt: null,
          unread: 0,
        }
        rooms.push(room)
        messages.set(room.id, [])
        emit({ event: 'farmChat.roomsChanged', data: {} })
      }
      return room
    },
    messages: async (roomId) => ({ messages: [...(messages.get(roomId) ?? [])], hasMore: false }),
    send: async (roomId, body) => {
      const message = post(roomId, ME.userId, body)
      const room = rooms.find((r) => r.id === roomId)
      if (room?.kind === 'dm' && room.withUserId === ROSA.id) {
        // Rosa likes it, types a bit, then answers.
        window.setTimeout(() => react(message, ROSA.id, '👍', true), 700)
        window.setTimeout(() => emit({ event: 'farmChat.typing', data: { roomId, userId: ROSA.id } }), 900)
        window.setTimeout(() => post(roomId, ROSA.id, 'Ha, yes! Let’s pair on it later 🌻'), 3200)
      }
      return message
    },
    editMessage: async (roomId, messageId, body) => {
      const message = find(roomId, messageId)!
      Object.assign(message, { body, editedAt: iso() })
      return changed(message)
    },
    react: async (roomId, messageId, emoji, on) => react(find(roomId, messageId)!, ME.userId, emoji, on),
    markRead: async (roomId) => {
      const room = rooms.find((r) => r.id === roomId)
      if (room) room.unread = 0
    },
  }

  return {
    me: ME,
    chat,
    // Whoever you wave at waves back.
    wave(toUserId) {
      window.setTimeout(
        () => emit({ event: 'presence.waved', data: { fromUserId: toUserId, toUserId: ME.userId } }),
        1400
      )
    },
    start(sink) {
      emit = sink
      let rosa = 0
      let sam = 0
      let line = 0
      const person = (who: { id: string; name: string }, focus: PresenceFocus | null): PresencePerson => ({
        userId: who.id,
        name: who.name,
        focus,
        since: iso(),
        look: who === ROSA ? ROSA_LOOK : null,
      })
      sink({ event: 'presence.snapshot', data: { people: [person(ROSA, ROSA_ROUTE[0]!), person(SAM, SAM_ROUTE[0]!)] } })
      const moves = window.setInterval(() => {
        rosa = (rosa + 1) % ROSA_ROUTE.length
        sink({ event: 'presence.updated', data: { person: person(ROSA, ROSA_ROUTE[rosa]!) } })
        if (rosa % 2 === 0) {
          sam = (sam + 1) % SAM_ROUTE.length
          sink({ event: 'presence.updated', data: { person: person(SAM, SAM_ROUTE[sam]!) } })
        }
      }, 7000)
      const talk = window.setInterval(() => {
        post('room-general', ROSA.id, ROSA_LINES[line++ % ROSA_LINES.length]!)
      }, 11000)
      return () => {
        window.clearInterval(moves)
        window.clearInterval(talk)
        emit = () => {}
      }
    },
  }
}

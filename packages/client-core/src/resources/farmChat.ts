import type { FarmChatMessage, FarmChatMessagePage, FarmChatRoom, FarmChatRooms, FarmPerson } from '@ficus/shared'
import type { Transport } from '../transport'

/**
 * The farm's chat between people: the general room, public rooms (managing
 * them needs `chat:manage-rooms`) and DMs. Live updates arrive on the
 * `farmChat` WebSocket topic.
 */
export function farmChatResource(t: Transport) {
  const room = (id: string) => `/farm-chat/rooms/${encodeURIComponent(id)}`
  return {
    people: (): Promise<FarmPerson[]> => t.request('/farm-chat/people'),
    rooms: (): Promise<FarmChatRooms> => t.request('/farm-chat/rooms'),
    createRoom: (input: { name: string; description?: string | null }): Promise<FarmChatRoom> =>
      t.request('/farm-chat/rooms', { method: 'POST', body: input }),
    updateRoom: (id: string, input: { name: string; description?: string | null }): Promise<FarmChatRoom> =>
      t.request(room(id), { method: 'PATCH', body: input }),
    deleteRoom: (id: string): Promise<void> => t.request(room(id), { method: 'DELETE' }),
    /** The DM with someone, opened if it's the first time. */
    directRoom: (userId: string): Promise<FarmChatRoom> =>
      t.request('/farm-chat/dms', { method: 'POST', body: { userId } }),
    /** The latest messages (oldest first), or the page before `before` (an ISO time). */
    messages: (id: string, before?: string): Promise<FarmChatMessagePage> =>
      t.request(`${room(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    send: (id: string, body: string): Promise<FarmChatMessage> =>
      t.request(`${room(id)}/messages`, { method: 'POST', body: { body } }),
    /** Changes the text of a message you sent. */
    editMessage: (id: string, messageId: string, body: string): Promise<FarmChatMessage> =>
      t.request(`${room(id)}/messages/${encodeURIComponent(messageId)}`, { method: 'PATCH', body: { body } }),
    /** Adds (`on`) or takes back your emoji reaction to a message. */
    react: (id: string, messageId: string, emoji: string, on: boolean): Promise<FarmChatMessage> =>
      t.request(`${room(id)}/messages/${encodeURIComponent(messageId)}/reactions`, {
        method: 'POST',
        body: { emoji, on },
      }),
    markRead: (id: string): Promise<void> => t.request(`${room(id)}/read`, { method: 'POST' }),
  }
}

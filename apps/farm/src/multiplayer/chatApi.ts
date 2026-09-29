import type { FarmChatMessage, FarmChatMessagePage, FarmChatRoom, FarmChatRooms, FarmPerson } from '@ficus/shared'
import { client } from '../api/client'

/** What the chat panel needs from Core (client-core's farmChat), so demo mode can stand in for it. */
export interface FarmChatApi {
  people(): Promise<FarmPerson[]>
  rooms(): Promise<FarmChatRooms>
  createRoom(input: { name: string; description?: string | null }): Promise<FarmChatRoom>
  updateRoom(id: string, input: { name: string; description?: string | null }): Promise<FarmChatRoom>
  deleteRoom(id: string): Promise<void>
  directRoom(userId: string): Promise<FarmChatRoom>
  messages(id: string, before?: string): Promise<FarmChatMessagePage>
  send(id: string, body: string): Promise<FarmChatMessage>
  editMessage(id: string, messageId: string, body: string): Promise<FarmChatMessage>
  react(id: string, messageId: string, emoji: string, on: boolean): Promise<FarmChatMessage>
  deleteMessage(id: string, messageId: string): Promise<void>
  markRead(id: string): Promise<void>
}

export const liveChatApi: FarmChatApi = client.farmChat

/** The farm chat's query keys (farm-only; the web app has no farm chat). */
export const chatKeys = {
  all: ['farm', 'chat'] as const,
  people: () => ['farm', 'chat', 'people'] as const,
  rooms: () => ['farm', 'chat', 'rooms'] as const,
  messages: (roomId: string) => ['farm', 'chat', 'messages', roomId] as const,
}

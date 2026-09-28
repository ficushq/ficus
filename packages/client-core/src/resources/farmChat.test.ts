import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

test('farm chat calls the farm chat routes over the shared transport', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return {} as T
    },
    openStream: async () => {
      throw new Error('unused')
    },
    wsUrl: (p) => p,
    url: (p) => p,
  }
  const chat = createClient(transport).farmChat
  await chat.people()
  await chat.rooms()
  await chat.createRoom({ name: 'design' })
  await chat.updateRoom('r1', { name: 'art', description: null })
  await chat.deleteRoom('r1')
  await chat.directRoom('u2')
  await chat.messages('r1')
  await chat.messages('r1', '2026-09-27T12:00:00.000Z')
  await chat.send('r1', 'hi')
  await chat.editMessage('r1', 'm1', 'fixed')
  await chat.react('r1', 'm1', '👍', true)
  await chat.markRead('r1')
  expect(calls).toEqual([
    { path: '/farm-chat/people', options: undefined },
    { path: '/farm-chat/rooms', options: undefined },
    { path: '/farm-chat/rooms', options: { method: 'POST', body: { name: 'design' } } },
    { path: '/farm-chat/rooms/r1', options: { method: 'PATCH', body: { name: 'art', description: null } } },
    { path: '/farm-chat/rooms/r1', options: { method: 'DELETE' } },
    { path: '/farm-chat/dms', options: { method: 'POST', body: { userId: 'u2' } } },
    { path: '/farm-chat/rooms/r1/messages', options: undefined },
    { path: '/farm-chat/rooms/r1/messages?before=2026-09-27T12%3A00%3A00.000Z', options: undefined },
    { path: '/farm-chat/rooms/r1/messages', options: { method: 'POST', body: { body: 'hi' } } },
    { path: '/farm-chat/rooms/r1/messages/m1', options: { method: 'PATCH', body: { body: 'fixed' } } },
    {
      path: '/farm-chat/rooms/r1/messages/m1/reactions',
      options: { method: 'POST', body: { emoji: '👍', on: true } },
    },
    { path: '/farm-chat/rooms/r1/read', options: { method: 'POST' } },
  ])
})

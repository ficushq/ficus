import { expect, test } from 'bun:test'
import { resolveNotificationTarget } from './notificationTarget'

const conversationId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
const assistantPayload = {
  title: 'Assistant update',
  body: 'A task has an update. Open Assistant to view it.',
  url: `https://ficus.example/?chat=open&assistantConversation=${conversationId}`,
  messageId: 'm1',
}

test('an Assistant update opens the saved conversation, never the inbox or a sender agent', () => {
  expect(resolveNotificationTarget(assistantPayload, 'https://ficus.example', '/')).toBe(
    `/?chat=open&assistantConversation=${conversationId}`
  )
  expect(resolveNotificationTarget(assistantPayload, 'https://ficus.example', '/')).not.toContain('/inbox')
})

test('a deployment base path is preserved from the server-built URL', () => {
  const url = `https://home.example/ficus/?chat=open&assistantConversation=${conversationId}`
  expect(resolveNotificationTarget({ ...assistantPayload, url }, 'https://home.example', '/ficus/')).toBe(
    `/ficus/?chat=open&assistantConversation=${conversationId}`
  )
})

test('external or malformed destinations fall back to the app root on the base path', () => {
  expect(resolveNotificationTarget({ url: 'https://evil.example/steal' }, 'https://ficus.example', '/ficus/')).toBe(
    '/ficus/'
  )
  expect(resolveNotificationTarget({ url: 'javascript:alert(1)' }, 'https://ficus.example', '/')).toBe('/')
  expect(resolveNotificationTarget({}, 'https://ficus.example', '/')).toBe('/')
})

test('exact Action Center targets still take precedence over a generic URL', () => {
  expect(
    resolveNotificationTarget(
      { url: 'https://ficus.example/inbox', actionId: 'workstream-blocked:ws1:wait1' },
      'https://ficus.example',
      '/'
    )
  ).toBe('/actions/workstream-blocked%3Aws1%3Await1')
})

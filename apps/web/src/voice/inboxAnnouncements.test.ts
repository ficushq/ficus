import { describe, expect, test } from 'bun:test'
import type { InboxMessageResponse } from '../api/inbox'
import { buildInboxAnnouncementPrompt, enqueueUniqueInboxMessages } from './inboxAnnouncements'

function message(overrides: Partial<InboxMessageResponse>): InboxMessageResponse {
  return {
    id: 'msg-1',
    recipientType: 'human',
    recipientId: 'user',
    senderType: 'agent',
    senderId: 'agent-1',
    subject: 'Done',
    content: 'I finished the deployment check.',
    metadata: {},
    readAt: null,
    deliveredAt: null,
    deliveryMode: 'follow-up',
    createdAt: '2026-04-29T00:00:00Z',
    ...overrides,
  }
}

describe('enqueueUniqueInboxMessages', () => {
  test('queues unread messages that are not already queued or spoken', () => {
    const queued = [message({ id: 'queued' })]
    const seen = new Set(['spoken'])

    const result = enqueueUniqueInboxMessages(
      queued,
      [message({ id: 'new' }), message({ id: 'queued' }), message({ id: 'spoken' })],
      seen
    )

    expect(result.map((m) => m.id)).toEqual(['queued', 'new'])
  })

  test('does not queue read messages', () => {
    const result = enqueueUniqueInboxMessages([], [message({ id: 'read', readAt: '2026-04-29T00:00:00Z' })], new Set())

    expect(result).toEqual([])
  })
})

describe('buildInboxAnnouncementPrompt', () => {
  test('asks the model to summarize naturally instead of saying generic inbox alert', () => {
    const prompt = buildInboxAnnouncementPrompt(message({ content: 'The OAuth fix is deployed and verified.' }))

    expect(prompt).toContain('contextually related to the recent conversation')
    expect(prompt).toContain('Summarize it naturally in your own words')
    expect(prompt).toContain('The OAuth fix is deployed and verified.')
  })

  test('names an agent sender by its type as the app shows it, never the raw type id', () => {
    const sender = { id: 'agent-9', name: 'Quartz', agentTypeId: 'qa-bot', squadId: null, ownerUserId: null }
    const named = buildInboxAnnouncementPrompt(message({ senderAgent: sender }), (id) =>
      id === 'qa-bot' ? 'Release QA' : undefined
    )
    expect(named).toContain('Sender: Release QA (agent-9)')
    expect(named).not.toContain('qa-bot')

    expect(buildInboxAnnouncementPrompt(message({ senderAgent: sender }))).toContain('Sender: Qa Bot (agent-9)')
    const general = buildInboxAnnouncementPrompt(message({ senderAgent: { ...sender, agentTypeId: 'general' } }))
    expect(general).toContain('Sender: General Purpose agent (agent-9)')
  })
})

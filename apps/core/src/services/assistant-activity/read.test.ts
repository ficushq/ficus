import { expect, test } from 'bun:test'
import { toAssistantActivityUpdate } from './read'

type Row = Parameters<typeof toAssistantActivityUpdate>[0]

function updateFrom(sender: Record<string, unknown> | undefined) {
  const at = new Date('2026-11-27T00:00:00Z')
  return toAssistantActivityUpdate({
    update: {
      messageId: 'm1',
      taskId: 't1',
      requestId: 'r1',
      sequence: 1,
      reportedStatus: null,
      processedAt: null,
      summarizedMessageId: null,
      seenAt: null,
      createdAt: at,
    } as unknown as Row['update'],
    message: { content: 'done', subject: null, metadata: sender ? { sender } : {} } as unknown as Row['message'],
  })
}

test('names an agent sender type first, by its configured type name', () => {
  expect(updateFrom({ agentTypeId: 'engineer', agentTypeName: 'Builder', name: 'Riley' }).senderName).toBe('Builder')
  expect(updateFrom({ agentTypeId: 'engineer', name: 'Riley' }).senderName).toBe('Engineer')
})

test('never adds a purpose recorded with the sender', () => {
  const update = updateFrom({
    agentTypeId: 'engineer',
    agentTypeName: 'Engineer',
    purpose: 'Secret project',
    name: 'R',
  })
  expect(update.senderName).toBe('Engineer')
})

test('falls back to the recorded name for a sender without a type', () => {
  expect(updateFrom({ name: 'noah' }).senderName).toBe('noah')
  expect(updateFrom(undefined).senderName).toBe('Agent')
})

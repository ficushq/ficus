import { describe, expect, it } from 'bun:test'
import {
  extractChatExecution,
  extractExecution,
  extractInboxMessage,
  extractWait,
  extractWorkStream,
  firstLineSummary,
} from '../squad-activity/extractors'
import { activityPayloadHash } from '../squad-activity/types'

const squadId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const executionId = '00000000-0000-4000-8000-000000000003'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('materialized activity extractors', () => {
  it('normalizes bounded first-line summaries', () => {
    expect(firstLineSummary(' \n  hello   world\nignored')).toBe('hello world')
    expect([...firstLineSummary('😀'.repeat(170))]).toHaveLength(160)
  })

  it('extracts one row per execution from its latest qualifying assistant message, deterministically', () => {
    const snapshot = {
      squadId,
      executionId,
      agentId,
      agentTypeId: 'engineer',
      messages: [
        { id: id(2), role: 'assistant', content: 'later', createdAt: '2026-08-26T12:00:00.1234Z' },
        { id: id(1), role: 'assistant', content: 'first', createdAt: '2026-08-26T12:00:00.1234Z' },
        { id: id(3), role: 'tool', content: 'secret tool', createdAt: '2026-08-26T12:00:01Z' },
      ],
    }
    const originalOrder = snapshot.messages.map((message) => message.id)
    const first = extractChatExecution(snapshot)
    expect(snapshot.messages.map((message) => message.id)).toEqual(originalOrder)
    // One row per execution, keyed by it, showing the latest assistant message
    // (a timestamp tie breaks by id); tool output never counts.
    expect(first.map((item) => [item.rowId, item.quietEligible])).toEqual([[executionId, true]])
    expect(first[0]!.summary).toBe('later')
    expect(first[0]!.ref).toMatchObject({ messageId: id(2) })
    expect(extractChatExecution(structuredClone(snapshot))).toEqual(first)
    expect(activityPayloadHash(first[0])).toBe(activityPayloadHash(extractChatExecution(snapshot)[0]))
  })

  it('extracts wait facets at canonical milliseconds; execution rows stay retired', () => {
    // Execution lifecycle rows were retired 2026-08-27 (operator decision):
    // even a fully terminal execution snapshot produces nothing.
    const execution = extractExecution({
      squadId,
      id: executionId,
      agentId,
      agentTypeId: 'engineer',
      status: 'completed',
      runStartedAt: '2026-08-26T12:00:00.1234Z',
      endedAt: '2026-08-26T12:01:00.4567Z',
    })
    expect(execution).toEqual([])
    expect(
      extractWait({
        squadId,
        id: id(4),
        workStreamId: id(5),
        type: 'review',
        message: 'review',
        createdByAgentId: agentId,
        createdByAgentTypeId: 'engineer',
        openedAt: '2026-08-26T12:00:00Z',
        closedAt: '2026-08-26T12:01:00Z',
        resolution: 'approved',
        resolutionNote: 'ship',
      }).map((item) => item.lane)
    ).toEqual([40, 41])
  })

  it('fails closed for foreign inbox ownership and classifies trusted handoffs', () => {
    const base = {
      id: id(6),
      createdAt: '2026-08-26T12:00:00Z',
      recipientType: 'agent',
      recipientId: agentId,
      recipientSquadId: squadId,
      recipientAgentTypeId: 'reviewer',
      senderType: 'system',
      senderId: null,
      content: 'assigned',
      metadata: { event: 'assigned', workStreamId: id(5) },
      workStream: { id: id(5), squadId, title: 'Auth refactor', ownerAgentId: agentId, managerAgentId: null },
    }
    expect(extractInboxMessage(base)).toHaveLength(1)
    const message = extractInboxMessage({
      ...base,
      senderType: 'agent',
      senderId: id(7),
      metadata: null,
      workStream: null,
    })[0]
    expect(message.ref).toMatchObject({ type: 'agent', view: 'inbox', messageId: base.id })
    expect(extractInboxMessage({ ...base, recipientSquadId: null })).toEqual([])
    expect(extractInboxMessage({ ...base, workStream: { ...base.workStream, squadId: id(9) } })).toEqual([])
  })

  it('bounds structural summaries to the persisted column contract', () => {
    const [item] = extractWorkStream({
      squadId,
      id: id(8),
      title: 'x'.repeat(2_000),
      creatorAgentId: null,
      creatorAgentTypeId: null,
      createdAt: '2026-08-26T12:00:00Z',
    })
    expect([...item.summary].length).toBeLessThanOrEqual(512)
    expect(item.summary.endsWith('…')).toBe(true)
  })
})

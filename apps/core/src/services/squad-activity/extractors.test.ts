import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  extractChatExecution,
  extractExecution,
  extractGitHubIssueDispatch,
  extractGitHubPrDispatch,
  extractInboxMessage,
} from './extractors'

describe('execution row retirement (operator decision 2026-08-27)', () => {
  test('extractExecution produces no rows, even for a terminal execution', () => {
    const rows = extractExecution({
      id: '4f21252c-5de7-4a7a-a719-d98a9652eac0',
      agentId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
      squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      agentTypeId: 'engineer',
      status: 'completed',
      runStartedAt: new Date('2026-08-27T10:00:00Z'),
      endedAt: new Date('2026-08-27T10:05:00Z'),
    })
    // Historical rows are deleted by the repair's desired-state diff; this
    // pin documents that the feed no longer surfaces TOP-LEVEL execution
    // lifecycle (subagent executions are the one exception, below).
    expect(rows).toEqual([])
  })

  test('subagent executions produce a parent-attributed spawned row only', () => {
    const rows = extractExecution({
      id: '4f21252c-5de7-4a7a-a719-d98a9652eac0',
      agentId: '70590989-9f6d-4434-b48a-721dfc56b038',
      squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      agentTypeId: 'subagent',
      status: 'completed',
      runStartedAt: new Date('2026-08-27T10:00:00Z'),
      endedAt: new Date('2026-08-27T10:05:00Z'),
      parentAgentId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
      parentAgentTypeId: 'engineer',
      subagentName: 'research-competitors',
    })
    // No "finished" row: the subagent's completion report to its parent
    // already rows as a Sent-message line (operator decision 2026-08-27).
    expect(rows.map((row) => row.summary)).toEqual(['Subagent "research-competitors" spawned.'])
    // Attribution is the PARENT: that is the identity the feed reader knows.
    expect(rows.every((row) => row.agentId === 'aeb03ca8-9290-4d2f-9878-79561bd931ce')).toBe(true)
    expect(rows.every((row) => row.agentTypeId === 'engineer')).toBe(true)
    expect(
      rows.every((row) => row.ref.type === 'agent' && row.ref.agentId === 'aeb03ca8-9290-4d2f-9878-79561bd931ce')
    ).toBe(true)
  })

  test('a failed subagent execution reports its status, not "finished"', () => {
    const rows = extractExecution({
      id: '4f21252c-5de7-4a7a-a719-d98a9652eac0',
      agentId: '70590989-9f6d-4434-b48a-721dfc56b038',
      squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      agentTypeId: 'subagent',
      status: 'failed',
      runStartedAt: null,
      endedAt: new Date('2026-08-27T10:05:00Z'),
      parentAgentId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
      parentAgentTypeId: 'engineer',
      subagentName: null,
    })
    expect(rows.map((row) => row.summary)).toEqual(['Subagent failed.'])
  })
})

describe('agent-to-agent inbox rows (operator decision 2026-08-27)', () => {
  const base = {
    id: 'c1a2b3d4-0000-4000-8000-000000000001',
    createdAt: new Date('2026-08-27T12:00:00Z'),
    recipientType: 'agent',
    recipientId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
    recipientSquadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
    recipientAgentTypeId: 'engineer',
    senderType: 'agent',
    senderId: '70590989-9f6d-4434-b48a-721dfc56b038',
    content: 'Findings for Task 1:\nsecond line is not part of the preview',
    metadata: null,
    workStream: null,
  }

  test('sender-attributed with a recipient-and-preview summary', () => {
    const [row] = extractInboxMessage({
      ...base,
      senderAgentExists: false, // terminated subagent — attribution must survive
      senderAgentTypeId: 'subagent',
      senderName: 'research-competitors',
      senderParentAgentTypeId: 'reviewer',
    })
    expect(row.summary).toBe(
      'Subagent sent message to Engineer: Findings for Task 1: second line is not part of the preview'
    )
    // Attributed to the sender's PARENT type (renders as "› Reviewer",
    // consistent with spawn rows), gated behind agents-read via the flag.
    expect(row.agentTypeId).toBe('reviewer')
    expect(row.agentTypeRequiresAgentsRead).toBe(true)
    // A terminated sender still yields no agentId ref (dead-agent link guard).
    expect(row.agentId).toBeNull()
    // Subagent reports are the completion signal: their own lane + kind so
    // BOTH the Messages and Subagents filters include them.
    expect(row.lane).toBe(22)
    expect(row.kind).toBe('subagent')
  })

  test('a regular agent send stays lane 20 kind message', () => {
    const [row] = extractInboxMessage({
      ...base,
      senderAgentExists: true,
      senderAgentTypeId: 'engineer',
    })
    expect(row.lane).toBe(20)
    expect(row.kind).toBe('message')
  })

  test('a system notice without a work-stream event becomes a lane-21 message row', () => {
    const [row] = extractInboxMessage({
      ...base,
      senderType: 'system',
      senderId: null,
      subject: 'PR #1236: CI passed (Lint)',
      content: 'Full body that should not be used when a subject exists',
    })
    expect(row.lane).toBe(21)
    expect(row.kind).toBe('message')
    expect(row.summary).toBe('Sent message to Engineer: PR #1236: CI passed (Lint)')
    expect(row.agentTypeId).toBeNull()
    // Work-stream event notices must NOT duplicate here — the wait/handoff
    // families already row those transitions.
    expect(
      extractInboxMessage({
        ...base,
        senderType: 'system',
        senderId: null,
        metadata: { event: 'review' },
      })
    ).toEqual([])
  })

  test('a sender without attribution still produces the recipient summary as system', () => {
    const [row] = extractInboxMessage({ ...base, senderAgentExists: true })
    expect(row.summary).toBe('Sent message to Engineer: Findings for Task 1: second line is not part of the preview')
    expect(row.agentTypeId).toBeNull()
    expect(row.agentId).toBe(base.senderId)
  })
})

describe('chat extraction (operator decision 2026-08-27, verbose retired)', () => {
  test('only the first substantive assistant message becomes a row', () => {
    const rows = extractChatExecution({
      squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      executionId: 'c1a2b3d4-0000-4000-8000-00000000000e',
      agentId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
      agentTypeId: 'engineer',
      messages: [
        { id: 'm3', role: 'assistant', content: 'Later reply', createdAt: new Date('2026-08-27T10:02:00Z') },
        { id: 'm1', role: 'assistant', content: '  \n ', createdAt: new Date('2026-08-27T10:00:00Z') },
        { id: 'm2', role: 'assistant', content: 'First real reply', createdAt: new Date('2026-08-27T10:01:00Z') },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].rowId).toBe('m2')
    expect(rows[0].summary).toBe('First real reply')
    expect(rows[0].quietEligible).toBe(true)
  })
})

/**
 * Independent restatement of the derived-row-id contract: sha256 of
 * `<logicalRowId>:<workStreamId>`, shaped like the logical row ids themselves so
 * it is storable in the uuid column.
 */
const derivedRowId = (logicalRowId: string, workStreamId: string) => {
  const hex = createHash('sha256').update(`${logicalRowId}:${workStreamId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/

describe('GitHub PR row copy (operator report 2026-08-27)', () => {
  const fact = (overrides: Record<string, unknown>) => ({
    eventType: 'pull_request',
    action: 'merged',
    occurredAt: '2026-08-27T12:00:00.000Z',
    repository: 'ficushq/tau',
    prNumber: 1215,
    nativeId: '99',
    logicalRowId: 'c1a2b3d4-0000-4000-8000-0000000000f1',
    url: 'https://github.com/ficushq/tau/pull/1215',
    actorLogin: null,
    ...overrides,
  })
  const snapshot = (factOverrides: Record<string, unknown>) => ({
    sourceId: 'hook:0f0e0d0c-0000-4000-8000-000000000001',
    activityId: '0f0e0d0c-0000-4000-8000-000000000001',
    squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
    workStreamIds: ['b2cc0a94-0000-4000-8000-000000000001'],
    fact: fact(factOverrides) as never,
  })

  test('event-aware phrasing: comments are comments, reviews are reviews, synchronize is updated', () => {
    const summary = (factOverrides: Record<string, unknown>) =>
      extractGitHubPrDispatch(snapshot(factOverrides) as never)[0].summary
    // A bot COMMENTING must never read as the bot CREATING the PR.
    expect(summary({ eventType: 'issue_comment', action: 'created', actorLogin: 'github-actions[bot]' })).toBe(
      '[PR #1215 comment] by github-actions[bot]'
    )
    expect(summary({ eventType: 'pull_request_review', action: 'submitted', actorLogin: 'noahsaso' })).toBe(
      '[PR #1215 reviewed] by noahsaso'
    )
    expect(summary({ eventType: 'pull_request_review_comment', action: 'created', actorLogin: 'ficusagent' })).toBe(
      '[PR #1215 review comment] by ficusagent'
    )
    expect(summary({ action: 'synchronize' })).toBe('[PR #1215 updated]')
    expect(summary({ action: 'merged' })).toBe('[PR #1215 merged]')
  })

  test('emits one row per tracking stream; the first keeps the logical row id', () => {
    const streams = ['b2cc0a94-0000-4000-8000-000000000001', 'b2cc0a94-0000-4000-8000-000000000003']
    const rows = extractGitHubPrDispatch({ ...snapshot({}), workStreamIds: streams } as never)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.workStreamId)).toEqual(streams)
    expect(rows.map((row) => row.lane)).toEqual([70, 70])
    // Existing rows stay put: stream one keeps the fact's own logical identity.
    expect(rows[0].rowId).toBe('c1a2b3d4-0000-4000-8000-0000000000f1')
    expect(rows[1].rowId).toBe(derivedRowId('c1a2b3d4-0000-4000-8000-0000000000f1', streams[1]))
    expect(rows[1].rowId).toMatch(UUID)
    expect(rows.map((row) => row.id)).toEqual([`70:${rows[0].rowId}`, `70:${rows[1].rowId}`])
    // The shared PR ref type names no stream, so both rows point at the PR itself.
    expect(rows.map((row) => row.ref)).toEqual([
      { type: 'pr', url: 'https://github.com/ficushq/tau/pull/1215' },
      { type: 'pr', url: 'https://github.com/ficushq/tau/pull/1215' },
    ])
    expect(rows[0].summary).toBe(rows[1].summary)
    expect(rows[0].at).toBe(rows[1].at)
  })

  test('a single tracking stream is unchanged: one row, keyed by the logical row id', () => {
    const rows = extractGitHubPrDispatch(snapshot({}) as never)
    expect(rows).toHaveLength(1)
    expect(rows[0].rowId).toBe('c1a2b3d4-0000-4000-8000-0000000000f1')
    expect(rows[0].workStreamId).toBe('b2cc0a94-0000-4000-8000-000000000001')
  })
})

describe('GitHub issue row copy', () => {
  const snapshot = (factOverrides: Record<string, unknown>) => ({
    sourceId: 'hook:0f0e0d0c-0000-4000-8000-000000000002',
    activityId: '0f0e0d0c-0000-4000-8000-000000000002',
    squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
    workStreamIds: ['b2cc0a94-0000-4000-8000-000000000002'],
    fact: {
      eventType: 'issues',
      action: 'closed',
      occurredAt: '2026-08-27T12:00:00.000Z',
      actorLogin: 'noahsaso',
      repository: 'ficushq/tau',
      issueNumber: 12,
      issueTitle: 'Track issues in Activity',
      detail: null,
      nativeId: '99',
      providerDeliveryId: null,
      logicalRowId: 'c1a2b3d4-0000-4000-8000-0000000000f2',
      url: 'https://github.com/ficushq/tau/issues/12',
      ...factOverrides,
    } as never,
  })
  const summary = (factOverrides: Record<string, unknown>) =>
    extractGitHubIssueDispatch(snapshot(factOverrides) as never)[0].summary

  test('joins the described transition, title and actor without doubling separators', () => {
    expect(summary({})).toBe('[Issue #12 closed] Track issues in Activity · by noahsaso')
    expect(summary({ issueTitle: '' })).toBe('[Issue #12 closed] by noahsaso')
    expect(summary({ issueTitle: '', actorLogin: null })).toBe('[Issue #12 closed]')
    expect(summary({ action: 'assigned', detail: 'noahsaso' })).toBe(
      '[Issue #12 assigned to noahsaso] Track issues in Activity · by noahsaso'
    )
    expect(summary({ action: 'labeled', detail: 'bug' })).toBe(
      '[Issue #12 labeled bug] Track issues in Activity · by noahsaso'
    )
    expect(summary({ eventType: 'issue_comment', action: 'edited' })).toBe(
      '[Issue #12 comment edited] Track issues in Activity · by noahsaso'
    )
    expect([...summary({ issueTitle: 'x'.repeat(200), actorLogin: 'y'.repeat(400) })].length).toBeLessThanOrEqual(512)
  })

  test('carries the issue lane, kind, ref and append-only row identity', () => {
    const [row] = extractGitHubIssueDispatch(snapshot({}) as never)
    expect(row).toMatchObject({
      lane: 71,
      kind: 'issue',
      rowId: 'c1a2b3d4-0000-4000-8000-0000000000f2',
      sourceFamily: 'github-issue',
      sourceGroupId: 'hook:0f0e0d0c-0000-4000-8000-000000000002:4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      workStreamId: 'b2cc0a94-0000-4000-8000-000000000002',
      accessScope: 'workstreams',
      quietEligible: true,
    })
    expect(row.ref).toEqual({
      type: 'issue',
      url: 'https://github.com/ficushq/tau/issues/12',
      workStreamId: 'b2cc0a94-0000-4000-8000-000000000002',
    })
  })

  test('emits one row per tracking stream, each ref naming its own stream', () => {
    const streams = ['b2cc0a94-0000-4000-8000-000000000002', 'b2cc0a94-0000-4000-8000-000000000004']
    const rows = extractGitHubIssueDispatch({ ...snapshot({}), workStreamIds: streams } as never)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.workStreamId)).toEqual(streams)
    expect(rows.map((row) => row.lane)).toEqual([71, 71])
    expect(rows[0].rowId).toBe('c1a2b3d4-0000-4000-8000-0000000000f2')
    expect(rows[1].rowId).toBe(derivedRowId('c1a2b3d4-0000-4000-8000-0000000000f2', streams[1]))
    expect(rows[1].rowId).toMatch(UUID)
    expect(rows.map((row) => row.ref)).toEqual([
      { type: 'issue', url: 'https://github.com/ficushq/tau/issues/12', workStreamId: streams[0] },
      { type: 'issue', url: 'https://github.com/ficushq/tau/issues/12', workStreamId: streams[1] },
    ])
    expect(rows[0].summary).toBe(rows[1].summary)
  })
})

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
    // already rows as a received-report line (operator decision 2026-08-27).
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

  test('recipient-attributed report preserves terminated sender detail and completion membership', () => {
    const [row] = extractInboxMessage({
      ...base,
      senderAgentTypeId: 'subagent',
      senderName: 'research-competitors',
    })
    expect(row.summary).toBe(
      'Received report from Subagent (research-competitors): Findings for Task 1: second line is not part of the preview'
    )
    expect(row.agentTypeId).toBe('engineer')
    expect(row.agentTypeRequiresAgentsRead).toBe(true)
    expect(row.agentId).toBe(base.recipientId)
    expect(row.ref).toMatchObject({ agentId: base.recipientId, view: 'inbox', messageId: base.id })
    // Subagent reports are the completion signal: their own lane + kind so
    // BOTH the Messages and Subagents filters include them.
    expect(row.lane).toBe(22)
    expect(row.kind).toBe('subagent')
  })

  test('an agent message with a missing sender id remains a received message', () => {
    const rows = extractInboxMessage({ ...base, senderId: null })
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toStartWith('Received message from an agent:')
    expect(rows[0].agentId).toBe(base.recipientId)
  })

  test('a regular agent send stays lane 20 kind message', () => {
    const [row] = extractInboxMessage({
      ...base,
      senderAgentTypeId: 'manager',
    })
    expect(row.summary).toStartWith('Received message from Manager:')
    expect(row.agentId).toBe(base.recipientId)
    expect(row.agentTypeId).toBe('engineer')
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
    expect(row.summary).toBe('Received system notification: PR #1236: CI passed (Lint)')
    expect(row.agentTypeId).toBe('engineer')
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

  test('an unknown sender is truthfully an agent, never system', () => {
    const [row] = extractInboxMessage(base)
    expect(row.summary).toBe(
      'Received message from an agent: Findings for Task 1: second line is not part of the preview'
    )
    expect(row.agentTypeId).toBe('engineer')
    expect(row.agentId).toBe(base.recipientId)
  })
})

describe('chat extraction: one row per execution, its latest step', () => {
  const execution = {
    squadId: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
    executionId: 'c1a2b3d4-0000-4000-8000-00000000000e',
    agentId: 'aeb03ca8-9290-4d2f-9878-79561bd931ce',
    agentTypeId: 'engineer',
  }

  test('shows the latest substantive assistant message, keyed by the execution', () => {
    const rows = extractChatExecution({
      ...execution,
      messages: [
        {
          id: 'm3',
          role: 'assistant',
          content: 'Now checking the setup files',
          createdAt: new Date('2026-08-27T10:02:00Z'),
        },
        { id: 'm4', role: 'assistant', content: '  \n ', createdAt: new Date('2026-08-27T10:03:00Z') },
        { id: 'm1', role: 'user', content: 'Please review', createdAt: new Date('2026-08-27T10:04:00Z') },
        { id: 'm2', role: 'assistant', content: 'I read the diff', createdAt: new Date('2026-08-27T10:01:00Z') },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].rowId).toBe(execution.executionId)
    expect(rows[0].id).toBe(`10:${execution.executionId}`)
    expect(rows[0].summary).toBe('Now checking the setup files')
    expect(rows[0].at).toBe('2026-08-27T10:02:00.000Z')
    expect(rows[0].ref).toMatchObject({ messageId: 'm3', executionId: execution.executionId })
    expect(rows[0].quietEligible).toBe(true)
  })

  test('a new step updates the same row: same identity, newer text and time', () => {
    const first = {
      id: 'm1',
      role: 'assistant',
      content: 'Reading the diff',
      createdAt: new Date('2026-08-27T10:00:00Z'),
    }
    const [before] = extractChatExecution({ ...execution, messages: [first] })
    const [after] = extractChatExecution({
      ...execution,
      messages: [
        first,
        {
          id: 'm2',
          role: 'assistant',
          content: 'Live Caddy tests look good',
          createdAt: new Date('2026-08-27T10:05:00Z'),
        },
      ],
    })
    expect([after.squadId, after.lane, after.rowId]).toEqual([before.squadId, before.lane, before.rowId])
    expect(after.summary).toBe('Live Caddy tests look good')
    expect(after.at > before.at).toBe(true)
  })

  test('mid-step, the committed latest text shows while it is newer than the last message', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      content: 'Reading the diff',
      createdAt: new Date('2026-08-27T10:00:00Z'),
    }
    const [live] = extractChatExecution({
      ...execution,
      latestText: 'Now checking the setup files\nand the vendored ones',
      latestTextAt: new Date('2026-08-27T10:01:00Z'),
      messages: [message],
    })
    expect(live.summary).toBe('Now checking the setup files and the vendored ones')
    expect(live.at).toBe('2026-08-27T10:01:00.000Z')
    expect(live.rowId).toBe(execution.executionId)
    // The chat opens at the last message there is; the live step has none yet.
    expect(live.ref).toMatchObject({ messageId: 'm1' })

    // Once the step's message lands (newer), it takes over.
    const [landed] = extractChatExecution({
      ...execution,
      latestText: 'Now checking the setup files',
      latestTextAt: new Date('2026-08-27T10:01:00Z'),
      messages: [
        message,
        {
          id: 'm2',
          role: 'assistant',
          content: 'Now checking the setup files',
          createdAt: new Date('2026-08-27T10:01:05Z'),
        },
      ],
    })
    expect(landed.ref).toMatchObject({ messageId: 'm2' })
    expect(landed.at).toBe('2026-08-27T10:01:05.000Z')
  })

  test('the first text of a run shows before any message exists', () => {
    const [row] = extractChatExecution({
      ...execution,
      latestText: 'Starting with the schema',
      latestTextAt: new Date('2026-08-27T10:00:00Z'),
      messages: [],
    })
    expect(row.summary).toBe('Starting with the schema')
    expect(row.ref).not.toHaveProperty('messageId')
    expect(extractChatExecution({ ...execution, latestText: '  ', latestTextAt: new Date(), messages: [] })).toEqual([])
  })

  test('no row until the agent has said something', () => {
    expect(
      extractChatExecution({
        ...execution,
        messages: [{ id: 'm1', role: 'assistant', content: ' ', createdAt: new Date('2026-08-27T10:00:00Z') }],
      })
    ).toEqual([])
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

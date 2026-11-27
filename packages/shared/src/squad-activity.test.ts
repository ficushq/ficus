import { describe, expect, it } from 'bun:test'
import {
  coerceSquadActivityRef,
  activitySubjectLabel,
  activityAgentLabel,
  compareSquadActivityItems,
  makeSquadActivityId,
  parseSquadActivityId,
  activityRowContextLabel,
  activityStepLabel,
  activityWorkStreamCardState,
  hideRelayedSenderRows,
  type ActivityWorkStreamCard,
  RELAYED_SENDER_ROW_SLACK_MS,
  type SquadActivityItem,
} from './squad-activity'

const item = (id: string, at = '2026-08-26T12:00:00.123Z'): SquadActivityItem => ({
  id,
  at,
  agentId: null,
  agentTypeId: null,
  kind: 'wait',
  preview: [{ text: 'summary' }],
  summary: 'summary',
  ref: { type: 'workstream', workStreamId: '00000000-0000-4000-8000-000000000001' },
})

describe('squad activity identity and ordering', () => {
  it('creates and parses stable lane-prefixed UUID identities', () => {
    const rowId = '00000000-0000-4000-8000-0000000000ab'
    expect(makeSquadActivityId(41, rowId)).toBe(`41:${rowId}`)
    expect(parseSquadActivityId(`41:${rowId}`)).toEqual({ lane: 41, rowId })
  })

  it.each(['41:not-a-uuid', '99:00000000-0000-4000-8000-000000000001', '041:00000000-0000-4000-8000-000000000001'])(
    'rejects malformed identity %s',
    (id) => {
      expect(parseSquadActivityId(id)).toBeNull()
    }
  )

  it('creates and parses stable lane-70 PR identities', () => {
    const rowId = '00000000-0000-4000-8000-000000000070'
    expect(makeSquadActivityId(70, rowId)).toBe(`70:${rowId}`)
    expect(parseSquadActivityId(`70:${rowId}`)).toEqual({ lane: 70, rowId })
  })

  it('creates and parses stable lane-71 issue identities', () => {
    const rowId = '00000000-0000-4000-8000-000000000071'
    expect(makeSquadActivityId(71, rowId)).toBe(`71:${rowId}`)
    expect(parseSquadActivityId(`71:${rowId}`)).toEqual({ lane: 71, rowId })
  })

  it('sorts newest first, then descending lane and UUID', () => {
    const ids = [
      '40:00000000-0000-4000-8000-0000000000ff',
      '41:00000000-0000-4000-8000-000000000001',
      '41:00000000-0000-4000-8000-0000000000ff',
      '60:00000000-0000-4000-8000-000000000001',
    ]
    expect(
      ids
        .map((id) => item(id))
        .sort(compareSquadActivityItems)
        .map((value) => value.id)
    ).toEqual([ids[3], ids[2], ids[1], ids[0]])
    expect(
      [item(ids[3], '2026-08-26T12:00:00.122Z'), item(ids[0], '2026-08-26T12:00:00.124Z')]
        .sort(compareSquadActivityItems)
        .map((value) => value.id)
    ).toEqual([ids[0], ids[3]])
  })
})

describe('coerceSquadActivityRef', () => {
  it('returns an object ref unchanged', () => {
    const ref = { type: 'agent', agentId: 'a1', view: 'chat', executionId: 'e1' } as const
    expect(coerceSquadActivityRef(ref)).toBe(ref)
  })

  // tenant-zero legacy rows: the jsonb `ref` was double-encoded (persisted as a JSON string).
  it('parses a double-encoded (stringified) agent ref back into an object', () => {
    const raw = JSON.stringify({ type: 'agent', agentId: 'a1', view: 'chat', executionId: 'e1' })
    expect(coerceSquadActivityRef(raw)).toEqual({ type: 'agent', agentId: 'a1', view: 'chat', executionId: 'e1' })
  })

  it('parses a double-encoded pr ref back into an object', () => {
    const raw = JSON.stringify({ type: 'pr', url: 'https://github.com/x/y/pull/1' })
    expect(coerceSquadActivityRef(raw)).toEqual({ type: 'pr', url: 'https://github.com/x/y/pull/1' })
  })

  it('parses a double-encoded issue ref back into an object', () => {
    const raw = JSON.stringify({
      type: 'issue',
      url: 'https://github.com/x/y/issues/1',
      workStreamId: '00000000-0000-4000-8000-000000000001',
    })
    expect(coerceSquadActivityRef(raw)).toEqual({
      type: 'issue',
      url: 'https://github.com/x/y/issues/1',
      workStreamId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('returns a non-JSON string as-is (no throw)', () => {
    expect(coerceSquadActivityRef('not json')).toBe('not json' as never)
  })

  it('does not treat a JSON primitive string as an object ref', () => {
    // JSON.parse('"x"') === 'x' (a string, not an object) — must not be returned as a ref object.
    expect(coerceSquadActivityRef('"x"')).toBe('"x"' as never)
  })
})

describe('activity subject identity', () => {
  it('missing or redacted attribution is an agent, never system', () => {
    expect(activityAgentLabel(null)).toBe('Agent')
    expect(activityAgentLabel('code_review-bot')).toBe('Code Review Bot')
    // The configured type name wins, custom types included; the general type is never a bare "General".
    expect(activityAgentLabel('code_review-bot', 'Reviewer')).toBe('Reviewer')
    expect(activityAgentLabel('general')).toBe('General Purpose agent')
    expect(
      activitySubjectLabel({
        ...item('20:a'),
        agentTypeId: null,
        ref: { type: 'agent', agentId: 'recipient', view: 'inbox' },
      })
    ).toBe('Agent')
    const engineerRow = {
      ...item('20:b'),
      agentTypeId: 'engineer',
      ref: { type: 'agent' as const, agentId: 'a', view: 'chat' as const },
    }
    expect(activitySubjectLabel(engineerRow)).toBe('Engineer')
    expect(activitySubjectLabel(engineerRow, (id) => (id === 'engineer' ? 'Builder' : undefined))).toBe('Builder')
  })
  it('work variants identify the work destination with a stable fallback', () => {
    for (const kind of ['workstream', 'wait', 'handoff'] as const) {
      const row = {
        ...item('30:a'),
        kind,
        agentTypeId: 'manager',
        ref: { type: 'workstream' as const, workStreamId: 'abcd1234-5678', workStreamNumber: 42 },
      }
      expect(activitySubjectLabel(row)).toBe('Work stream #42')
      expect(activitySubjectLabel({ ...row, ref: { ...row.ref, workStreamNumber: undefined } })).toBe(
        'Work stream abcd1234'
      )
    }
  })
  it('external subjects identify their resource, with safe unavailable fallbacks', () => {
    expect(
      activitySubjectLabel({
        ...item('70:a'),
        ref: { type: 'pr', url: 'https://github.com/acme/app/pull/123#comment' },
      })
    ).toBe('PR #123')
    expect(activitySubjectLabel({ ...item('70:a'), ref: { type: 'pr', url: '' } })).toBe('Pull request')
    expect(
      activitySubjectLabel({ ...item('71:a'), ref: { type: 'issue', url: 'https://github.com/acme/app/issues/12' } })
    ).toBe('Issue #12')
    expect(activitySubjectLabel({ ...item('70:a'), ref: { type: 'future' } as never })).toBe('Activity')
    expect(activitySubjectLabel({ ...item('70:a'), ref: null as never })).toBe('Activity')
    expect(activitySubjectLabel({ ...item('30:a'), ref: { type: 'workstream' } as never })).toBe('Work stream')
  })
})

describe('activityRowContextLabel', () => {
  const agentRef = { type: 'agent' as const, agentId: 'a', view: 'chat' as const }
  const stream = {
    id: 'ws',
    number: 1352,
    title: 'Floating agent windows',
    squadId: 's',
    status: 'active' as const,
    step: 'Implement',
  }

  it('names a bound participant stream as number, title and step', () => {
    expect(activityRowContextLabel({ ref: agentRef, context: { workStream: stream, purpose: 'ignored' } })).toBe(
      '#1352 Floating agent windows · Implement'
    )
    expect(activityRowContextLabel({ ref: agentRef, context: { workStream: { ...stream, step: null } } })).toBe(
      '#1352 Floating agent windows'
    )
  })

  it('falls back to the purpose, then to nothing (the type label alone)', () => {
    expect(activityRowContextLabel({ ref: agentRef, context: { purpose: ' Squad coordination ' } })).toBe(
      'Squad coordination'
    )
    expect(activityRowContextLabel({ ref: agentRef })).toBeNull()
    expect(activityRowContextLabel({ ref: agentRef, context: { purpose: '  ' } })).toBeNull()
  })

  it('never labels a row whose subject is not an agent', () => {
    expect(
      activityRowContextLabel({ ref: { type: 'workstream', workStreamId: 'ws' }, context: { workStream: stream } })
    ).toBeNull()
  })
})

describe('hideRelayedSenderRows', () => {
  const sender = { id: '10:exec', at: '2026-11-20T08:00:00.000Z' }
  const received = (id: string, at = '2026-11-20T08:00:05.000Z') => ({ id, at, senderActivityId: '10:exec' })
  const other = { id: '10:other', at: '2026-11-20T07:59:00.000Z' }

  it('hides the sender row while a matching received row is shown', () => {
    expect(hideRelayedSenderRows([received('20:a'), sender, other]).map((row) => row.id)).toEqual(['20:a', '10:other'])
  })

  it('keeps the sender row when the received row is filtered out or in a squad the viewer cannot see', () => {
    // The caller passes only shown rows, so an absent received row is exactly this case.
    expect(hideRelayedSenderRows([sender, other]).map((row) => row.id)).toEqual(['10:exec', '10:other'])
  })

  it('hides the sender row when any one of several recipients is shown', () => {
    expect(hideRelayedSenderRows([received('20:a'), received('20:b'), sender]).map((row) => row.id)).toEqual([
      '20:a',
      '20:b',
    ])
    expect(hideRelayedSenderRows([received('20:b'), sender]).map((row) => row.id)).toEqual(['20:b'])
  })

  it('keeps a sender row that moved on well after sending', () => {
    const later = {
      ...sender,
      at: new Date(Date.parse(received('x').at) + RELAYED_SENDER_ROW_SLACK_MS + 1).toISOString(),
    }
    expect(hideRelayedSenderRows([later, received('20:a')]).map((row) => row.id)).toEqual(['10:exec', '20:a'])
    // A step's message row lands after its tool calls, so a slightly later sender row is still the send.
    const justAfter = { ...sender, at: '2026-11-20T08:00:30.000Z' }
    expect(hideRelayedSenderRows([justAfter, received('20:a')]).map((row) => row.id)).toEqual(['20:a'])
  })
})

describe('Active work row state and step labels', () => {
  it('capitalizes each running step so lower-case step names match the rest', () => {
    expect(activityStepLabel('implement')).toBe('Implement')
    expect(activityStepLabel('implement + review')).toBe('Implement + Review')
    expect(activityStepLabel('Completion-ready')).toBe('Completion-ready')
    expect(activityStepLabel('  ')).toBeNull()
    expect(activityStepLabel(null)).toBeNull()
  })

  it('normalizes the step in the row context line', () => {
    const ref = { type: 'agent' as const, agentId: 'a', view: 'chat' as const }
    const workStream = {
      id: 'ws',
      number: 1395,
      title: 'Spend',
      squadId: 's',
      status: 'active' as const,
      step: 'implement',
    }
    expect(activityRowContextLabel({ ref, context: { workStream } })).toBe('#1395 Spend · Implement')
  })

  const card = (overrides: Partial<ActivityWorkStreamCard> = {}) => ({
    needsYou: false,
    workingAgentIds: [] as string[],
    step: 'Implement' as string | null,
    waits: [] as ActivityWorkStreamCard['waits'],
    status: 'active' as const,
    ...overrides,
  })

  it('gives every row exactly one state, in precedence order', () => {
    expect(activityWorkStreamCardState(card({ needsYou: true, workingAgentIds: ['a'] }))).toBe('needs-you')
    expect(activityWorkStreamCardState(card({ workingAgentIds: ['a'], derivedState: 'paused' }))).toBe('working')
    expect(activityWorkStreamCardState(card({ derivedState: 'paused' }))).toBe('paused')
    expect(activityWorkStreamCardState(card({ step: 'Paused' }))).toBe('paused')
    expect(activityWorkStreamCardState(card({ waits: [{ type: 'dependency', needsYou: false }] }))).toBe('waiting')
    expect(activityWorkStreamCardState(card({ derivedState: 'awaiting_delivery' }))).toBe('waiting')
    expect(activityWorkStreamCardState(card({ status: 'queued', step: null }))).toBe('queued')
    expect(activityWorkStreamCardState(card())).toBe('idle')
  })

  it('reads a participant queued for a slot as waiting, not idle', () => {
    const slotWait = { poolKey: 'heavy-work', attemptId: 1, position: 1, queuedCount: 3, queuedAt: '' }
    expect(activityWorkStreamCardState(card({ derivedState: 'idle', slotWait }))).toBe('waiting')
    // Running work and pause keep their precedence.
    expect(activityWorkStreamCardState(card({ derivedState: 'idle', slotWait, workingAgentIds: ['a'] }))).toBe(
      'working'
    )
    expect(activityWorkStreamCardState(card({ derivedState: 'paused', slotWait }))).toBe('paused')
  })
})

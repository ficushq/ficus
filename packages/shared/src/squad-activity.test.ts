import { describe, expect, it } from 'bun:test'
import {
  coerceSquadActivityRef,
  activitySubjectLabel,
  activityAgentLabel,
  compareSquadActivityItems,
  makeSquadActivityId,
  parseSquadActivityId,
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
    expect(
      activitySubjectLabel({
        ...item('20:a'),
        agentTypeId: null,
        ref: { type: 'agent', agentId: 'recipient', view: 'inbox' },
      })
    ).toBe('Agent')
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

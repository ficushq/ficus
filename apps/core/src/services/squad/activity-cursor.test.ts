import { describe, expect, it } from 'bun:test'
import {
  ActivityCursorExpiredError,
  decodeActivityCursor,
  decodeGlobalActivityCursor,
  encodeActivityCursor,
  encodeGlobalActivityCursor,
  InvalidActivityCursorError,
} from './activity-cursor'

const squadId = '00000000-0000-4000-8000-000000000001'
const waitId = '00000000-0000-4000-8000-000000000002'
const context = { squadId, verbose: false, agentIds: [] as string[], kinds: [] as string[] }
const keyset = {
  at: new Date('2026-08-26T12:00:00.123Z'),
  lane: 41 as const,
  rowId: waitId,
  retentionFloor: new Date('2026-07-27T00:00:00.000Z'),
}
const encodePayload = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url')

describe('activity cursor', () => {
  it('round trips a frozen total-order key', () => {
    expect(decodeActivityCursor(encodeActivityCursor(keyset, context), context)).toEqual(keyset)
  })

  it.each(['', 'not+base64url', 'a'.repeat(1001), encodePayload({})])('rejects malformed cursor %p', (cursor) => {
    expect(() => decodeActivityCursor(cursor, context)).toThrow(InvalidActivityCursorError)
  })

  it('rejects extra and missing keys', () => {
    const valid = JSON.parse(Buffer.from(encodeActivityCursor(keyset, context), 'base64url').toString('utf8'))
    expect(() => decodeActivityCursor(encodePayload({ ...valid, extra: true }), context)).toThrow(
      InvalidActivityCursorError
    )
    const { rowId: _rowId, ...missing } = valid
    expect(() => decodeActivityCursor(encodePayload(missing), context)).toThrow(InvalidActivityCursorError)
  })

  it('rejects invalid versions, timestamps, UUIDs, lanes, and digests', () => {
    const valid = JSON.parse(Buffer.from(encodeActivityCursor(keyset, context), 'base64url').toString('utf8'))
    for (const changes of [
      { v: 1 },
      { at: '2026-08-26T12:00:00Z' },
      { rowId: 'not-a-uuid' },
      { lane: 99 },
      { queryDigest: 'x' },
    ])
      expect(() => decodeActivityCursor(encodePayload({ ...valid, ...changes }), context)).toThrow(
        InvalidActivityCursorError
      )
  })

  it('expires when the current UTC retention floor advances', () => {
    const cursor = encodeActivityCursor(keyset, context)
    expect(() => decodeActivityCursor(cursor, context, new Date('2026-07-28T00:00:00.000Z'))).toThrow(
      ActivityCursorExpiredError
    )
  })

  it('binds the cursor to normalized squad and filter context but not page size', () => {
    const cursor = encodeActivityCursor(keyset, {
      squadId,
      verbose: true,
      agentIds: ['b', 'a', 'a'],
      kinds: ['wait', 'message', 'wait'],
    })
    expect(
      decodeActivityCursor(cursor, {
        squadId,
        verbose: true,
        agentIds: ['a', 'b'],
        kinds: ['message', 'wait'],
      })
    ).toEqual(keyset)
    for (const changed of [{ squadId: waitId }, { verbose: false }, { agentIds: ['a'] }, { kinds: ['wait'] }])
      expect(() =>
        decodeActivityCursor(cursor, {
          squadId,
          verbose: true,
          agentIds: ['a', 'b'],
          kinds: ['message', 'wait'],
          ...changed,
        })
      ).toThrow(InvalidActivityCursorError)
  })
})

describe('global activity cursor', () => {
  const otherSquadId = '00000000-0000-4000-8000-000000000003'
  const globalContext = {
    squadIds: [squadId, otherSquadId],
    verbose: false,
    agentIds: [] as string[],
    kinds: [] as string[],
  }
  const globalKeyset = {
    at: new Date('2026-08-26T12:00:00.123Z'),
    squadId,
    lane: 41 as const,
    rowId: waitId,
    retentionFloor: new Date('2026-07-27T00:00:00.000Z'),
  }

  it('round trips a frozen total-order key, including the squad-id tiebreaker', () => {
    expect(decodeGlobalActivityCursor(encodeGlobalActivityCursor(globalKeyset, globalContext), globalContext)).toEqual(
      globalKeyset
    )
  })

  it.each(['', 'not+base64url', 'a'.repeat(1001), encodePayload({})])('rejects malformed cursor %p', (cursor) => {
    expect(() => decodeGlobalActivityCursor(cursor, globalContext)).toThrow(InvalidActivityCursorError)
  })

  it('rejects extra and missing keys', () => {
    const valid = JSON.parse(
      Buffer.from(encodeGlobalActivityCursor(globalKeyset, globalContext), 'base64url').toString('utf8')
    )
    expect(() => decodeGlobalActivityCursor(encodePayload({ ...valid, extra: true }), globalContext)).toThrow(
      InvalidActivityCursorError
    )
    const { squadId: _squadId, ...missing } = valid
    expect(() => decodeGlobalActivityCursor(encodePayload(missing), globalContext)).toThrow(InvalidActivityCursorError)
  })

  it('rejects invalid versions, timestamps, UUIDs, lanes, and digests', () => {
    const valid = JSON.parse(
      Buffer.from(encodeGlobalActivityCursor(globalKeyset, globalContext), 'base64url').toString('utf8')
    )
    for (const changes of [
      { v: 2 },
      { at: '2026-08-26T12:00:00Z' },
      { squadId: 'not-a-uuid' },
      { rowId: 'not-a-uuid' },
      { lane: 99 },
      { queryDigest: 'x' },
    ])
      expect(() => decodeGlobalActivityCursor(encodePayload({ ...valid, ...changes }), globalContext)).toThrow(
        InvalidActivityCursorError
      )
  })

  it('binds the cursor to the normalized accessible-squad set and filter context but not page size', () => {
    const cursor = encodeGlobalActivityCursor(globalKeyset, {
      squadIds: [otherSquadId, squadId, squadId],
      verbose: true,
      agentIds: ['b', 'a', 'a'],
      kinds: ['wait', 'message', 'wait'],
    })
    expect(
      decodeGlobalActivityCursor(cursor, {
        squadIds: [squadId, otherSquadId],
        verbose: true,
        agentIds: ['a', 'b'],
        kinds: ['message', 'wait'],
      })
    ).toEqual({ ...globalKeyset })
    for (const changed of [{ squadIds: [squadId] }, { verbose: false }, { agentIds: ['a'] }, { kinds: ['wait'] }])
      expect(() =>
        decodeGlobalActivityCursor(cursor, {
          squadIds: [squadId, otherSquadId],
          verbose: true,
          agentIds: ['a', 'b'],
          kinds: ['message', 'wait'],
          ...changed,
        })
      ).toThrow(InvalidActivityCursorError)
  })

  it("binds a settled filter's end, and an unbounded settled cursor still decodes", () => {
    const since = '2026-08-26T09:00:00.000Z'
    const until = '2026-08-26T12:00:00.000Z'
    const bounded = { ...globalContext, settled: { kind: 'questions' as const, since, until } }
    const unbounded = { ...globalContext, settled: { kind: 'questions' as const, since } }
    const cursor = encodeGlobalActivityCursor(globalKeyset, bounded)
    expect(decodeGlobalActivityCursor(cursor, bounded)).toEqual(globalKeyset)
    for (const changed of [unbounded, { ...globalContext, settled: { ...bounded.settled, until: since } }])
      expect(() => decodeGlobalActivityCursor(cursor, changed)).toThrow(InvalidActivityCursorError)
    // Without `until` the digest is the one cursors had before the bound existed.
    const plain = encodeGlobalActivityCursor(globalKeyset, unbounded)
    expect(
      decodeGlobalActivityCursor(plain, { ...unbounded, settled: { ...unbounded.settled, until: undefined } })
    ).toEqual(globalKeyset)
    expect(() => decodeGlobalActivityCursor(plain, bounded)).toThrow(InvalidActivityCursorError)
  })

  it('never decodes a per-squad cursor, and vice versa (distinct key sets)', () => {
    const perSquadCursor = encodeActivityCursor(keyset, context)
    expect(() =>
      decodeGlobalActivityCursor(perSquadCursor, { squadIds: [squadId], verbose: false, agentIds: [], kinds: [] })
    ).toThrow(InvalidActivityCursorError)

    const globalCursor = encodeGlobalActivityCursor(globalKeyset, globalContext)
    expect(() => decodeActivityCursor(globalCursor, context)).toThrow(InvalidActivityCursorError)
  })
})

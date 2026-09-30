import { describe, expect, test } from 'bun:test'
import {
  dayLabel,
  earliestMessageDate,
  fullTimestamp,
  messageTimeLabel,
  startsGroup,
  toMessageDate,
  type TimestampGroupEntry,
} from './chatTimestamps'

const NOW = new Date(2026, 8, 29, 16, 0, 0)

function human(at: Date | null, senderKey: string | null = null): TimestampGroupEntry {
  return { kind: 'human', senderKey, at }
}

function agent(at: Date | null): TimestampGroupEntry {
  return { kind: 'agent', senderKey: null, at }
}

describe('startsGroup', () => {
  const base = new Date(2026, 8, 29, 15, 42, 0)
  const plus = (ms: number) => new Date(base.getTime() + ms)

  test('the first message starts a group', () => {
    expect(startsGroup(null, human(base))).toBe(true)
  })

  test('a message within five minutes of the previous one continues the group', () => {
    expect(startsGroup(human(base), human(plus(4 * 60_000)))).toBe(false)
    expect(startsGroup(human(base), human(plus(5 * 60_000)))).toBe(false)
  })

  test('a gap over five minutes starts a new group', () => {
    expect(startsGroup(human(base), human(plus(5 * 60_000 + 1)))).toBe(true)
    expect(startsGroup(human(base), human(plus(6 * 60_000)))).toBe(true)
  })

  test('a sender change starts a new group', () => {
    expect(startsGroup(human(base, 'alice'), human(plus(1_000), 'bob'))).toBe(true)
    expect(startsGroup(human(base, 'alice'), human(plus(1_000), null))).toBe(true)
    expect(startsGroup(human(base, 'alice'), human(plus(1_000), 'alice'))).toBe(false)
    expect(startsGroup(human(base), human(plus(1_000)))).toBe(false)
  })

  test('a switch between human and agent starts a new group', () => {
    expect(startsGroup(human(base), agent(plus(1_000)))).toBe(true)
    expect(startsGroup(agent(base), human(plus(1_000)))).toBe(true)
    expect(startsGroup(agent(base), agent(plus(1_000)))).toBe(false)
  })

  test('a local day change starts a new group even within five minutes', () => {
    const late = new Date(2026, 8, 28, 23, 59, 0)
    const early = new Date(2026, 8, 29, 0, 1, 0)
    expect(startsGroup(agent(late), agent(early))).toBe(true)
  })

  test('a missing createdAt on either side starts a new group', () => {
    expect(startsGroup(human(null), human(base))).toBe(true)
    expect(startsGroup(human(base), human(null))).toBe(true)
  })
})

describe('dayLabel', () => {
  test('today', () => {
    expect(dayLabel(new Date(2026, 8, 29, 0, 0, 1), NOW)).toBe('Today')
  })

  test('yesterday', () => {
    expect(dayLabel(new Date(2026, 8, 28, 23, 59), NOW)).toBe('Yesterday')
    // Across a month boundary.
    expect(dayLabel(new Date(2026, 8, 30, 12), new Date(2026, 9, 1, 9))).toBe('Yesterday')
  })

  test('an earlier day this year omits the year', () => {
    const date = new Date(2026, 8, 27, 12)
    const label = dayLabel(date, NOW)
    expect(label).toBe(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(label).not.toContain('2026')
  })

  test('another year includes the year', () => {
    const date = new Date(2025, 11, 31, 12)
    const label = dayLabel(date, new Date(2026, 0, 2, 9))
    expect(label).toBe(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
    expect(label).toContain('2025')
  })

  test('the previous calendar day in another year is still Yesterday', () => {
    expect(dayLabel(new Date(2025, 11, 31, 23), new Date(2026, 0, 1, 1))).toBe('Yesterday')
  })
})

describe('time labels', () => {
  test('messageTimeLabel is a clock time without seconds', () => {
    const date = new Date(2026, 8, 29, 15, 42, 10)
    expect(messageTimeLabel(date)).toBe(date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
    expect(messageTimeLabel(date)).toContain('42')
    expect(messageTimeLabel(date)).not.toContain('10')
  })

  test('fullTimestamp includes weekday, date and seconds', () => {
    const label = fullTimestamp(new Date(2026, 8, 29, 15, 42, 10))
    expect(label).toContain('2026')
    expect(label).toContain('29')
    expect(label).toContain('42:10')
  })
})

describe('missing createdAt', () => {
  test('toMessageDate returns null for absent or invalid values', () => {
    expect(toMessageDate(undefined)).toBeNull()
    expect(toMessageDate(null)).toBeNull()
    expect(toMessageDate('')).toBeNull()
    expect(toMessageDate('not a date')).toBeNull()
  })

  test('toMessageDate accepts ISO strings, Dates and epoch ms', () => {
    const date = new Date(2026, 8, 29, 15, 42)
    expect(toMessageDate(date.toISOString())?.getTime()).toBe(date.getTime())
    expect(toMessageDate(date)?.getTime()).toBe(date.getTime())
    expect(toMessageDate(date.getTime())?.getTime()).toBe(date.getTime())
  })

  test('earliestMessageDate picks the first valid time and ignores missing ones', () => {
    const a = new Date(2026, 8, 29, 15, 42)
    const b = new Date(2026, 8, 29, 15, 40)
    expect(earliestMessageDate([a.toISOString(), undefined, b.toISOString(), 'bad'])?.getTime()).toBe(b.getTime())
    expect(earliestMessageDate([undefined, null])).toBeNull()
    expect(earliestMessageDate([])).toBeNull()
  })
})

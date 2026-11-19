import { expect, test } from 'bun:test'
import { createProgressWriter } from './progress-stream'
test('writer sequences safe frames and has one terminal winner', async () => {
  const frames: string[] = []
  const writer = createProgressWriter(
    async (frame) => {
      frames.push(frame)
    },
    () => {},
    new AbortController().signal
  )
  await writer.publish({ type: 'started' })
  await writer.publish({ type: 'error', error: { code: 'derivation_failed' } })
  await expect(writer.publish({ type: 'started' })).rejects.toBeDefined()
  expect(frames).toHaveLength(2)
  expect(frames[0]).toContain('"seq":1')
  expect(frames[1]).toContain('"seq":2')
  writer.dispose()
})
test('blocked writes cancel ownership within the write deadline', async () => {
  let cancelled = false
  const writer = createProgressWriter(
    async () => new Promise(() => {}),
    () => {
      cancelled = true
    },
    new AbortController().signal,
    { writeMs: 5 }
  )
  await expect(writer.publish({ type: 'started' })).rejects.toBeDefined()
  expect(cancelled).toBe(true)
  writer.dispose()
})

test('backpressure queue and event budget are bounded', async () => {
  let cancelled = 0
  const writer = createProgressWriter(
    async () => new Promise(() => {}),
    () => {
      cancelled++
    },
    new AbortController().signal,
    { writeMs: 5 }
  )
  await Promise.all(
    Array.from({ length: 10 }, () => writer.publish({ type: 'phase', phase: 'collecting' }).catch(() => {}))
  )
  expect(cancelled).toBeGreaterThan(0)
  writer.dispose()
  const bounded = createProgressWriter(
    async () => {},
    () => {
      cancelled++
    },
    new AbortController().signal
  )
  try {
    for (let i = 0; i < 511; i++) await bounded.publish({ type: 'phase', phase: 'collecting' })
    await expect(bounded.publish({ type: 'phase', phase: 'collecting' })).rejects.toThrow('limit')
    await bounded.publish({ type: 'error', error: { code: 'derivation_failed' } })
  } finally {
    bounded.dispose()
  }
})

test('an idle timed-out stream can send a best-effort typed terminal without waiting on work', async () => {
  const controller = new AbortController()
  const frames: string[] = []
  const writer = createProgressWriter(
    async (frame) => {
      frames.push(frame)
    },
    () => {},
    controller.signal
  )
  await writer.publish({ type: 'started' })
  controller.abort()
  await writer.timeout()
  expect(frames.at(-1)).toContain('derivation_timed_out')
  await writer.timeout()
  expect(frames).toHaveLength(2)
  writer.dispose()
})

test('rejected schema events do not consume a sequence number or prevent the terminal error', async () => {
  const frames: string[] = []
  const writer = createProgressWriter(
    async (frame) => {
      frames.push(frame)
    },
    () => {},
    new AbortController().signal
  )
  try {
    await writer.publish({ type: 'started' })
    await expect(writer.publish({ type: 'finding', index: 0, text: 'x'.repeat(161) })).rejects.toBeDefined()
    await writer.publish({ type: 'error', error: { code: 'derivation_failed' } })
    expect(frames.map((frame) => JSON.parse(frame.split('data: ')[1]!).seq)).toEqual([1, 2])
  } finally {
    writer.dispose()
  }
})
test('terminal preparation rejects an invalid result without consuming ownership or stream state', async () => {
  const frames: string[] = []
  const writer = createProgressWriter(
    async (frame) => {
      frames.push(frame)
    },
    () => {},
    new AbortController().signal
  )
  try {
    await writer.publish({ type: 'started' })
    expect(() => writer.prepareTerminal({ type: 'complete', result: {} as any })).toThrow()
    const send = writer.prepareTerminal({ type: 'error', error: { code: 'derivation_failed' } })
    await send()
    expect(frames.at(-1)).toContain('"seq":2')
  } finally {
    writer.dispose()
  }
})

test('an oversized complete frame preserves sequence and capacity for a terminal error', async () => {
  const frames: string[] = []
  const name = 'a'.repeat(39) + '/' + 'b'.repeat(100)
  const names = Array.from({ length: 120 }, () => name)
  const result = {
    login: 'octo',
    draft: {
      base: 'a'.repeat(2000),
      surfaces: Object.fromEntries(
        ['commits', 'pullRequests', 'reviewReplies', 'issueComments', 'channels'].map((key) => [
          key,
          { mode: 'add', text: 'b'.repeat(2000) },
        ])
      ),
    },
    observations: Array.from({ length: 12 }, () => 'c'.repeat(160)),
    exemplars: Array.from({ length: 6 }, () => ({ surface: 'commits', text: 'd'.repeat(240), repository: name })),
    sampling: {
      filters: { repositories: names.slice(0, 50), excludeRepositories: names.slice(0, 50) },
      counts: {
        collected: 120,
        kept: 120,
        droppedByFilter: { date: 0, repository: 0 },
        droppedAsToolAuthored: 0,
        droppedAsTemplate: 0,
      },
      dateRange: {},
      publicRepositories: names,
      privateRepositories: names,
      pagingCapped: false,
    },
    bytes: 2000,
    maxBytes: 2000,
  }
  const writer = createProgressWriter(
    async (frame) => {
      frames.push(frame)
    },
    () => {},
    new AbortController().signal
  )
  try {
    await writer.publish({ type: 'started' })
    expect(() => writer.prepareTerminal({ type: 'complete', result: result as any })).toThrow('frame_limit')
    await writer.publish({ type: 'error', error: { code: 'derivation_failed' } })
    expect(frames.map((frame) => JSON.parse(frame.split('data: ')[1]!).seq)).toEqual([1, 2])
  } finally {
    writer.dispose()
  }
})

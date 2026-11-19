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
    for (let i = 0; i < 512; i++) await bounded.publish({ type: 'phase', phase: 'collecting' })
    await expect(bounded.publish({ type: 'phase', phase: 'collecting' })).rejects.toThrow('limit')
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

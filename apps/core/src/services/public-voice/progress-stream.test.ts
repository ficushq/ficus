import { expect, test } from 'bun:test'
import { createProgressWriter } from './progress-stream'
test('writer sequences safe frames and has one terminal winner', async () => {
  const frames: string[] = []
  const writer = createProgressWriter(async frame => { frames.push(frame) }, () => {}, new AbortController().signal)
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
  const writer = createProgressWriter(async () => new Promise(() => {}), () => { cancelled = true }, new AbortController().signal, { writeMs: 5 })
  await expect(writer.publish({ type: 'started' })).rejects.toBeDefined()
  expect(cancelled).toBe(true)
  writer.dispose()
})

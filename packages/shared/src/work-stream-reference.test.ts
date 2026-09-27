import { expect, test } from 'bun:test'
import { workStreamLabel, workStreamRef } from './work-stream-reference'
import { pushAlertText, relaySendSchema } from './push-relay'
test('work labels and links prefer public numbers', () => {
  expect(workStreamLabel({ id: 'internal', number: 42 })).toBe('#42')
  expect(workStreamRef({ id: 'internal', number: 42 })).toBe('42')
})
test('notifications distinguish events without private content, with explicit previews', () => {
  expect(pushAlertText({ eventType: 'question', workStreamNumber: 42 })).toEqual({
    title: 'Work #42 needs your answer',
    body: 'Open Tau to see details.',
  })
  expect(pushAlertText({ eventType: 'review' }).title).toBe('Work is ready for review')
  expect(pushAlertText({ eventType: 'done', workStreamNumber: 42 }).title).toBe('Work #42 completed')
  expect(pushAlertText({ preview: { title: 'Allowed preview', body: 'Details' } })).toEqual({
    title: 'Allowed preview',
    body: 'Details',
  })
  const request = {
    version: 1,
    bindingToken: `ficus_prd_${'a'.repeat(43)}`,
    eventId: crypto.randomUUID(),
    routing: { eventType: 'question', workStreamNumber: 42 },
  }
  expect(relaySendSchema.safeParse(request).success).toBe(true)
  expect(
    relaySendSchema.safeParse({ ...request, routing: { ...request.routing, title: 'Not permitted' } }).success
  ).toBe(false)
  expect(relaySendSchema.safeParse({ ...request, routing: { eventType: 'arbitrary' } }).success).toBe(false)
})

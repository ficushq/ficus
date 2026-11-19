import { expect, test } from 'bun:test'
import { derivationEventSchema, safeDerivationFailure } from './public-voice-progress'

test('metadata is strict and never accepts sample text or terminal controls', () => {
  const event = { version: 1, runId: 'fixture', seq: 1, type: 'repositories', repositories: [{ name: 'example/library', activity: 'activity_read' }] }
  expect(derivationEventSchema.safeParse(event).success).toBe(true)
  expect(derivationEventSchema.safeParse({ ...event, text: 'private sentinel' }).success).toBe(false)
  expect(derivationEventSchema.safeParse({ ...event, repositories: [{ ...event.repositories[0], name: 'example/\u001blibrary' }] }).success).toBe(false)
})
test('failure projection excludes arbitrary details and unknown reasons', () => {
  expect(safeDerivationFailure('derivation_invalid_output', { reason: 'private sentinel', text: 'private sentinel' })).toEqual({ code: 'derivation_invalid_output', reason: 'unknown' })
})

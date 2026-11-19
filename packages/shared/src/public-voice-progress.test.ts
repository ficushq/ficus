import { expect, test } from 'bun:test'
import { derivationFiltersSchema } from './public-voice'
import { acceptsVoiceDerivationProgress, VOICE_DERIVATION_ACCEPT } from './public-voice-progress'
import { derivationEventSchema, emptySamplingBreakdown, safeDerivationFailure } from './public-voice-progress'

test('metadata is strict and never accepts sample text or terminal controls', () => {
  const event = {
    version: 1,
    runId: 'fixture',
    seq: 1,
    type: 'repositories',
    repositories: [{ name: 'example/library', activity: 'activity_read' }],
  }
  expect(derivationEventSchema.safeParse(event).success).toBe(true)
  expect(derivationEventSchema.safeParse({ ...event, text: 'private sentinel' }).success).toBe(false)
  expect(
    derivationEventSchema.safeParse({
      ...event,
      repositories: [{ ...event.repositories[0], name: 'example/\u001blibrary' }],
    }).success
  ).toBe(false)
})
test('failure projection excludes arbitrary details and unknown reasons', () => {
  expect(
    safeDerivationFailure('derivation_invalid_output', { reason: 'private sentinel', text: 'private sentinel' })
  ).toEqual({ code: 'derivation_invalid_output', reason: 'unknown' })
})

test('counts reject negative, inconsistent and unknown drop reasons', () => {
  const snapshot = emptySamplingBreakdown()
  const event = { version: 1, runId: 'fixture', seq: 2, type: 'counts', provisional: true, ...snapshot }
  expect(derivationEventSchema.safeParse(event).success).toBe(true)
  snapshot.totals.seen = -1
  expect(derivationEventSchema.safeParse(event).success).toBe(false)
  snapshot.totals.seen = 1
  expect(derivationEventSchema.safeParse(event).success).toBe(false)
  expect(derivationEventSchema.safeParse({ ...event, extra: { sample: 'private' } }).success).toBe(false)
})

test('repository filter names are bounded before starting expensive work', () => {
  expect(derivationFiltersSchema.safeParse({ repositories: ['a/' + 'b'.repeat(138)] }).success).toBe(true)
  expect(derivationFiltersSchema.safeParse({ repositories: ['a/' + 'b'.repeat(139)] }).success).toBe(false)
})

test('frozen progress versions negotiate before work, including implicit version 1', () => {
  expect(acceptsVoiceDerivationProgress('text/event-stream')).toBe(true)
  expect(acceptsVoiceDerivationProgress(VOICE_DERIVATION_ACCEPT)).toBe(true)
  expect(acceptsVoiceDerivationProgress('text/event-stream; version=2')).toBe(false)
  expect(acceptsVoiceDerivationProgress('text/event-stream; version=1; q=0')).toBe(false)
  expect(acceptsVoiceDerivationProgress('application/json')).toBe(false)
})

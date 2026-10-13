import { expect, test } from 'bun:test'
import type { ScreenshotGuess } from '@ficus/shared'
import {
  INITIAL_REVIEW,
  NO_SQUAD,
  fileScreenshotRequest,
  picksWorkStream,
  reviewReducer,
  unsureFields,
  type ReviewEvent,
  type ReviewState,
} from './screenshotFiling'

const CHLEA = '11111111-1111-4111-8111-111111111111'
const OPS = '22222222-2222-4222-8222-222222222222'
const EXPORT = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Fix the export crash' }
const DOCS = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Rewrite the docs' }
const IMAGE = '44444444-4444-4444-8444-444444444444'

const guess: ScreenshotGuess = {
  kind: { id: 'bug', label: 'a bug', probability: 0.88 },
  squad: { id: CHLEA, name: 'Chlea', probability: 0.41 },
  action: { id: 'existing_work_stream', label: 'add it to an existing work stream', probability: 0.83 },
  workStream: { ...EXPORT, probability: 0.83 },
}

const after = (events: ReviewEvent[], from: ReviewState = INITIAL_REVIEW) => events.reduce(reviewReducer, from)
const guessed = after([{ type: 'guessed', guess }])

test('the card opens with nothing chosen and the guess still loading; typing a note does not wait for it', () => {
  expect(INITIAL_REVIEW.guess).toBeUndefined()
  expect(INITIAL_REVIEW.choices).toEqual({ kind: null, squad: null, action: null, workStreamId: null })
  const typed = after([{ type: 'note', note: 'Broke after the coupon change' }])
  expect(typed.guess).toBeUndefined()
  // The guess fills the pickers in and keeps the note.
  const filled = reviewReducer(typed, { type: 'guessed', guess })
  expect(filled.note).toBe('Broke after the coupon change')
  expect(filled.choices).toEqual({
    kind: 'bug',
    squad: CHLEA,
    action: 'existing_work_stream',
    workStreamId: EXPORT.id,
  })
})

test('a guess under 0.6 is still pre-selected and marked "not sure" until the user sets that field', () => {
  expect(guessed.choices.squad).toBe(CHLEA)
  expect(unsureFields(guessed)).toEqual(['squad'])
  // Exactly 0.6 is sure.
  const edge = after([{ type: 'guessed', guess: { ...guess, squad: { ...guess.squad!, probability: 0.6 } } }])
  expect(unsureFields(edge)).toEqual([])
  // Picking another squad, or the same one again, makes it the user's choice.
  expect(unsureFields(reviewReducer(guessed, { type: 'squad', squad: OPS }))).toEqual([])
  expect(unsureFields(reviewReducer(guessed, { type: 'squad', squad: CHLEA }))).toEqual([])
  // Every weak field is marked, "No squad" included.
  const weak = after([
    {
      type: 'guessed',
      guess: {
        kind: { id: 'idea', label: 'an idea or feature request', probability: 0.3 },
        squad: null,
        noSquadProbability: 0.5,
        action: { id: 'just_save', label: 'just save it', probability: 0.59 },
      },
    },
  ])
  expect(weak.choices).toEqual({ kind: 'idea', squad: NO_SQUAD, action: 'just_save', workStreamId: null })
  expect(unsureFields(weak)).toEqual(['kind', 'squad', 'action'])
  expect(unsureFields(reviewReducer(weak, { type: 'kind', kind: 'bug' }))).toEqual(['squad', 'action'])
  // Nothing is "not sure" while loading or without a guess.
  expect(unsureFields(INITIAL_REVIEW)).toEqual([])
  expect(unsureFields(after([{ type: 'guessed', guess: null }]))).toEqual([])
})

test('with no guess the pickers stay unselected and every field can be picked by hand', () => {
  const none = after([
    { type: 'note', note: 'hi' },
    { type: 'guessed', guess: null },
  ])
  expect(none.guess).toBeNull()
  expect(none.choices).toEqual(INITIAL_REVIEW.choices)
  expect(fileScreenshotRequest(IMAGE, none)).toEqual({ imageId: IMAGE, note: 'hi' })
  const picked = after(
    [
      { type: 'kind', kind: 'design_feedback' },
      { type: 'squad', squad: OPS },
      { type: 'action', action: 'ask_consultant' },
    ],
    none
  )
  expect(fileScreenshotRequest(IMAGE, picked)).toEqual({
    imageId: IMAGE,
    note: 'hi',
    kind: 'design_feedback',
    squadId: OPS,
    action: 'ask_consultant',
  })
  // The model was not asked about squads (the user sees none): the squad stays unchosen.
  const { squad: _squad, workStream: _stream, ...unasked } = guess
  expect(after([{ type: 'guessed', guess: { ...unasked, squad: null } }]).choices.squad).toBeNull()
})

test('changing the squad clears the work stream and waits for the new squad’s open ones', () => {
  const moved = reviewReducer(guessed, { type: 'squad', squad: OPS })
  expect(moved.choices).toEqual({ kind: 'bug', squad: OPS, action: 'existing_work_stream', workStreamId: null })
  expect(picksWorkStream(moved.choices)).toBe(true)
  // Streams that load for a squad no longer selected change nothing.
  expect(reviewReducer(moved, { type: 'workStreams', squad: CHLEA, workStreams: [] })).toBe(moved)
  // The new squad has some: the action stands and one can be picked.
  const some = reviewReducer(moved, { type: 'workStreams', squad: OPS, workStreams: [DOCS] })
  expect(some).toBe(moved)
  expect(reviewReducer(some, { type: 'workStream', workStreamId: DOCS.id }).choices.workStreamId).toBe(DOCS.id)
  // The new squad has none: fall back to starting a new work stream.
  const none = reviewReducer(moved, { type: 'workStreams', squad: OPS, workStreams: [] })
  expect(none.choices).toEqual({ kind: 'bug', squad: OPS, action: 'new_work_stream', workStreamId: null })
  expect(picksWorkStream(none.choices)).toBe(false)
  // Another action is left alone when the new squad has none.
  const saved = after(
    [
      { type: 'action', action: 'just_save' },
      { type: 'squad', squad: OPS },
      { type: 'workStreams', squad: OPS, workStreams: [] },
    ],
    guessed
  )
  expect(saved.choices.action).toBe('just_save')
})

test('"No squad" has no work streams: "existing" falls back at once and cannot be chosen', () => {
  const none = reviewReducer(guessed, { type: 'squad', squad: NO_SQUAD })
  expect(none.choices).toEqual({ kind: 'bug', squad: NO_SQUAD, action: 'new_work_stream', workStreamId: null })
  expect(reviewReducer(none, { type: 'action', action: 'existing_work_stream' })).toBe(none)
  expect(picksWorkStream(none.choices)).toBe(false)
  expect(fileScreenshotRequest(IMAGE, none)).toMatchObject({ squadId: null, action: 'new_work_stream' })
})

test('another action drops the work stream; a guessed stream that has closed since is cleared', () => {
  const other = reviewReducer(guessed, { type: 'action', action: 'new_work_stream' })
  expect(other.choices.workStreamId).toBeNull()
  // Back to "existing" in the same squad: the stream is picked again by hand.
  const back = reviewReducer(other, { type: 'action', action: 'existing_work_stream' })
  expect(back.choices).toMatchObject({ action: 'existing_work_stream', workStreamId: null })
  // The guessed stream is among the open ones: kept. Not among them: cleared, the action stands.
  expect(reviewReducer(guessed, { type: 'workStreams', squad: CHLEA, workStreams: [EXPORT, DOCS] })).toBe(guessed)
  const closed = reviewReducer(guessed, { type: 'workStreams', squad: CHLEA, workStreams: [DOCS] })
  expect(closed.choices).toMatchObject({ action: 'existing_work_stream', workStreamId: null })
})

test('confirming sends the note, the confirmed choices, and the guess they started from', () => {
  const confirmed = after(
    [
      { type: 'note', note: '  The total shows NaN  ' },
      { type: 'kind', kind: 'error_message' },
      { type: 'workStreams', squad: CHLEA, workStreams: [EXPORT, DOCS] },
      { type: 'workStream', workStreamId: DOCS.id },
    ],
    guessed
  )
  expect(fileScreenshotRequest(IMAGE, confirmed)).toEqual({
    imageId: IMAGE,
    note: 'The total shows NaN',
    kind: 'error_message',
    squadId: CHLEA,
    action: 'existing_work_stream',
    workStreamId: DOCS.id,
    guessed: { kind: 'bug', squadId: CHLEA, action: 'existing_work_stream', workStreamId: EXPORT.id },
  })
  // "Existing" without picking which: the Assistant picks, and no work stream is sent.
  const unpicked = reviewReducer(guessed, { type: 'squad', squad: OPS })
  expect(fileScreenshotRequest(IMAGE, unpicked)).toEqual({
    imageId: IMAGE,
    kind: 'bug',
    squadId: OPS,
    action: 'existing_work_stream',
    guessed: { kind: 'bug', squadId: CHLEA, action: 'existing_work_stream', workStreamId: EXPORT.id },
  })
})

import { expect, test } from 'bun:test'
import type { DecisionAnswer } from '@ficus/shared'
import { buildScreenshotDecision, readScreenshotGuess, squadOptionKey, type ScreenshotSquad } from './screenshot-filing'

const busy: ScreenshotSquad = {
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Shop',
  purpose: 'The shop',
  openWorkStreams: 2,
}
const empty: ScreenshotSquad = {
  id: '22222222-0000-4000-8000-000000000002',
  name: 'Docs',
  purpose: null,
  openWorkStreams: 0,
}

const choice = (pick: string, probabilities: Record<string, number>): DecisionAnswer => ({
  type: 'choice',
  choice: pick,
  probabilities,
})

function answers(squad: ScreenshotSquad, action: Record<string, number>, pick = 'existing_work_stream') {
  return {
    kind: choice('bug', { bug: 0.9 }),
    squad: choice(squadOptionKey(squad.id), { [squadOptionKey(squad.id)]: 0.95 }),
    action: choice(pick, action),
  }
}

test('each squad option says how many work streams are open, so the model knows whether "existing" fits', () => {
  const request = buildScreenshotDecision({
    image: { mediaType: 'image/png', base64: 'AA==' },
    squads: [busy, empty],
  })
  const options = (request.questions.squad as { options: Record<string, string> }).options
  expect(options[squadOptionKey(busy.id)]).toBe('Shop: The shop (2 open work streams)')
  expect(options[squadOptionKey(empty.id)]).toBe('Docs (no open work streams)')
})

test('"add it to an existing work stream" falls back to the next likeliest action when the squad has none', () => {
  const probabilities = { existing_work_stream: 0.8, new_work_stream: 0.15, ask_consultant: 0.04, just_save: 0.01 }
  expect(readScreenshotGuess(answers(empty, probabilities), [busy, empty])?.action).toEqual({
    id: 'new_work_stream',
    label: 'start a new work stream',
    probability: 0.15,
  })
  // With open work streams it stands.
  expect(readScreenshotGuess(answers(busy, probabilities), [busy, empty])?.action.id).toBe('existing_work_stream')
  // Other actions are untouched.
  expect(readScreenshotGuess(answers(empty, { ask_consultant: 0.7 }, 'ask_consultant'), [busy, empty])?.action.id).toBe(
    'ask_consultant'
  )
})

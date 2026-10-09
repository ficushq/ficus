import { screenshotGuessSummary, type ScreenshotGuess } from '@ficus/shared'

/** Where a dropped screenshot is in being filed, as the toast shows it. */
export type FilingState =
  | { status: 'filing' }
  | { status: 'filed'; conversationId: string; guess: ScreenshotGuess | null; correctedTo?: string }
  | { status: 'failed'; message: string }

/** What the toast says about a filed screenshot. */
export function filingHeadline(state: Extract<FilingState, { status: 'filed' }>): string {
  if (state.correctedTo) return `Filing in ${state.correctedTo}`
  const { guess } = state
  if (!guess) return 'Filing with the Assistant'
  return guess.squad
    ? `Filing in ${guess.squad.name}: ${screenshotGuessSummary(guess)}`
    : `Filing: ${screenshotGuessSummary(guess)}`
}

/** The line under the headline: who checks the guess, and the work stream it seems to be about. */
export function filingDetail(state: Extract<FilingState, { status: 'filed' }>): string {
  if (state.correctedTo) return 'Told the Assistant where it belongs.'
  const { guess } = state
  if (!guess) return 'No guess this time; the Assistant will look at it.'
  if (guess.workStream) return `Looks like part of “${guess.workStream.title}”. The Assistant checks and adds it there.`
  return 'The Assistant checks the guess and files it.'
}

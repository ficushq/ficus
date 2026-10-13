import {
  isUnsureScreenshotGuess,
  screenshotChoicesFromGuess,
  type FileScreenshotRequest,
  type ScreenshotAction,
  type ScreenshotGuess,
  type ScreenshotKind,
  type ScreenshotWorkStreamOption,
} from '@ficus/shared'

/*
 * The state of the screenshot review card: the user's note, what each picker holds, and how those
 * follow the decision model's guess. Pure, so the rules (what a guess fills in, what "not sure"
 * means, what changing the squad does) are tested without a browser.
 */

/** The squad picker's value for the explicit choice "No squad". */
export const NO_SQUAD = 'none'

export type ReviewField = 'kind' | 'squad' | 'action' | 'workStream'

/** What the pickers hold; null is "not chosen", which leaves that field to the Assistant. */
export interface ReviewChoices {
  kind: ScreenshotKind | null
  /** A squad ID, or `NO_SQUAD`. */
  squad: string | null
  action: ScreenshotAction | null
  workStreamId: string | null
}

export interface ReviewState {
  note: string
  /** Undefined while the guess loads; null when there is none. */
  guess: ScreenshotGuess | null | undefined
  choices: ReviewChoices
  /** Fields the user set themselves. They are the user's choice now, so never "not sure". */
  touched: readonly ReviewField[]
}

export type ReviewEvent =
  | { type: 'note'; note: string }
  /** The guess arrived (null: there is none). */
  | { type: 'guessed'; guess: ScreenshotGuess | null }
  | { type: 'kind'; kind: ScreenshotKind }
  | { type: 'squad'; squad: string }
  | { type: 'action'; action: ScreenshotAction }
  | { type: 'workStream'; workStreamId: string }
  /** A squad's open work streams loaded for the picker. */
  | { type: 'workStreams'; squad: string; workStreams: readonly ScreenshotWorkStreamOption[] }

export const INITIAL_REVIEW: ReviewState = {
  note: '',
  guess: undefined,
  choices: { kind: null, squad: null, action: null, workStreamId: null },
  touched: [],
}

function choicesFromGuess(guess: ScreenshotGuess): ReviewChoices {
  const guessed = screenshotChoicesFromGuess(guess)
  return {
    kind: guessed.kind ?? null,
    squad: guessed.squadId === null ? NO_SQUAD : (guessed.squadId ?? null),
    action: guessed.action ?? null,
    workStreamId: guessed.workStreamId ?? null,
  }
}

/** "Add it to an existing work stream" needs a squad that has one; without, start a new one instead. */
function withoutExistingWorkStream(choices: ReviewChoices): ReviewChoices {
  return {
    ...choices,
    action: choices.action === 'existing_work_stream' ? 'new_work_stream' : choices.action,
    workStreamId: null,
  }
}

const touch = (state: ReviewState, field: ReviewField): readonly ReviewField[] =>
  state.touched.includes(field) ? state.touched : [...state.touched, field]

export function reviewReducer(state: ReviewState, event: ReviewEvent): ReviewState {
  switch (event.type) {
    case 'note':
      return { ...state, note: event.note }
    case 'guessed':
      // The pickers only load while the guess does, so there is nothing of the user's to keep but the note.
      return {
        ...state,
        guess: event.guess,
        choices: event.guess ? choicesFromGuess(event.guess) : state.choices,
        touched: [],
      }
    case 'kind':
      return { ...state, choices: { ...state.choices, kind: event.kind }, touched: touch(state, 'kind') }
    case 'squad': {
      // Another squad has other work streams: the pick goes, and they load without asking the model again.
      const choices = { ...state.choices, squad: event.squad, workStreamId: null }
      return {
        ...state,
        choices: event.squad === NO_SQUAD ? withoutExistingWorkStream(choices) : choices,
        touched: touch(state, 'squad'),
      }
    }
    case 'action': {
      // "No squad" has no work stream to add it to.
      if (event.action === 'existing_work_stream' && state.choices.squad === NO_SQUAD) return state
      return {
        ...state,
        choices: {
          ...state.choices,
          action: event.action,
          workStreamId: event.action === 'existing_work_stream' ? state.choices.workStreamId : null,
        },
        touched: touch(state, 'action'),
      }
    }
    case 'workStream':
      return {
        ...state,
        choices: { ...state.choices, workStreamId: event.workStreamId },
        touched: touch(state, 'workStream'),
      }
    case 'workStreams': {
      if (event.squad !== state.choices.squad) return state
      if (!event.workStreams.length)
        return state.choices.action === 'existing_work_stream' || state.choices.workStreamId
          ? { ...state, choices: withoutExistingWorkStream(state.choices) }
          : state
      // A pick that is no longer open (closed since the guess) cannot be filed with.
      const { workStreamId } = state.choices
      return workStreamId && !event.workStreams.some((stream) => stream.id === workStreamId)
        ? { ...state, choices: { ...state.choices, workStreamId: null } }
        : state
    }
  }
}

/**
 * The fields still showing a guess the model was not sure of (under 0.6): pre-selected as its best
 * guess, and marked so the user looks twice.
 */
export function unsureFields(state: ReviewState): ReviewField[] {
  const { guess, choices, touched } = state
  if (!guess) return []
  const guessedSquad = guess.squad
    ? { value: guess.squad.id, probability: guess.squad.probability }
    : guess.noSquadProbability !== undefined
      ? { value: NO_SQUAD, probability: guess.noSquadProbability }
      : null
  const shown: Array<[ReviewField, boolean]> = [
    ['kind', choices.kind === guess.kind.id && isUnsureScreenshotGuess(guess.kind.probability)],
    [
      'squad',
      Boolean(guessedSquad) &&
        choices.squad === guessedSquad!.value &&
        isUnsureScreenshotGuess(guessedSquad!.probability),
    ],
    ['action', choices.action === guess.action.id && isUnsureScreenshotGuess(guess.action.probability)],
    [
      'workStream',
      Boolean(guess.workStream) &&
        choices.workStreamId === guess.workStream!.id &&
        isUnsureScreenshotGuess(guess.workStream!.probability),
    ],
  ]
  return shown.filter(([field, unsure]) => unsure && !touched.includes(field)).map(([field]) => field)
}

/** Whether the work stream picker shows: only for "existing work stream" in a real squad. */
export function picksWorkStream(choices: ReviewChoices): choices is ReviewChoices & { squad: string } {
  return choices.action === 'existing_work_stream' && choices.squad !== null && choices.squad !== NO_SQUAD
}

/** What confirming the card sends: the note, the choices made, and the guess they started from. */
export function fileScreenshotRequest(imageId: string, state: ReviewState): FileScreenshotRequest {
  const { choices, guess } = state
  const note = state.note.trim()
  return {
    imageId,
    ...(note ? { note } : {}),
    ...(choices.kind ? { kind: choices.kind } : {}),
    ...(choices.squad ? { squadId: choices.squad === NO_SQUAD ? null : choices.squad } : {}),
    ...(choices.action ? { action: choices.action } : {}),
    ...(picksWorkStream(choices) && choices.workStreamId ? { workStreamId: choices.workStreamId } : {}),
    ...(guess ? { guessed: screenshotChoicesFromGuess(guess) } : {}),
  }
}

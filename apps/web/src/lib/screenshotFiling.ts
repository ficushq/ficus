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
  /**
   * The guess's weak work stream pick (`guess.workStreamSuggestion`), which never chooses the action.
   * `offered` is its ID while it can still pre-fill the picker: the guessed squad is selected, the
   * stream is open and the user has not picked one. `shown` is its ID once it did pre-fill the
   * picker, which makes it part of what the card was filled in with.
   */
  suggestion: { offered: string | null; shown: string | null }
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

const NO_SUGGESTION: ReviewState['suggestion'] = { offered: null, shown: null }

export const INITIAL_REVIEW: ReviewState = {
  note: '',
  guess: undefined,
  choices: { kind: null, squad: null, action: null, workStreamId: null },
  touched: [],
  suggestion: NO_SUGGESTION,
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

/** Pre-fill an empty work stream picker with the weak pick still on offer, when the picker shows. */
function withSuggestion(state: ReviewState): ReviewState {
  const { offered } = state.suggestion
  if (!offered || state.choices.workStreamId || !picksWorkStream(state.choices)) return state
  return {
    ...state,
    choices: { ...state.choices, workStreamId: offered },
    suggestion: { offered, shown: offered },
  }
}

export function reviewReducer(state: ReviewState, event: ReviewEvent): ReviewState {
  switch (event.type) {
    case 'note':
      return { ...state, note: event.note }
    case 'guessed':
      // The pickers only load while the guess does, so there is nothing of the user's to keep but the note.
      return withSuggestion({
        ...state,
        guess: event.guess,
        choices: event.guess ? choicesFromGuess(event.guess) : state.choices,
        touched: [],
        // The suggestion is one of the guessed squad's work streams.
        suggestion: { offered: (event.guess?.squad && event.guess.workStreamSuggestion?.id) || null, shown: null },
      })
    case 'kind':
      return { ...state, choices: { ...state.choices, kind: event.kind }, touched: touch(state, 'kind') }
    case 'squad': {
      // Another squad has other work streams: the pick and the suggestion go, and they load without asking the model again.
      const choices = { ...state.choices, squad: event.squad, workStreamId: null }
      return {
        ...state,
        choices: event.squad === NO_SQUAD ? withoutExistingWorkStream(choices) : choices,
        touched: touch(state, 'squad'),
        suggestion: { ...state.suggestion, offered: null },
      }
    }
    case 'action': {
      // "No squad" has no work stream to add it to.
      if (event.action === 'existing_work_stream' && state.choices.squad === NO_SQUAD) return state
      // A weak pick never chose "existing work stream"; once the user has, it fills the picker in.
      return withSuggestion({
        ...state,
        choices: {
          ...state.choices,
          action: event.action,
          workStreamId: event.action === 'existing_work_stream' ? state.choices.workStreamId : null,
        },
        touched: touch(state, 'action'),
      })
    }
    case 'workStream':
      return {
        ...state,
        choices: { ...state.choices, workStreamId: event.workStreamId },
        touched: touch(state, 'workStream'),
        // The user's own pick: the suggestion is not offered again.
        suggestion: { ...state.suggestion, offered: null },
      }
    case 'workStreams': {
      if (event.squad !== state.choices.squad) return state
      const isOpen = (id: string) => event.workStreams.some((stream) => stream.id === id)
      const { offered } = state.suggestion
      // A suggestion that has closed since the guess is dropped before it is ever shown.
      const next = offered && !isOpen(offered) ? { ...state, suggestion: NO_SUGGESTION } : state
      if (!event.workStreams.length)
        return next.choices.action === 'existing_work_stream' || next.choices.workStreamId
          ? { ...next, choices: withoutExistingWorkStream(next.choices) }
          : next
      // A pick that is no longer open (closed since the guess) cannot be filed with.
      const { workStreamId } = next.choices
      return workStreamId && !isOpen(workStreamId)
        ? { ...next, choices: { ...next.choices, workStreamId: null } }
        : next
    }
  }
}

/**
 * The fields still showing a guess the model was not sure of (under 0.6): pre-selected as its best
 * guess, and marked so the user looks twice. A work stream suggestion is always one of these while
 * the picker shows it.
 */
export function unsureFields(state: ReviewState): ReviewField[] {
  const { guess, choices, touched } = state
  if (!guess) return []
  const guessedSquad = guess.squad
    ? { value: guess.squad.id, probability: guess.squad.probability }
    : guess.noSquadProbability !== undefined
      ? { value: NO_SQUAD, probability: guess.noSquadProbability }
      : null
  const guessedStream = guess.workStream ?? guess.workStreamSuggestion
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
      Boolean(guessedStream) &&
        choices.workStreamId === guessedStream!.id &&
        isUnsureScreenshotGuess(guessedStream!.probability),
    ],
  ]
  return shown.filter(([field, unsure]) => unsure && !touched.includes(field)).map(([field]) => field)
}

/** Whether the work stream picker shows: only for "existing work stream" in a real squad. */
export function picksWorkStream(choices: ReviewChoices): choices is ReviewChoices & { squad: string } {
  return choices.action === 'existing_work_stream' && choices.squad !== null && choices.squad !== NO_SQUAD
}

/**
 * What confirming the card sends: the note, the choices made, and what the guess filled the card in
 * with. That includes a weak work stream suggestion only when the picker showed it.
 */
export function fileScreenshotRequest(imageId: string, state: ReviewState): FileScreenshotRequest {
  const { choices, guess, suggestion } = state
  const note = state.note.trim()
  return {
    imageId,
    ...(note ? { note } : {}),
    ...(choices.kind ? { kind: choices.kind } : {}),
    ...(choices.squad ? { squadId: choices.squad === NO_SQUAD ? null : choices.squad } : {}),
    ...(choices.action ? { action: choices.action } : {}),
    ...(picksWorkStream(choices) && choices.workStreamId ? { workStreamId: choices.workStreamId } : {}),
    ...(guess
      ? {
          guessed: {
            ...screenshotChoicesFromGuess(guess),
            ...(suggestion.shown ? { workStreamId: suggestion.shown } : {}),
          },
        }
      : {}),
  }
}

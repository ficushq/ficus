import { z } from 'zod'

/*
 * "Drop a screenshot anywhere": the web uploads an image and Core asks a decision model what it
 * shows and where it belongs. The user reviews that guess on a card, corrects it and adds a note;
 * only when they confirm is it filed through a new Assistant conversation.
 */

/** What a screenshot can be, with the description the decision model is given. */
export const SCREENSHOT_KINDS = {
  bug: { label: 'a bug', description: 'Something in an app looks broken or behaves wrongly.' },
  design_feedback: {
    label: 'design feedback',
    description: 'A layout, visual or wording the user wants changed, without anything being broken.',
  },
  error_message: {
    label: 'an error message or log',
    description: 'An error dialog, stack trace, terminal output or log lines.',
  },
  idea: { label: 'an idea or feature request', description: 'A mockup, sketch or example of something to build.' },
  reference: { label: 'a reference', description: 'Anything else: a reference to keep, a document, a photo.' },
} as const
export type ScreenshotKind = keyof typeof SCREENSHOT_KINDS

/** What to do with it. */
export const SCREENSHOT_ACTIONS = {
  new_work_stream: { label: 'start a new work stream', description: 'It needs work that nobody is doing yet.' },
  existing_work_stream: {
    label: 'add it to an existing work stream',
    description: 'It is about work already under way.',
  },
  ask_consultant: {
    label: "ask the squad's consultant",
    description: 'It needs a question answered or a discussion before any work.',
  },
  just_save: { label: 'just save it', description: 'Keep it for reference; nothing to do now.' },
} as const
export type ScreenshotAction = keyof typeof SCREENSHOT_ACTIONS

const SCREENSHOT_KIND_IDS = Object.keys(SCREENSHOT_KINDS) as [ScreenshotKind, ...ScreenshotKind[]]
const SCREENSHOT_ACTION_IDS = Object.keys(SCREENSHOT_ACTIONS) as [ScreenshotAction, ...ScreenshotAction[]]

/** The decision model's guess; each probability is 0 to 1. */
export interface ScreenshotGuess {
  kind: { id: ScreenshotKind; label: string; probability: number }
  /** Null when the model picked no squad. */
  squad: { id: string; name: string; probability: number } | null
  /** How sure "none of these squads" was, when that is what the model picked. */
  noSquadProbability?: number
  action: { id: ScreenshotAction; label: string; probability: number }
  /**
   * The squad's open work stream it is about, from a second question asked only when the squad has
   * some: null when none of them matched clearly, absent when that question was not asked.
   */
  workStream?: { id: string; title: string; probability: number } | null
  /**
   * The work stream that second question picked without being sure (under
   * `SCREENSHOT_GUESS_MIN_PROBABILITY`), so `workStream` is null. Absent when it answered "none of
   * them". It never decides the action: the card pre-selects it, marked "not sure", only with "add
   * it to an existing work stream" in the guessed squad.
   */
  workStreamSuggestion?: { id: string; title: string; probability: number }
}

/**
 * How sure a guess must be. A kind, squad or action below it is still the best guess, shown to the
 * user as "not sure". A work stream pick below it is only a suggestion (`workStreamSuggestion`):
 * also "not sure" when shown, but unlike a sure pick it never sets the action.
 */
export const SCREENSHOT_GUESS_MIN_PROBABILITY = 0.6

/** Whether a guessed field should be shown as "not sure". */
export function isUnsureScreenshotGuess(probability: number): boolean {
  return probability < SCREENSHOT_GUESS_MIN_PROBABILITY
}

export const guessScreenshotRequestSchema = z.object({
  /** A staged upload from `POST /api/images` (no agent or squad), by the same user. */
  imageId: z.string().uuid(),
})
export type GuessScreenshotRequest = z.infer<typeof guessScreenshotRequestSchema>

export interface GuessScreenshotResponse {
  /** Null when the feature is off or no decision model answered; the user fills the card in. */
  guess: ScreenshotGuess | null
}

/** An open (active or queued) work stream a screenshot can be added to. */
export interface ScreenshotWorkStreamOption {
  id: string
  title: string
}

export interface ScreenshotWorkStreamsResponse {
  workStreams: ScreenshotWorkStreamOption[]
}

/**
 * The fields of the review card. In each, `undefined` means the user left it unchosen (the
 * Assistant decides); for the squad, `null` is the explicit choice "No squad".
 */
const screenshotChoicesSchema = z.object({
  kind: z.enum(SCREENSHOT_KIND_IDS).optional(),
  squadId: z.string().uuid().nullable().optional(),
  action: z.enum(SCREENSHOT_ACTION_IDS).optional(),
  workStreamId: z.string().uuid().optional(),
})
export type ScreenshotChoices = z.infer<typeof screenshotChoicesSchema>

export const fileScreenshotRequestSchema = screenshotChoicesSchema
  .extend({
    /** A staged upload from `POST /api/images` (no agent or squad), by the same user. */
    imageId: z.string().uuid(),
    note: z.string().trim().max(2000).optional(),
    /**
     * What the card was filled in with from the guess, when there was one: a weak work stream
     * suggestion only when the card showed it pre-selected. Used only to save the fields the user
     * changed as candidate eval cases; filing never reads it.
     */
    guessed: screenshotChoicesSchema.optional(),
  })
  .refine((request) => !request.workStreamId || request.action === 'existing_work_stream', {
    message: 'A work stream can only be chosen with "add it to an existing work stream"',
    path: ['workStreamId'],
  })
  .refine((request) => !request.workStreamId || Boolean(request.squadId), {
    message: 'A work stream needs its squad',
    path: ['workStreamId'],
  })
export type FileScreenshotRequest = z.infer<typeof fileScreenshotRequestSchema>

export interface FileScreenshotResponse {
  conversationId: string
}

/**
 * The choices a guess fills the review card in with. The squad stays unchosen when the model was
 * not asked about squads (the user sees none) or gave no usable answer. A weak work stream
 * suggestion is not among them: the card adds it when, and only when, it shows it.
 */
export function screenshotChoicesFromGuess(guess: ScreenshotGuess): ScreenshotChoices {
  return {
    kind: guess.kind.id,
    ...(guess.squad ? { squadId: guess.squad.id } : guess.noSquadProbability !== undefined ? { squadId: null } : {}),
    action: guess.action.id,
    ...(guess.workStream ? { workStreamId: guess.workStream.id } : {}),
  }
}

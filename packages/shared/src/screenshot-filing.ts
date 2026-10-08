import { z } from 'zod'

/*
 * "Drop a screenshot anywhere": the web uploads an image, Core asks a decision model what it shows
 * and which squad it belongs to, then files it through a new Assistant conversation.
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

export const fileScreenshotRequestSchema = z.object({
  /** A staged upload from `POST /api/images` (no agent or squad), by the same user. */
  imageId: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
})
export type FileScreenshotRequest = z.infer<typeof fileScreenshotRequestSchema>

/** The decision model's guess; each probability is 0 to 1. */
export interface ScreenshotGuess {
  kind: { id: ScreenshotKind; label: string; probability: number }
  /** Null when the model picked no squad. */
  squad: { id: string; name: string; probability: number } | null
  action: { id: ScreenshotAction; label: string; probability: number }
}

export interface FileScreenshotResponse {
  conversationId: string
  /** Null when the feature is off or no decision model answered; the Assistant files it anyway. */
  guess: ScreenshotGuess | null
}

export const screenshotCorrectionSchema = z.object({
  conversationId: z.string().uuid(),
  /** The squad it belongs to; null for none. */
  squadId: z.string().uuid().nullable(),
  clientId: z.string().uuid(),
})
export type ScreenshotCorrection = z.infer<typeof screenshotCorrectionSchema>

/** The short summary a filed screenshot is shown with, e.g. "looks like a bug". */
export function screenshotGuessSummary(guess: ScreenshotGuess): string {
  return `looks like ${guess.kind.label}`
}

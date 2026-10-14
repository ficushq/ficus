import type {
  FileScreenshotRequest,
  FileScreenshotResponse,
  GuessScreenshotResponse,
  ScreenshotWorkStreamsResponse,
} from '@ficus/shared'
import { webTransport as t } from './transport'

/**
 * "Drop a screenshot anywhere": Core guesses what it is and where it belongs for the review card,
 * and files it through a new Assistant conversation only when the user confirms.
 */
export const screenshotsApi = {
  /** The guess for a staged image. Creates nothing and sends nothing. */
  guess: (imageId: string) =>
    t.request<GuessScreenshotResponse>('/screenshots/guess', { method: 'POST', body: { imageId } }),
  /** A squad's open work streams, for the card's picker. */
  workStreams: (squadId: string) =>
    t.request<ScreenshotWorkStreamsResponse>(`/screenshots/work-streams?squadId=${encodeURIComponent(squadId)}`),
  file: (request: FileScreenshotRequest) =>
    t.request<FileScreenshotResponse>('/screenshots/file', { method: 'POST', body: request }),
}

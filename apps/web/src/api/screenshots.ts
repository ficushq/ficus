import type { FileScreenshotResponse, ScreenshotCorrection } from '@ficus/shared'
import { webTransport as t } from './transport'

/** "Drop a screenshot anywhere": Core guesses where it belongs and files it through a new Assistant conversation. */
export const screenshotsApi = {
  file: (imageId: string, note?: string) =>
    t.request<FileScreenshotResponse>('/screenshots/file', {
      method: 'POST',
      body: { imageId, ...(note ? { note } : {}) },
    }),
  correct: (correction: ScreenshotCorrection) =>
    t.request<{ conversationId: string }>('/screenshots/correction', { method: 'POST', body: correction }),
}

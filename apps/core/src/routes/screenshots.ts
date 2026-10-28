import { Hono } from 'hono'
import { zValidator } from '../lib/zod-validator'
import { z } from 'zod'
import { fileScreenshotRequestSchema, guessScreenshotRequestSchema } from '@ficus/shared'
import { requirePermission } from '../middleware/require-permission'
import {
  fileScreenshot,
  guessScreenshot,
  listScreenshotWorkStreams,
  type ScreenshotFilingDeps,
} from '../services/screenshot-filing'

/**
 * "Drop a screenshot anywhere": a guess for the review card, the open work streams its picker
 * offers, and the filing itself. Filing goes through a new Assistant conversation, so all of it
 * needs chat:send.
 */
export function createScreenshotsRouter(deps: ScreenshotFilingDeps = {}) {
  return new Hono()
    .use('*', requirePermission('chat:send'))
    .post('/guess', zValidator('json', guessScreenshotRequestSchema), async (c) =>
      c.json(await guessScreenshot(c.get('identity'), c.req.valid('json'), deps))
    )
    .get('/work-streams', zValidator('query', z.object({ squadId: z.string().uuid() })), async (c) =>
      c.json(await listScreenshotWorkStreams(c.get('identity'), c.req.valid('query').squadId))
    )
    .post('/file', zValidator('json', fileScreenshotRequestSchema), async (c) =>
      c.json(await fileScreenshot(c.get('identity'), c.req.valid('json'), deps))
    )
}

export const screenshotsRouter = createScreenshotsRouter()

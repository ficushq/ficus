import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { fileScreenshotRequestSchema, screenshotCorrectionSchema } from '@ficus/shared'
import { requirePermission } from '../middleware/require-permission'
import { correctScreenshotSquad, fileScreenshot, type ScreenshotFilingDeps } from '../services/screenshot-filing'

/** "Drop a screenshot anywhere": filing goes through a new Assistant conversation, so it needs chat:send. */
export function createScreenshotsRouter(deps: ScreenshotFilingDeps = {}) {
  return new Hono()
    .use('*', requirePermission('chat:send'))
    .post('/file', zValidator('json', fileScreenshotRequestSchema), async (c) =>
      c.json(await fileScreenshot(c.get('identity'), c.req.valid('json'), deps))
    )
    .post('/correction', zValidator('json', screenshotCorrectionSchema), async (c) =>
      c.json(await correctScreenshotSquad(c.get('identity'), c.req.valid('json')))
    )
}

export const screenshotsRouter = createScreenshotsRouter()

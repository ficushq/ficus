import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  isPlaceholderEmail,
  isProductFeedbackPage,
  PRODUCT_FEEDBACK_CATEGORIES,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_MESSAGE_MIN,
} from '@ficus/shared'
import { db, users } from '../db'
import { parseJsonBody } from './json-body'
import {
  ProductFeedbackError,
  productFeedbackService,
  type ProductFeedbackReport,
  type ProductFeedbackService,
} from '../services/platform/product-feedback'

/** Same email shape the Ficus platform accepts; anything else is left out rather than failing the report. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hasControlChars = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

const requestSchema = z.strictObject({
  category: z.enum(PRODUCT_FEEDBACK_CATEGORIES),
  message: z.string().trim().min(PRODUCT_FEEDBACK_MESSAGE_MIN).max(PRODUCT_FEEDBACK_MESSAGE_MAX),
  includeSubmitter: z.boolean(),
  page: z.string().refine(isProductFeedbackPage).optional(),
})

type SubmitterRecord = { displayName: string | null; email: string }

async function findSubmitter(userId: string): Promise<SubmitterRecord | null> {
  const [row] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row ?? null
}

/** The signed-in person's Core display name and email, keeping only values the platform accepts. */
function submitterDetails(record: SubmitterRecord | null): ProductFeedbackReport['submitter'] {
  if (!record) return undefined
  const name = record.displayName?.trim().slice(0, 200)
  const email = record.email.trim()
  const details = {
    ...(name && !hasControlChars(name) ? { name } : {}),
    ...(email.length <= 254 && EMAIL_PATTERN.test(email) && !isPlaceholderEmail(email) && !hasControlChars(email)
      ? { email }
      : {}),
  }
  return Object.keys(details).length > 0 ? details : undefined
}

/**
 * "Send feedback to Ficus" for any signed-in person. The instance credential
 * that forwards the report stays in Core; responses carry only a report ID,
 * a connection flag, or a fixed user-facing error.
 */
export function createProductFeedbackRouter(
  deps: { service?: ProductFeedbackService; findUser?: (userId: string) => Promise<SubmitterRecord | null> } = {}
) {
  const service = deps.service ?? productFeedbackService
  const findUser = deps.findUser ?? findSubmitter
  const router = new Hono()
  router.use('*', bodyLimit({ maxSize: 64 * 1024 }))
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.get('identity')?.type !== 'user') return c.json({ error: 'A user account is required.' }, 403)
    // Every signed-in person may send feedback; there is no narrower permission to check.
    c.set('authzChecked', true)
    await next()
  })
  router.onError((error, c) => {
    if (error instanceof ProductFeedbackError) return c.json({ error: error.message, code: error.code }, error.status)
    return c.json({ error: 'Feedback could not be sent right now. Try again later.', code: 'unavailable' }, 503)
  })

  router.get('/status', (c) => c.json(service.status()))

  router.post('/', async (c) => {
    const body = await parseJsonBody(c)
    const input = requestSchema.safeParse(body.ok ? body.value : null)
    if (!input.success)
      return c.json(
        {
          error: `Choose a category and write ${PRODUCT_FEEDBACK_MESSAGE_MIN}–${PRODUCT_FEEDBACK_MESSAGE_MAX} characters.`,
          code: 'invalid_request',
        },
        400
      )
    const identity = c.get('identity')
    const userId = identity?.type === 'user' ? identity.userId : null
    if (!userId) return c.json({ error: 'A user account is required.' }, 403)
    const { category, message, includeSubmitter, page } = input.data
    const submitter = includeSubmitter ? submitterDetails(await findUser(userId)) : undefined
    const created = await service.send({
      category,
      message,
      ...(submitter ? { submitter } : {}),
      ...(page ? { page } : {}),
    })
    return c.json(created, 201)
  })
  return router
}

export const productFeedbackRouter = createProductFeedbackRouter()

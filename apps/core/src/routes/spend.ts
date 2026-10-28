/**
 * Instance-wide inference spend from the cost ledger (Settings → Spend). Gated by `usage:read`, which no
 * default role holds: only admins (`*`) see it until someone is granted it.
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { INFERENCE_BILLING, SPEND_DIMENSIONS, SPEND_MAX_RANGE_DAYS, type SpendFilters } from '@ficus/shared'
import { requirePermission } from '../middleware/require-permission'
import { spendBreakdown, spendSummary } from '../services/inference-usage/query'

const DAY_MS = 24 * 60 * 60 * 1000

const filterSchema = {
  squadId: z.string().max(64).optional(),
  workStreamId: z.string().max(64).optional(),
  agentId: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  feature: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  accountId: z.string().max(140).optional(),
  billing: z.enum(INFERENCE_BILLING).optional(),
}

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  ...filterSchema,
})

const breakdownSchema = rangeSchema.extend({
  by: z.enum(SPEND_DIMENSIONS),
  by2: z.enum(SPEND_DIMENSIONS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): Parsed<z.infer<T>> {
  const result = schema.safeParse(c.req.query())
  if (!result.success) {
    const issue = result.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') || 'query'}: ${issue?.message ?? 'invalid'}` }
  }
  return { ok: true, value: result.data }
}

/** `[from, to)`, defaulting to the last 30 days; at most SPEND_MAX_RANGE_DAYS long. */
function rangeOf(query: { from?: string; to?: string }): Parsed<{ from: Date; to: Date }> {
  const to = query.to ? new Date(query.to) : new Date()
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS)
  if (!(from < to)) return { ok: false, error: 'from must be before to' }
  if (to.getTime() - from.getTime() > SPEND_MAX_RANGE_DAYS * DAY_MS)
    return { ok: false, error: `A range can cover at most ${SPEND_MAX_RANGE_DAYS} days` }
  return { ok: true, value: { from, to } }
}

function filtersOf(query: Record<string, unknown>): SpendFilters {
  const filters: SpendFilters = {}
  for (const key of Object.keys(filterSchema) as Array<keyof SpendFilters>) {
    const value = query[key]
    if (typeof value === 'string') (filters as Record<string, string>)[key] = value
  }
  return filters
}

const app = new Hono()

/** Totals, daily series, subscription line items and this month's projection. */
app.get('/summary', requirePermission('usage:read'), async (c) => {
  const query = parseQuery(c, rangeSchema)
  if (!query.ok) return c.json({ error: query.error }, 400)
  const range = rangeOf(query.value)
  if (!range.ok) return c.json({ error: range.error }, 400)
  return c.json(await spendSummary(range.value, filtersOf(query.value)))
})

/** Spend grouped by one dimension (`by`), optionally split by a second (`by2`). */
app.get('/breakdown', requirePermission('usage:read'), async (c) => {
  const query = parseQuery(c, breakdownSchema)
  if (!query.ok) return c.json({ error: query.error }, 400)
  const range = rangeOf(query.value)
  if (!range.ok) return c.json({ error: range.error }, 400)
  return c.json(
    await spendBreakdown(range.value, filtersOf(query.value), query.value.by, query.value.by2, query.value.limit ?? 50)
  )
})

export default app

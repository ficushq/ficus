import { eq, sql } from 'drizzle-orm'
import { messages } from '../db/schema'

/** SQL mirror of @ficus/shared messageSortAt, normalized to JavaScript Date precision. */
export const messageSortAtSql = sql<Date>`
  date_trunc(
    'milliseconds',
    CASE
      WHEN ${messages.role} = 'human'
        AND (${messages.metadata}->>'consumedAt') IS NOT NULL
      THEN (${messages.metadata}->>'consumedAt')::timestamptz
      ELSE ${messages.createdAt} AT TIME ZONE 'UTC'
    END
  ) AT TIME ZONE 'UTC'
`.mapWith(messages.createdAt)

/** Delivered transcript/activity rows; pending rows render only in queue UI. */
export const visibleMessageSql = eq(messages.pending, false)

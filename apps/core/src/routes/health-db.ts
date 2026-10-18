import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db'

/** How long the probe may take before the database counts as unreachable. */
export const DATABASE_HEALTH_TIMEOUT_MS = 2_000

const probeDatabase = () => db.execute(sql`select 1`)

/**
 * `GET /health/db`: whether this API process can query its database, for monitors and operators.
 * `/health` stays a liveness check that never touches the database (a database outage must not get
 * the process restarted), so it reports ok even while every database-backed request fails.
 * Unauthenticated, so the body is a fixed status and never the underlying error.
 */
export function createDatabaseHealthRouter(
  probe: () => Promise<unknown> = probeDatabase,
  timeoutMs = DATABASE_HEALTH_TIMEOUT_MS
) {
  return new Hono().get('/', async (c) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reachable = await Promise.race([
      probe().then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    c.header('Cache-Control', 'no-store')
    return reachable
      ? c.json({ status: 'ok', database: 'ok' })
      : c.json({ status: 'error', database: 'unreachable' }, 503)
  })
}

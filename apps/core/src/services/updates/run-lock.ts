import {
  acquireDedicatedConnectionSlot,
  createPostgresConnection,
  getDirectConnectionString,
} from '../../db/connection'

/**
 * Advisory-lock key for the cross-process update-run mutex. Stable constant,
 * unique among Ficus's pg advisory locks (42 = db migrations, 424242 =
 * first-user admin bootstrap, 421001 = CLI-bundle build, hashtext keys
 * elsewhere).
 *
 * Those are all SINGLE-arg keys and therefore share one key space. The per-agent
 * execution-queue lock (entities/Agent.ts) deliberately uses the TWO-arg form —
 * (421100, hashtext(agentId)) — which Postgres keeps in a separate space, so its
 * hashed keys can never collide with the constants listed above.
 */
export const UPDATE_RUN_LOCK_KEY = 421_002

export type UpdateRunLock = { release(): Promise<void> }

/**
 * Cross-process mutex for update runs.
 *
 * Why it exists: core runs as TWO processes (api + worker), each starting a
 * LocalUpdateScheduler, and `LocalUpdateManager.active` is per-process memory
 * over a SHARED status file — so two auto-schedulers (or a manual apply racing
 * an auto run in the other process) could interleave git merge / build /
 * restart sequences.
 *
 * Why THIS mechanism (mirrors the CLI-bundle build lock): a Postgres SESSION
 * advisory lock on a short-lived DEDICATED connection is auto-released when
 * the holding connection dies — no stale-lockfile deadlock after a crash or a
 * self-restart mid-run (the restart that kills the holder frees the lock).
 * TRY-lock semantics, not queueing: a run already in flight elsewhere means
 * this run should NOT happen (queueing a second update behind a restart-ing
 * first would re-run pointlessly against the already-updated tree).
 *
 * Returns null when another process holds the lock.
 */
export async function acquireUpdateRunLock(key: number = UPDATE_RUN_LOCK_KEY): Promise<UpdateRunLock | null> {
  // A session lock, so: the DIRECT connection (never a transaction pooler),
  // and a dedicated-connection slot held for as long as the lock is — the
  // handle's release() gives both back.
  const releaseSlot = await acquireDedicatedConnectionSlot()
  const sql = createPostgresConnection(getDirectConnectionString(), { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql`SELECT pg_try_advisory_lock(${key}) AS locked`
    if (!row?.locked) {
      await sql.end({ timeout: 5 }).catch(() => {})
      releaseSlot()
      return null
    }
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => {})
    releaseSlot()
    throw error
  }
  return {
    async release() {
      // Best-effort: if the connection died the server already released the
      // session lock, and the end() below closes it regardless.
      await sql`SELECT pg_advisory_unlock(${key})`.catch(() => {})
      await sql.end({ timeout: 5 }).catch(() => {})
      releaseSlot()
    },
  }
}

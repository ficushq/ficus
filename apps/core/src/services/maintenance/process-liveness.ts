import { createPostgresConnection, getDirectConnectionString } from '../../db/connection'

export const ADMISSION_LIVENESS_LOCK_VERSION = 'ficus:admission-owner:v1:'
export const ADMISSION_LIVENESS_HASH_SEED = 7_401_983_522

export const admissionProcessIncarnation = crypto.randomUUID()

let releaseLiveness: (() => Promise<void>) | null = null
let stopping = false
let fatalTriggered = false

/**
 * Hold one dedicated PostgreSQL session lock for this worker process lifetime.
 * This connection is never used for application queries or held transactions.
 * Losing it is fatal: reconnecting in-place would let a successor prove this
 * process dead while an old local Pi object could still be alive.
 */
export async function startAdmissionProcessLiveness(
  onUnexpectedLoss: () => void = () => process.kill(process.pid, 'SIGTERM')
): Promise<void> {
  if (releaseLiveness) return
  stopping = false
  fatalTriggered = false
  // Direct, never through a transaction pooler: the liveness lock is a session
  // lock that must stay on one backend for the life of the process. The one
  // permanent direct connection, deliberately outside the dedicated slot gate
  // (it never releases, so it would hold a slot forever).
  const client = createPostgresConnection(getDirectConnectionString(), {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    onclose: () => {
      if (!stopping && !fatalTriggered) {
        fatalTriggered = true
        onUnexpectedLoss()
      }
    },
  })
  const connection = await client.reserve()
  await connection`
    SELECT pg_advisory_lock(
      hashtextextended(
        ${ADMISSION_LIVENESS_LOCK_VERSION} || ${admissionProcessIncarnation},
        ${ADMISSION_LIVENESS_HASH_SEED}
      )
    )
  `
  releaseLiveness = async () => {
    if (stopping) return
    stopping = true
    try {
      await connection`
        SELECT pg_advisory_unlock(
          hashtextextended(
            ${ADMISSION_LIVENESS_LOCK_VERSION} || ${admissionProcessIncarnation},
            ${ADMISSION_LIVENESS_HASH_SEED}
          )
        )
      `
    } finally {
      connection.release()
      await client.end()
      releaseLiveness = null
    }
  }
}

/** Release only after pickup and every local lifecycle have drained. */
export async function stopAdmissionProcessLiveness(): Promise<void> {
  await releaseLiveness?.()
}

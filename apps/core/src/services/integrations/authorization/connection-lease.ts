import {
  createPostgresConnection,
  getDirectConnectionString,
  withDedicatedConnectionSlot,
} from '../../../db/connection'

const LEASE_PREFIX = 'integration-authorization:'

export function connectionAuthorizationLeaseKey(resource: string): string {
  return `${LEASE_PREFIX}${resource}`
}

export function revocationArtifactLeaseResource(credentialRef: string): string {
  return `credential:${credentialRef}`
}

export class ConnectionLeaseUnavailableError extends Error {
  constructor() {
    super('Integration connection lease is unavailable')
    this.name = 'ConnectionLeaseUnavailableError'
  }
}

export interface ConnectionAuthorizationLeaseOptions {
  acquireTimeoutMs?: number
  retryIntervalMs?: number
}

/**
 * Cross-process serialization for refresh and reconnect provider I/O.
 *
 * Each call owns a dedicated PostgreSQL session for the complete protected
 * operation. PostgreSQL releases the advisory lock if that owner disappears,
 * while bounded try-lock acquisition prevents an unhealthy owner from causing
 * an unbounded request hang.
 */
export class ConnectionAuthorizationLease {
  readonly #acquireTimeoutMs: number
  readonly #retryIntervalMs: number

  constructor(options: ConnectionAuthorizationLeaseOptions = {}) {
    this.#acquireTimeoutMs = boundedPositive(options.acquireTimeoutMs, 30_000)
    this.#retryIntervalMs = boundedPositive(options.retryIntervalMs, 25)
  }

  async runExclusive<T>(resource: string, operation: () => Promise<T>): Promise<T> {
    return this.runExclusiveMany([resource], operation)
  }

  async runExclusiveMany<T>(resources: readonly string[], operation: () => Promise<T>): Promise<T> {
    if (resources.some((resource) => resource.trim().length === 0)) {
      throw new Error('Integration authorization lease resources must not be blank')
    }
    const keys = [...new Set(resources.map((resource) => connectionAuthorizationLeaseKey(resource.trim())))].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0)
    )
    if (keys.length === 0) throw new Error('At least one integration authorization lease resource is required')
    return withDedicatedConnectionSlot(async () => {
      const connection = createPostgresConnection(getDirectConnectionString(), { max: 1, idle_timeout: 0 })
      try {
        const session = await connection.reserve()
        const acquired: string[] = []
        try {
          const deadline = Date.now() + this.#acquireTimeoutMs
          for (const key of keys) {
            let locked = false
            do {
              const [row] = await session<{ acquired: boolean }[]>`
                select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
              `
              locked = row?.acquired === true
              if (locked) break
              if (Date.now() >= deadline) throw new ConnectionLeaseUnavailableError()
              await Bun.sleep(Math.min(this.#retryIntervalMs, Math.max(1, deadline - Date.now())))
            } while (Date.now() <= deadline)
            if (!locked) throw new ConnectionLeaseUnavailableError()
            acquired.push(key)
          }
          return await operation()
        } finally {
          for (const key of acquired.reverse()) {
            await session`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => {})
          }
          session.release()
        }
      } finally {
        await connection.end({ timeout: 5 }).catch(() => {})
      }
    })
  }
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), 120_000) : fallback
}

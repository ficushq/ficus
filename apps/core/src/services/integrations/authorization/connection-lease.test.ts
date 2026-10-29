import '../../../test-utils/require-test-db'
import { describe, expect, test } from 'bun:test'
import { createPostgresConnection, getConnectionString } from '../../../db/connection'
import { ConnectionAuthorizationLease, ConnectionLeaseUnavailableError } from './connection-lease'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('ConnectionAuthorizationLease', () => {
  test('serializes provider I/O for one connection', async () => {
    const lease = new ConnectionAuthorizationLease()
    const firstEntered = deferred()
    const releaseFirst = deferred()
    let active = 0
    let maxActive = 0

    const first = lease.runExclusive('10000000-0000-4000-8000-000000000001', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      firstEntered.resolve()
      await releaseFirst.promise
      active -= 1
    })
    await firstEntered.promise
    const second = lease.runExclusive('10000000-0000-4000-8000-000000000001', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      active -= 1
    })
    await Bun.sleep(25)
    expect(maxActive).toBe(1)
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(maxActive).toBe(1)
  })

  test('releases ownership when the protected operation fails', async () => {
    const lease = new ConnectionAuthorizationLease()
    const connectionId = '15000000-0000-4000-8000-000000000001'
    await expect(
      lease.runExclusive(connectionId, async () => {
        throw new Error('operation failed')
      })
    ).rejects.toThrow('operation failed')
    expect(await lease.runExclusive(connectionId, async () => 'entered-after-failure')).toBe('entered-after-failure')
  })

  test('fails bounded acquisition while another database session owns the lease', async () => {
    const connectionId = '16000000-0000-4000-8000-000000000001'
    const key = `integration-authorization:${connectionId}`
    const owner = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0 })
    const session = await owner.reserve()
    await session`select pg_advisory_lock(hashtextextended(${key}, 0))`
    try {
      const lease = new ConnectionAuthorizationLease({ acquireTimeoutMs: 50, retryIntervalMs: 5 })
      await expect(lease.runExclusive(connectionId, async () => 'unreachable')).rejects.toBeInstanceOf(
        ConnectionLeaseUnavailableError
      )
    } finally {
      await session`select pg_advisory_unlock(hashtextextended(${key}, 0))`
      session.release()
      await owner.end()
    }
  })

  test('recovers ownership after a stale database session disconnects', async () => {
    const connectionId = '17000000-0000-4000-8000-000000000001'
    const key = `integration-authorization:${connectionId}`
    const staleOwner = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0 })
    const session = await staleOwner.reserve()
    await session`select pg_advisory_lock(hashtextextended(${key}, 0))`
    session.release()
    await staleOwner.end()

    const lease = new ConnectionAuthorizationLease({ acquireTimeoutMs: 500, retryIntervalMs: 5 })
    expect(await lease.runExclusive(connectionId, async () => 'recovered')).toBe('recovered')
  })

  test('allows unrelated connection IDs to proceed concurrently', async () => {
    const lease = new ConnectionAuthorizationLease()
    const bothEntered = deferred()
    const release = deferred()
    let active = 0

    const enter = async () => {
      active += 1
      if (active === 2) bothEntered.resolve()
      await release.promise
      active -= 1
    }
    const first = lease.runExclusive('20000000-0000-4000-8000-000000000001', enter)
    const second = lease.runExclusive('20000000-0000-4000-8000-000000000002', enter)
    await Promise.race([
      bothEntered.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error('unrelated connection lease timed out')
      }),
    ])
    expect(active).toBe(2)
    release.resolve()
    await Promise.all([first, second])
  })
})

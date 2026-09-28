import { describe, it, expect } from 'bun:test'
import { validateDatabaseConnection } from './validate-connection'
import { describe as describeDedicated, expect as expectDedicated, test as testDedicated } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createPostgresConnection } from './connection'
import { withDedicatedDbTransaction } from './index'

describe('database safeguards', () => {
  it('should be in test mode', () => {
    expect(process.env.FICUS_TEST_MODE).toBe('1')
  })

  it('should be connected to tau_test database', () => {
    const url = new URL(process.env.DATABASE_URL!)
    expect(url.pathname).toBe('/tau_test')
  })

  it('should not use port 5432', () => {
    const url = new URL(process.env.DATABASE_URL!)
    expect(url.port).not.toBe('5432')
    expect(url.port).not.toBe('') // Empty means default 5432
  })
})

describe('validateDatabaseConnection', () => {
  it('should throw when test mode uses non-tau_test database', () => {
    const originalTestMode = process.env.FICUS_TEST_MODE
    process.env.FICUS_TEST_MODE = '1'
    try {
      expect(() => validateDatabaseConnection('postgres://user:pass@localhost:5433/tau', 'test')).toThrow(
        /TEST SAFETY VIOLATION.*database is "tau"/
      )
    } finally {
      if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
      else process.env.FICUS_TEST_MODE = originalTestMode
    }
  })

  it('should throw when test mode uses port 5432', () => {
    const originalTestMode = process.env.FICUS_TEST_MODE
    process.env.FICUS_TEST_MODE = '1'
    try {
      expect(() => validateDatabaseConnection('postgres://user:pass@localhost:5432/tau_test', 'test')).toThrow(
        /TEST SAFETY VIOLATION.*port is 5432/
      )
    } finally {
      if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
      else process.env.FICUS_TEST_MODE = originalTestMode
    }
  })

  it('should throw when test mode uses default port (no port specified)', () => {
    const originalTestMode = process.env.FICUS_TEST_MODE
    process.env.FICUS_TEST_MODE = '1'
    try {
      expect(() => validateDatabaseConnection('postgres://user:pass@localhost/tau_test', 'test')).toThrow(
        /TEST SAFETY VIOLATION.*port is 5432/
      )
    } finally {
      if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
      else process.env.FICUS_TEST_MODE = originalTestMode
    }
  })

  it('should pass when test mode uses tau_test on non-5432 port', () => {
    const originalTestMode = process.env.FICUS_TEST_MODE
    process.env.FICUS_TEST_MODE = '1'
    try {
      expect(() => validateDatabaseConnection('postgres://user:pass@localhost:5433/tau_test', 'test')).not.toThrow()
    } finally {
      if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
      else process.env.FICUS_TEST_MODE = originalTestMode
    }
  })

  it('should pass when not in test mode (no restrictions)', () => {
    const originalTestMode = process.env.FICUS_TEST_MODE
    delete process.env.FICUS_TEST_MODE
    try {
      // Should not throw even with production-like URL
      expect(() => validateDatabaseConnection('postgres://user:pass@localhost:5432/tau', 'test')).not.toThrow()
    } finally {
      if (originalTestMode === undefined) delete process.env.FICUS_TEST_MODE
      else process.env.FICUS_TEST_MODE = originalTestMode
    }
  })
})

describeDedicated('withDedicatedDbTransaction', () => {
  const instrumentedFactory = (events: string[]): typeof createPostgresConnection =>
    ((connectionString: string, options?: Parameters<typeof createPostgresConnection>[1]) => {
      const real = createPostgresConnection(connectionString, options)
      events.push('created')
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return (...args: unknown[]) => {
              events.push('ended')
              return (target.end as (...a: unknown[]) => unknown)(...args)
            }
          }
          const value = (target as unknown as Record<PropertyKey, unknown>)[prop]
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      }) as ReturnType<typeof createPostgresConnection>
    }) as typeof createPostgresConnection

  testDedicated('runs the transaction on a dedicated connection and ends it', async () => {
    const events: string[] = []
    const result = await withDedicatedDbTransaction(async (tx) => {
      const [row] = await tx.execute<{ one: number }>(sql`select 1 as one`)
      return row.one
    }, instrumentedFactory(events))
    expectDedicated(result).toBe(1)
    expectDedicated(events).toEqual(['created', 'ended'])
  })

  testDedicated('ends the connection on the throwing path', async () => {
    const events: string[] = []
    await expectDedicated(
      withDedicatedDbTransaction(async () => {
        throw new Error('tx boom')
      }, instrumentedFactory(events))
    ).rejects.toThrow('tx boom')
    expectDedicated(events).toEqual(['created', 'ended'])
  })
})

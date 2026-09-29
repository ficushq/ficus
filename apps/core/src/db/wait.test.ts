import { describe, it, expect } from 'bun:test'
import { redactDbCredentials, waitForDb } from './wait'

function collectLogger() {
  const lines: { level: 'info' | 'error'; message: string }[] = []
  return {
    lines,
    logger: {
      info: (message: string) => void lines.push({ level: 'info', message }),
      error: (message: string) => void lines.push({ level: 'error', message }),
    },
  }
}

describe('redactDbCredentials', () => {
  it('redacts the password in a postgres:// DSN', () => {
    expect(redactDbCredentials('cannot connect: postgres://ficus:s3cret@db.example.com:5432/tau')).toBe(
      'cannot connect: postgres://ficus:[REDACTED]@db.example.com:5432/tau'
    )
  })

  it('redacts postgresql:// DSNs and passwords containing special chars', () => {
    expect(redactDbCredentials('DATABASE_URL=postgresql://user:p%40ss:word@host/db')).toBe(
      'DATABASE_URL=postgresql://user:[REDACTED]@host/db'
    )
  })

  it('leaves messages without credentials untouched', () => {
    const messages = [
      'PostgresError: password authentication failed for user "ficus"',
      'no pg_hba.conf entry for host "1.2.3.4", user "ficus", database "ficus", no encryption',
      'Error: unable to verify the first certificate',
      'postgres://localhost:5432/tau has no userinfo',
    ]
    for (const message of messages) {
      expect(redactDbCredentials(message)).toBe(message)
    }
  })
})

describe('waitForDb', () => {
  it('resolves without logging when the first probe succeeds', async () => {
    const { lines, logger } = collectLogger()
    await waitForDb(async () => 1, { logger, baseDelay: 0 })
    expect(lines).toEqual([])
  })

  it('logs the underlying error on the first failure, then a terse wait line', async () => {
    const { lines, logger } = collectLogger()
    let attempts = 0
    await waitForDb(
      async () => {
        attempts += 1
        if (attempts <= 3) throw new Error('password authentication failed for user "ficus"')
      },
      { logger, baseDelay: 0 }
    )
    expect(attempts).toBe(4)
    expect(lines.map((l) => l.message)).toEqual([
      'Waiting for database... (attempt 1/15) — Error: password authentication failed for user "ficus"',
      'Waiting for database... (attempt 2/15)',
      'Waiting for database... (attempt 3/15)',
    ])
  })

  it('repeats the underlying error periodically, not on every retry', async () => {
    const { lines, logger } = collectLogger()
    let attempts = 0
    await waitForDb(
      async () => {
        attempts += 1
        if (attempts <= 11) throw new Error('boom')
      },
      { logger, baseDelay: 0 }
    )
    const detailed = lines.filter((l) => l.message.includes('boom'))
    expect(detailed.map((l) => l.message)).toEqual([
      'Waiting for database... (attempt 1/15) — Error: boom',
      'Waiting for database... (attempt 5/15) — Error: boom',
      'Waiting for database... (attempt 10/15) — Error: boom',
    ])
    expect(lines).toHaveLength(11)
  })

  it('throws with the underlying error on exhaustion, logging it at error level', async () => {
    const { lines, logger } = collectLogger()
    const original = new Error('getaddrinfo ENOTFOUND db.internal')
    await expect(
      waitForDb(
        async () => {
          throw original
        },
        { logger, baseDelay: 0, maxRetries: 3 }
      )
    ).rejects.toMatchObject({
      message: 'Database not reachable after retries: Error: getaddrinfo ENOTFOUND db.internal',
      cause: original,
    })
    expect(lines.at(-1)).toEqual({
      level: 'error',
      message: 'Database not reachable after 3 attempts: Error: getaddrinfo ENOTFOUND db.internal',
    })
  })

  it('unpacks empty-message AggregateError (refused connect across addresses)', async () => {
    const { lines, logger } = collectLogger()
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:5432'), new Error('connect ECONNREFUSED ::1:5432')],
      ''
    )
    await expect(
      waitForDb(
        async () => {
          throw refused
        },
        { logger, baseDelay: 0, maxRetries: 1 }
      )
    ).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:5432')
    expect(lines[0]?.message).toBe(
      'Database not reachable after 1 attempts: AggregateError: ' +
        'Error: connect ECONNREFUSED 127.0.0.1:5432; Error: connect ECONNREFUSED ::1:5432'
    )
  })

  it('never logs or throws DSN credentials embedded in error messages', async () => {
    const { lines, logger } = collectLogger()
    const leaky = new Error('connection failed for DATABASE_URL=postgres://ficus:hunter2@db:5432/tau')
    const rejection = await waitForDb(
      async () => {
        throw leaky
      },
      { logger, baseDelay: 0, maxRetries: 2 }
    ).then(
      () => {
        throw new Error('expected waitForDb to reject')
      },
      (err: unknown) => err as Error
    )
    expect(rejection.message).not.toContain('hunter2')
    expect(rejection.message).toContain('postgres://ficus:[REDACTED]@db:5432/tau')
    for (const line of lines) {
      expect(line.message).not.toContain('hunter2')
    }
    expect(lines[0]?.message).toContain('postgres://ficus:[REDACTED]@db:5432/tau')
  })
})

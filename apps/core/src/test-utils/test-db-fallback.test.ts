import { describe, expect, test } from 'bun:test'
import { createPostgresConnection } from '../db/connection'
import { validateDatabaseConnection } from '../db/validate-connection'
import {
  postgresFatalResponse,
  startTestDb,
  startUnavailableTestDb,
  TEST_DB_NOT_READY,
  testDbFallbackAllowed,
  unavailableTestDbBanner,
  unavailableTestDbMessage,
} from './test-db-fallback'

// Scripted docker/readiness seam: counts probes and sleeps instead of waiting.
function harness(options: { readyOnProbe?: number; up?: () => { exitCode: number | null; stderr: string } }) {
  const calls = { probes: 0, ups: 0, sleeps: 0 }
  return {
    calls,
    isReady: () => ++calls.probes === options.readyOnProbe,
    composeUp: () => {
      calls.ups++
      return (options.up ?? (() => ({ exitCode: 0, stderr: '' })))()
    },
    sleep: (ms: number) => {
      expect(ms).toBe(1000)
      calls.sleeps++
    },
  }
}

const daemonDown = () => ({
  exitCode: 1,
  stderr: 'Cannot connect to the Docker daemon at unix:///nonexistent.sock. Is the docker daemon running?\n',
})

describe('startTestDb without Docker (local direct bun test)', () => {
  test('a failed docker compose up reports the database unavailable instead of exiting after the wait', () => {
    const h = harness({ up: daemonDown })
    const result = startTestDb({ ...h, allowFallback: true })
    expect(result).toEqual({
      ready: false,
      reason:
        'docker compose up failed (exit 1): Cannot connect to the Docker daemon at unix:///nonexistent.sock. Is the docker daemon running?',
    })
    // No readiness budget is spent on a container that cannot exist.
    expect(h.calls).toEqual({ probes: 1, ups: 1, sleeps: 0 })
  })

  test('an unrunnable docker binary is reported, not thrown', () => {
    const h = harness({
      up: () => {
        throw new Error('Executable not found in $PATH: "docker"')
      },
    })
    expect(startTestDb({ ...h, allowFallback: true })).toEqual({
      ready: false,
      reason: 'could not run docker compose: Executable not found in $PATH: "docker"',
    })
  })

  test('a started container that never becomes ready is unavailable after the unchanged wait', () => {
    const h = harness({})
    expect(startTestDb({ ...h, allowFallback: true, maxWait: 30 })).toEqual({ ready: false, reason: TEST_DB_NOT_READY })
    expect(h.calls).toEqual({ probes: 31, ups: 1, sleeps: 29 })
  })

  test('a healthy database is used exactly as before', () => {
    const reused = harness({ readyOnProbe: 1 })
    expect(startTestDb({ ...reused, allowFallback: true })).toEqual({ ready: true })
    expect(reused.calls).toEqual({ probes: 1, ups: 0, sleeps: 0 })

    const started = harness({ readyOnProbe: 4 })
    expect(startTestDb({ ...started, allowFallback: true })).toEqual({ ready: true })
    expect(started.calls).toEqual({ probes: 4, ups: 1, sleeps: 2 })
  })
})

describe('startTestDb when a database is required (CI and the package runner)', () => {
  test('keeps the original sequence: compose result ignored, full wait, then not ready', () => {
    const h = harness({ up: daemonDown })
    expect(startTestDb({ ...h, allowFallback: false, maxWait: 30 })).toEqual({
      ready: false,
      reason: TEST_DB_NOT_READY,
    })
    expect(h.calls).toEqual({ probes: 31, ups: 1, sleeps: 29 })
  })

  test('a docker spawn error still propagates', () => {
    const h = harness({
      up: () => {
        throw new Error('spawn failed')
      },
    })
    expect(() => startTestDb({ ...h, allowFallback: false })).toThrow('spawn failed')
  })

  test('the fallback is allowed only outside CI and without FICUS_TEST_REQUIRE_DB', () => {
    expect(testDbFallbackAllowed({})).toBe(true)
    expect(testDbFallbackAllowed({ CI: 'true' })).toBe(false)
    expect(testDbFallbackAllowed({ CI: '1' })).toBe(false)
    expect(testDbFallbackAllowed({ CI: 'false' })).toBe(true)
    expect(testDbFallbackAllowed({ FICUS_TEST_REQUIRE_DB: '1' })).toBe(false)
    expect(testDbFallbackAllowed({ FICUS_TEST_REQUIRE_DB: '0' })).toBe(true)
  })
})

describe('the unavailable-database stand-in', () => {
  const reason = 'docker compose up failed (exit 1): daemon down'
  const message = unavailableTestDbMessage(reason)

  test('every database use fails fast with the cause instead of hanging or passing', async () => {
    const standIn = await startUnavailableTestDb(message)
    // The main pool's exact configuration. More sequential queries than the
    // four failed connects after which Core's socket factory used to wedge the
    // pool (see startUnavailableTestDb).
    const client = createPostgresConnection(standIn.url, { onnotice: () => {} }, { healthWatchdog: true })
    try {
      expect(process.env.FICUS_TEST_MODE).toBe('1')
      expect(() => validateDatabaseConnection(standIn.url, 'test-db-fallback.test')).not.toThrow()
      for (let attempt = 0; attempt < 8; attempt++) {
        const error = await client`SELECT 1`.then(
          () => undefined,
          (caught: unknown) => caught
        )
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(message)
      }
      // psql blocks this thread in spawnSync; the stand-in must still answer.
      const psql = Bun.spawnSync(['psql', standIn.url, '-c', 'SELECT 1'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 4_000,
      })
      expect(psql.signalCode ?? null).toBeNull()
      expect(psql.exitCode).not.toBe(0)
      expect(psql.stderr.toString()).toContain(`FATAL:  ${message}`)
    } finally {
      await client.end({ timeout: 0 })
      standIn.stop()
    }
  })

  test('the message and banner name the cause and the recovery', () => {
    expect(message).toStartWith(`Core test database unavailable (${reason}).`)
    expect(message).toContain('bun run test:db:down && bun run test:db:up')
    const banner = unavailableTestDbBanner(reason)
    expect(banner).toContain(`Core test database unavailable: ${reason}`)
    expect(banner).toContain('FICUS_TEST_REQUIRE_DB=1')
  })

  test('the FATAL response is a well-formed Postgres ErrorResponse', () => {
    const response = postgresFatalResponse('no\0db')
    expect(response.toString('latin1', 0, 1)).toBe('E')
    expect(response.readInt32BE(1)).toBe(response.length - 1)
    expect(response.subarray(5).toString('latin1')).toBe('SFATAL\0VFATAL\0C3D000\0Mno db\0\0')
  })
})

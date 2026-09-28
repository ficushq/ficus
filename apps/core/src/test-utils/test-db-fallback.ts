/**
 * Local fallback for when this worktree's Docker test Postgres cannot start.
 *
 * The Core test preload (test-setup.ts) runs for every test file, including the
 * many that never touch the database. Hard-exiting whenever Docker is stopped
 * or broken (daemon unreachable, "all predefined address pools have been fully
 * subnetted", ...) made even pure parser/command-builder tests unrunnable.
 *
 * Outside CI and the package runner, the preload instead points DATABASE_URL
 * at a local stand-in that refuses every connection with a Postgres FATAL
 * naming the cause (see {@link startUnavailableTestDb}). Files that never query
 * the database run normally; every database use (postgres.js, psql, pg_dump,
 * child processes) fails immediately with that message. Nothing is skipped,
 * and nothing can reach a real server: leaving DATABASE_URL unset would let
 * postgres.js fall back to the developer's localhost:5432.
 */

/**
 * Whether the preload may continue without a database. CI always expects one,
 * and the package runner (`bun run --filter core test`) sets
 * FICUS_TEST_REQUIRE_DB=1: both keep the original fail-fast exit.
 */
export function testDbFallbackAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const ci = env.CI
  if (ci && ci !== '0' && ci.toLowerCase() !== 'false') return false
  return env.FICUS_TEST_REQUIRE_DB !== '1'
}

export type TestDbStartup = { ready: true } | { ready: false; reason: string }

export const TEST_DB_NOT_READY = 'Test postgres did not become ready in time'

/**
 * Probe, start and wait for the test Postgres container.
 *
 * With `allowFallback: false` this is exactly the original sequence: the
 * compose result is ignored, readiness is polled `maxWait` times one second
 * apart, and a spawn error propagates. With `allowFallback: true` a failed or
 * unrunnable `docker compose up` reports the database unavailable immediately
 * instead of waiting out the readiness budget for a container that cannot exist.
 */
export function startTestDb(options: {
  isReady: () => boolean
  composeUp: () => { exitCode: number | null; stderr: string }
  sleep: (ms: number) => void
  allowFallback: boolean
  maxWait?: number
}): TestDbStartup {
  const { isReady, composeUp, sleep, allowFallback, maxWait = 30 } = options
  if (isReady()) return { ready: true }

  let up: { exitCode: number | null; stderr: string }
  try {
    up = composeUp()
  } catch (error) {
    if (!allowFallback) throw error
    return { ready: false, reason: `could not run docker compose: ${error instanceof Error ? error.message : error}` }
  }
  if (allowFallback && up.exitCode !== 0) {
    return {
      ready: false,
      reason: `docker compose up failed (exit ${String(up.exitCode)}): ${up.stderr.trim() || '(no output)'}`,
    }
  }

  for (let i = 0; i < maxWait; i++) {
    if (isReady()) return { ready: true }
    if (i === maxWait - 1) return { ready: false, reason: TEST_DB_NOT_READY }
    sleep(1000)
  }
  return { ready: false, reason: TEST_DB_NOT_READY }
}

/** The error every database use reports while the preload runs without one. */
export function unavailableTestDbMessage(reason: string): string {
  return (
    `Core test database unavailable (${reason}). ` +
    'This test needs Postgres: fix Docker, then run bun run test:db:down && bun run test:db:up.'
  )
}

/** Printed once when the preload continues without a database. */
export function unavailableTestDbBanner(reason: string): string {
  return (
    `Core test database unavailable: ${reason}\n` +
    'Continuing so database-free tests can run; every database use will fail with "Core test database unavailable".\n' +
    'Fix Docker, then run: bun run test:db:down && bun run test:db:up (set FICUS_TEST_REQUIRE_DB=1 to exit instead).'
  )
}

/**
 * A Postgres protocol ErrorResponse (FATAL, SQLSTATE 3D000) carrying `message`.
 * 3D000 (invalid_catalog_name) is deliberately not one of the connection codes
 * the startup-retry and scheduling classifiers treat as transient.
 */
export function postgresFatalResponse(message: string): Buffer {
  const fields = [
    ['S', 'FATAL'],
    ['V', 'FATAL'],
    ['C', '3D000'],
    ['M', message.replaceAll('\0', ' ')],
  ]
  const body = Buffer.concat([...fields.map(([type, value]) => Buffer.from(`${type}${value}\0`)), Buffer.from([0])])
  const header = Buffer.alloc(5)
  header.write('E', 0)
  header.writeInt32BE(4 + body.length, 1)
  return Buffer.concat([header, body])
}

/**
 * Start a loopback server that answers every Postgres connection with
 * {@link postgresFatalResponse}, and return a tau_test URL for it.
 *
 * Why a refusing server rather than an unresolvable or closed address: every
 * client (postgres.js, psql, pg_dump) then fails with this one message naming
 * the cause, instead of a bare connection-refused or DNS error, and postgres.js
 * does not retry it (3D000 is not a transient code).
 *
 * The server lives in a Worker because tests and the preload block the main
 * thread in `Bun.spawnSync(['psql', ...])`; a main-thread listener could not
 * answer and would deadlock them. The worker is unref'd, so it never keeps the
 * test process alive.
 */
export async function startUnavailableTestDb(message: string): Promise<{ url: string; stop: () => void }> {
  const worker = new Worker(new URL('./unavailable-test-db.worker.ts', import.meta.url).href)
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('unavailable-DB stand-in did not start within 10s')), 10_000)
      worker.onmessage = (event: MessageEvent<number>) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error(`unavailable-DB stand-in failed to start: ${event.message}`))
      }
      worker.postMessage(message)
    })
    // Bun's Worker supports unref(); Core's DOM Worker typing does not declare it.
    ;(worker as unknown as { unref(): void }).unref()
    return { url: `postgres://postgres:postgres@127.0.0.1:${port}/tau_test`, stop: () => worker.terminate() }
  } catch (error) {
    worker.terminate()
    throw error
  }
}

import { createHash } from 'crypto'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Cross-process mutex for test-database setup. Concurrent preloads must serialize
 * their probe, teardown, recreation and migration sequence so one process cannot
 * destroy another process's active database. The lock is keyed by the worktree
 * root and uses exclusive file creation with a bounded wait and stale-holder
 * recovery. It is a host-only subpath, not part of the browser barrel.
 */

// Must comfortably exceed the worst-case legitimate duration of the guarded
// probe/teardown/recreate/migrate section (apps/core/src/test-setup.ts's
// container-start wait loop alone budgets up to 30 x 1s of sleep, plus
// per-iteration readiness-probe overhead, before it gives up) — otherwise a
// second process can fail this lock's own timeout despite the first holder
// being perfectly healthy, just slow on a loaded machine (cold container
// start, contended CI runner). 100s leaves ~3x margin over that 30s floor.
const DEFAULT_TIMEOUT_MS = 100_000
const POLL_MS = 200

/** Deterministic lockfile path shared by all callers using the same repository root. */
export function testDbLockPath(repoRoot: string): string {
  const dirHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  return join(tmpdir(), `ficus-test-db-${dirHash}.lock`)
}

export interface TestDbLockHandle {
  /** Release the lock. Safe to call even if the lockfile is already gone. */
  release(): void
}

function readHolder(lockPath: string): string {
  try {
    return readFileSync(lockPath, 'utf-8').trim() || '(empty lockfile)'
  } catch {
    return '(lockfile unreadable or already gone)'
  }
}

/** Atomically claim the lockfile by writing `token` iff it does not already exist. */
function tryClaim(lockPath: string, token: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, token)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * True if the lockfile's recorded PID is no longer running — i.e. its
 * holder was killed (crash, `kill -9`, CI cancellation) without releasing
 * the lock. This is what stands in for flock(2)'s automatic release: we
 * can't get the kernel to drop the lock for us, so we check liveness
 * ourselves before waiting the full timeout out. Same-machine only (the
 * documented environment for this lock) — process.kill(pid, 0) does not
 * cross hosts, but this lock never needs to.
 */
function isAbandoned(lockPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf-8')
  } catch {
    return true // lockfile vanished (e.g. the holder already released it) — safe to reclaim
  }
  const pid = Number(raw.split(':')[0])
  if (!Number.isInteger(pid) || pid <= 0) return true // corrupt/foreign content — safe to reclaim
  try {
    process.kill(pid, 0)
    return false // signal 0 succeeded: process exists, lock is live
  } catch (err) {
    // ESRCH: no such process -> truly abandoned, reclaim it.
    // EPERM: process exists but owned by someone else -> treat as alive,
    // never reclaim a lock we can't prove is dead.
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Acquire the test-DB setup lock for `repoRoot`, blocking (via a bounded
 * poll loop) until it is free or `timeoutMs` elapses.
 *
 * The poll loop uses `Bun.sleepSync`, so acquisition blocks the whole event
 * loop for the duration of the wait — including from `withTestDbLock`'s
 * async variant, which does not get non-blocking waiting for free just by
 * being async. That's harmless here (this only ever runs inside a Bun
 * preload, before any test file's own async work has started), but it means
 * this is NOT "cooperative" waiting — don't rely on other work interleaving
 * during acquisition.
 *
 * Must hold:
 * - Never deadlocks forever: a lockfile abandoned by a killed process is
 *   detected and reclaimed via isAbandoned() above, and even absent that,
 *   the wait is hard-bounded by timeoutMs with a diagnostic naming the
 *   lockfile and its last known holder.
 * - Callers are expected to hold this only across the lifecycle sequence
 *   (probe/teardown/recreate/migrate), not the whole test run — see
 *   withTestDbLock.
 */
export function acquireTestDbLock(repoRoot: string, opts?: { timeoutMs?: number }): TestDbLockHandle {
  const lockPath = testDbLockPath(repoRoot)
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const token = `${process.pid}:${Date.now()}`
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (tryClaim(lockPath, token)) {
      return {
        release() {
          // Only remove the lockfile if it still holds OUR token. Guards
          // against the rare case where our lock was reclaimed as
          // "abandoned" by a false positive (e.g. a corrupted read) and a
          // different process has since claimed it — unlinking
          // unconditionally there would delete a live lock out from under
          // its rightful holder, reopening the exact race this exists to
          // close.
          try {
            if (readFileSync(lockPath, 'utf-8') === token) unlinkSync(lockPath)
          } catch {
            // already gone — fine, nothing to release
          }
        },
      }
    }

    if (isAbandoned(lockPath)) {
      try {
        unlinkSync(lockPath)
      } catch {
        // another process already reclaimed it first — loop and retry the claim
      }
      continue
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the shared test-db setup lock at ${lockPath}. ` +
          `Another 'bun test' process (holder: ${readHolder(lockPath)}) appears to still be inside ` +
          `the probe/teardown/migrate sequence. If that process is confirmed gone (crashed without ` +
          `cleanup), delete the lockfile and retry: rm ${lockPath}`
      )
    }

    Bun.sleepSync(POLL_MS)
  }
}

/**
 * Run a synchronous `section` while holding the test-db setup lock for
 * `repoRoot`, releasing it once `section` returns or throws. For a fully
 * spawnSync-based sequence (apps/core's test-setup.ts) so the preload never
 * needs top-level await.
 */
export function withTestDbLockSync<T>(repoRoot: string, section: () => T, opts?: { timeoutMs?: number }): T {
  const lock = acquireTestDbLock(repoRoot, opts)
  try {
    return section()
  } finally {
    lock.release()
  }
}

/**
 * Run `section` (sync or async) while holding the test-db setup lock for
 * `repoRoot`, releasing it once `section` settles (success or throw).
 */
export async function withTestDbLock<T>(
  repoRoot: string,
  section: () => T | Promise<T>,
  opts?: { timeoutMs?: number }
): Promise<T> {
  const lock = acquireTestDbLock(repoRoot, opts)
  try {
    return await section()
  } finally {
    lock.release()
  }
}

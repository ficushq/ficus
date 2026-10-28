/** Host-only ownership for ephemeral Compose databases. No age-only deletion. */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireTestDbLock } from './testDbLock'
import { testDbProjectName } from './testDbPort'

const STALE_MS = 2 * 60 * 60 * 1000
const CLEANUP_MS = 10000
export interface TestDbOwner {
  version: number
  repoRoot: string
  composeFile: string
  project: string
  scope: string
  host: string
  pid: number
  token: string
  createdAt: number
  ownerReleased: boolean
  borrowers: number[]
}
function ownerAlive(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined
  }
}
function valid(record: TestDbOwner): boolean {
  return (
    record.version === 2 &&
    typeof record.ownerReleased === 'boolean' &&
    Array.isArray(record.borrowers) &&
    record.borrowers.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
    typeof record.repoRoot === 'string' &&
    resolve(record.repoRoot) === record.repoRoot &&
    record.project === testDbProjectName(record.repoRoot) &&
    record.composeFile === join(record.repoRoot, 'docker-compose.test.yml') &&
    Number.isFinite(record.createdAt) &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.token === 'string' &&
    record.token.length > 0
  )
}
export function canReapTestDb(
  record: TestDbOwner,
  context: { now: number; scope: string; host: string; ownerAlive: (pid: number) => boolean | undefined }
): boolean {
  return (
    valid(record) &&
    record.scope === context.scope &&
    record.host === context.host &&
    context.now - record.createdAt >= STALE_MS &&
    usersGone(record, context.ownerAlive)
  )
}
/** Unknown PID state protects resources just like a live process does. */
function usersGone(record: TestDbOwner, alive = ownerAlive): boolean {
  return (record.ownerReleased || alive(record.pid) === false) && record.borrowers.every((pid) => alive(pid) === false)
}
function writeOwner(file: string, record: TestDbOwner): void {
  // A killed borrower must not leave a partially overwritten membership record.
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* Already renamed or removed. */
    }
  }
}
function registry(): string {
  const dir = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    `ficus-test-db-owners-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(hostname()).digest('hex').slice(0, 8)}`
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
function scopeFor(root: string): string {
  // The git common directory is stable across linked worktrees. Never infer
  // ownership of a different clone merely from a ficus-test-* name.
  const result = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--git-common-dir'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    killSignal: 'SIGKILL',
  })
  return result.exitCode === 0 ? realpathSync(resolve(root, result.stdout.toString().trim())) : join(root, '.git')
}
function readOwner(file: string): TestDbOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return valid(value) ? value : undefined
  } catch {
    return undefined
  }
}
function locked<T>(root: string, fn: () => T): T {
  const lock = acquireTestDbLock(`${root}:lifecycle`, { timeoutMs: 2000 })
  try {
    return fn()
  } finally {
    lock.release()
  }
}
/** A wedged Docker CLI must never keep EXIT cleanup alive indefinitely. */
export function downTestDb(
  record: Pick<TestDbOwner, 'repoRoot' | 'project' | 'composeFile'> & { token?: string },
  fallbackComposeFile?: string
): boolean {
  try {
    if (record.token) {
      const proof = Bun.spawnSync(
        [
          'docker',
          'ps',
          '-a',
          '--filter',
          `label=com.docker.compose.project=${record.project}`,
          '--format',
          '{{.Label "dev.ficus.test-db.owner"}}',
        ],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5000, killSignal: 'SIGKILL' }
      )
      if (
        proof.exitCode !== 0 ||
        proof.signalCode ||
        (proof.stdout.length > 0 &&
          proof.stdout
            .toString()
            .replace(/\n$/, '')
            .split('\n')
            .some((token) => token !== record.token))
      ) {
        console.error(
          `[test-db] Refusing cleanup of ${record.project}: ownership labels could not be verified (probe limit 5000ms). ${proof.stderr.toString().slice(-2000)}`
        )
        return false
      }
    }
    const result = Bun.spawnSync(
      [
        'docker',
        'compose',
        '-p',
        record.project,
        '-f',
        existsSync(record.composeFile) ? record.composeFile : (fallbackComposeFile ?? record.composeFile),
        'down',
        '--volumes',
        '--remove-orphans',
        // Docker's default stop grace is itself 10s: leave CLI overhead margin.
        '--timeout',
        '2',
      ],
      {
        env: { ...process.env, TEST_REPO_ROOT: record.repoRoot },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        timeout: CLEANUP_MS,
        killSignal: 'SIGKILL',
      }
    )
    if (result.exitCode === 0 && !result.signalCode) return true
    console.error(
      `[test-db] Cleanup failed for ${record.project} (limit ${CLEANUP_MS}ms): ${result.stderr.toString().slice(-2000) || result.signalCode || result.exitCode}. Retry this worktree's test:db:down.`
    )
  } catch (error) {
    console.error(
      `[test-db] Cleanup failed for ${record.project} (limit ${CLEANUP_MS}ms): ${String(error).slice(-2000)}. Retry test:db:down.`
    )
  }
  return false
}
/** Explicit project-scoped manual teardown must not interrupt a live session. */
export function stopOwnedTestDb(repoRoot: string): boolean {
  return locked(repoRoot, () => {
    const file = join(registry(), `${testDbProjectName(repoRoot)}.json`)
    const owner = readOwner(file)
    if (existsSync(file) && (!owner || owner.host !== hostname() || !usersGone(owner))) {
      console.error(`[test-db] Refusing teardown of ${testDbProjectName(repoRoot)}: live owner or unknown ownership`)
      return false
    }
    if (
      !downTestDb(
        owner ?? {
          repoRoot,
          project: testDbProjectName(repoRoot),
          composeFile: join(repoRoot, 'docker-compose.test.yml'),
        }
      )
    )
      return false
    if (owner) unlinkSync(file)
    return true
  })
}

/** Only recorded projects from this clone, on this host, with dead owners. */
export function sweepStaleTestDbs(repoRoot: string): string[] {
  const removed: string[] = []
  const scope = scopeFor(repoRoot)
  const deadline = Date.now() + 15000
  let attempts = 0
  for (const name of readdirSync(registry()).slice(0, 100)) {
    if (!/^ficus-test-[a-f0-9]{8}\.json$/.test(name)) continue
    const file = join(registry(), name)
    const candidate = readOwner(file)
    if (!candidate || !canReapTestDb(candidate, { now: Date.now(), scope, host: hostname(), ownerAlive })) continue
    if (Date.now() >= deadline || attempts++ >= 3) break
    locked(candidate.repoRoot, () => {
      const record = readOwner(file)
      if (
        !record ||
        record.token !== candidate.token ||
        !canReapTestDb(record, { now: Date.now(), scope, host: hostname(), ownerAlive })
      )
        return
      if (downTestDb(record, join(repoRoot, 'docker-compose.test.yml'))) {
        unlinkSync(file)
        removed.push(record.project)
      }
    })
    // Each cleanup is bounded; the sweep also caps attempts and total scheduling time.
  }
  return removed
}

/**
 * Register before any startup/probe. A runner can lend its token to child
 * preloads, preserving sequential schema reuse, but independent overlapping
 * runs fail closed rather than resetting/destroying each other's database.
 */
export function ownTestDb(
  repoRoot: string,
  options: { handleSignals?: boolean; /** Clone owning a temporary fixture root. */ scopeRoot?: string } = {}
): { release(): void } {
  repoRoot = realpathSync(repoRoot)
  const file = join(registry(), `${testDbProjectName(repoRoot)}.json`)
  const inherited = process.env.FICUS_TEST_DB_OWNER
  const record = locked(repoRoot, () => {
    const previous = readOwner(file)
    if (previous && previous.repoRoot !== repoRoot)
      throw new Error('Test DB project identity collision; refusing foreign ownership')
    if (
      previous &&
      inherited === previous.token &&
      previous.host === hostname() &&
      !previous.ownerReleased &&
      ownerAlive(previous.pid) === true
    ) {
      if (previous.pid === process.pid) return undefined
      previous.borrowers = [...new Set([...previous.borrowers, process.pid])]
      writeOwner(file, previous)
      return { owner: previous, borrowed: true }
    }
    if (existsSync(file)) {
      if (!previous || previous.host !== hostname() || !usersGone(previous))
        throw new Error(
          `Test DB ${testDbProjectName(repoRoot)} already has a live or unknown owner; use a separate worktree.`
        )
      if (!downTestDb(previous)) throw new Error('Cannot reclaim this worktree test database; Docker cleanup failed')
    }
    if (!previous) {
      const listed = Bun.spawnSync(
        ['docker', 'ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${testDbProjectName(repoRoot)}`],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5000, killSignal: 'SIGKILL' }
      )
      if (listed.exitCode !== 0 || listed.signalCode)
        throw new Error(
          `Cannot verify test database inventory (limit 5000ms): ${listed.stderr.toString().slice(-2000) || listed.signalCode || listed.exitCode}`
        )
      if (listed.stdout.toString().trim())
        throw new Error(
          `Refusing to adopt unrecorded test database ${testDbProjectName(repoRoot)}. Confirm it is unused, then run this worktree's test:db:down.`
        )
    }
    const owner: TestDbOwner = {
      version: 2,
      repoRoot,
      composeFile: join(repoRoot, 'docker-compose.test.yml'),
      project: testDbProjectName(repoRoot),
      scope: scopeFor(options.scopeRoot ?? repoRoot),
      host: hostname(),
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
      ownerReleased: false,
      borrowers: [],
    }
    writeOwner(file, owner)
    return { owner, borrowed: false }
  })
  if (!record) return { release() {} }
  process.env.FICUS_TEST_DB_OWNER = record.owner.token
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      locked(repoRoot, () => {
        const current = readOwner(file)
        if (!current || current.token !== record.owner.token) return
        if (record.borrowed) current.borrowers = current.borrowers.filter((pid) => pid !== process.pid)
        else current.ownerReleased = true
        writeOwner(file, current)
        if (usersGone(current)) {
          if (downTestDb(current)) unlinkSync(file)
          else if (!process.exitCode) process.exitCode = 1
        }
      })
    } catch (error) {
      console.error(`[test-db] Cleanup ownership check failed: ${String(error)}`)
      if (!process.exitCode) process.exitCode = 1
    }
    if (process.env.FICUS_TEST_DB_OWNER === record.owner.token) delete process.env.FICUS_TEST_DB_OWNER
  }
  process.once('exit', release)
  if (options.handleSignals !== false) {
    process.once('SIGINT', () => {
      process.exitCode = 130
      release()
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      process.exitCode = 143
      release()
      process.exit(143)
    })
  }
  return { release }
}

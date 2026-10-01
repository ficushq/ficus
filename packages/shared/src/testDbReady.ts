/**
 * Test-database liveness probes. Cached ephemeral ports may be reused by another
 * worktree, so verify the owning Compose project and a real query before reuse.
 */

const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * Verify a Postgres database actually accepts real queries, not just TCP
 * connections. `pg_isready` (and even a bare TCP connect) can report success
 * while the server is in a state that hangs on real queries — connection
 * exhaustion, stale locks, mid-shutdown. Spawns a disposable one-off `bun -e`
 * process rather than importing `postgres` in-process, so a hung connection
 * attempt can't block the caller past `timeoutMs` (Bun.spawnSync enforces
 * the timeout by killing the child; an in-process `await` has no such
 * escape hatch).
 */
export function canExecuteQuery(port: number, dbName: string, opts?: { timeoutMs?: number; cwd?: string }): boolean {
  const url = `postgres://postgres:postgres@localhost:${port}/${dbName}`
  const script = `
    const postgres=(await import('postgres')).default;
    const sql=postgres(process.env.URL,{connect_timeout:5,max:1});
    try{await sql\`SELECT 1\`;process.exit(0)}catch{process.exit(1)}
  `.replace(/\s+/g, ' ')
  try {
    const r = Bun.spawnSync(['bun', '-e', script], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: opts?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      env: { ...process.env, URL: url },
      cwd: opts?.cwd,
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}

export interface ComposePostgresReadyOptions {
  /** docker-compose project name owning the container, e.g. `ficus-test-<hash>`. */
  projectName: string
  /** Absolute path to docker-compose.test.yml. */
  composeFile: string
  /** cwd for canExecuteQuery's spawned verification script (must resolve the
   *  `postgres` package via node_modules — pass the calling app's root). */
  cwd?: string
  timeoutMs?: number
}

export interface ComposeBoundPortOptions {
  /** docker-compose project name owning the container, e.g. `ficus-test-<hash>`. */
  projectName: string
  /** Absolute path to docker-compose.test.yml. */
  composeFile: string
  timeoutMs?: number
}

/**
 * Ask docker (not our own bookkeeping) which host port the named project's
 * `postgres` service is actually bound to. This is the source of truth for
 * "does `port` really belong to THIS project" — `docker compose exec ...
 * pg_isready` (below) only proves the project's container is healthy over
 * its own internal socket; it says nothing about which host port maps to
 * it, so on its own it cannot rule out a `port` argument that happens to
 * route to a completely different project's container. Returns `null` if
 * the service isn't running or compose can't answer within `timeoutMs`.
 */
export function getComposeBoundPort(opts: ComposeBoundPortOptions): number | null {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  try {
    const result = Bun.spawnSync(
      ['docker', 'compose', '-p', opts.projectName, '-f', opts.composeFile, 'port', 'postgres', '5432'],
      { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs }
    )
    if (result.exitCode !== 0) return null
    // Expected stdout e.g. "0.0.0.0:49298\n" — take the numeric suffix after
    // the last colon (also correct for a bracketed IPv6 host part).
    const match = result.stdout
      .toString()
      .trim()
      .match(/:(\d+)$/)
    if (!match) return null
    const boundPort = parseInt(match[1], 10)
    return Number.isInteger(boundPort) ? boundPort : null
  } catch {
    return null
  }
}

/**
 * Is the named compose project's postgres container up AND actually
 * answering queries on `port`? Checks against the `ficus_test` database
 * specifically — the container's own bootstrap database (`POSTGRES_DB` in
 * docker-compose.test.yml), guaranteed to exist as soon as the container's
 * initdb has run, regardless of which app-specific database (such as `ficus_test`) the caller ultimately wants to use. That makes
 * this check meaningful before an application-specific database is created.
 *
 * THREE checks, all required — dropping any one reopens a real cross-worktree
 * data-loss hole (see the `getComposeBoundPort` doc comment and Core #795's
 * follow-up review):
 *  1. `docker compose exec ... pg_isready` proves THIS worktree's named
 *     container is healthy over its own internal socket.
 *  2. `getComposeBoundPort` proves THIS container is the one actually bound
 *     to `port` — without this, a stale cached port that the OS has since
 *     handed to a different (but perfectly healthy) worktree's container
 *     would pass check 1 (this project is healthy) and check 3 (the other
 *     worktree's DB is genuinely reachable and query-able), and the caller
 *     would trust it as if it were this project's own — including running
 *     `TRUNCATE ... CASCADE` against a live neighbor's in-flight data.
 *  3. `canExecuteQuery` proves the port mapping externally really does route
 *     to a Postgres that answers real queries (catches stale/overloaded DB).
 */
export function isComposePostgresReady(port: number, opts: ComposePostgresReadyOptions): boolean {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const spawnOpts = { stdout: 'ignore' as const, stderr: 'ignore' as const, timeout: timeoutMs }

  try {
    const dockerCheck = Bun.spawnSync(
      [
        'docker',
        'compose',
        '-p',
        opts.projectName,
        '-f',
        opts.composeFile,
        'exec',
        '-T',
        'postgres',
        'pg_isready',
        '-U',
        'postgres',
        '-d',
        'ficus_test',
      ],
      spawnOpts
    )
    if (dockerCheck.exitCode === 0) {
      // pg_isready passed for THIS project's container, but that alone
      // doesn't prove it's bound to `port` — confirm ownership before
      // trusting a query against localhost:<port> to be this project's DB.
      const boundPort = getComposeBoundPort({ projectName: opts.projectName, composeFile: opts.composeFile, timeoutMs })
      if (boundPort !== port) return false
      return canExecuteQuery(port, 'ficus_test', { timeoutMs, cwd: opts.cwd })
    }
  } catch {
    // docker not available or timed out (e.g. container down)
  }

  return false
}

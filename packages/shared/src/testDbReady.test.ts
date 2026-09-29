import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canExecuteQuery, getComposeBoundPort, isComposePostgresReady } from './testDbReady'

// Two real docker-compose projects take longer to come up than bun's 5s
// default hook/test timeout.
setDefaultTimeout(120_000)

// This suite spins up two REAL, independent docker-compose projects on two
// real ports to reproduce the exact Core #795 follow-up race: a cached port
// that used to belong to "our" project but has since been reassigned (by the
// OS's ephemeral-port allocator) to a completely different, but perfectly
// healthy, project's container. `isComposePostgresReady` must reject that
// combination outright rather than vouching for a foreign database.
//
// Heavier than a typical unit test (two real postgres containers), but the
// bug this guards against is a live, unconditional `TRUNCATE ... CASCADE`
// against a neighboring worktree's in-flight test data — worth the wall
// time. Uses ad hoc project names so it never touches another worktree's or
// developer's real `tau-test-<hash>` containers, and tears both down in
// afterAll.

const composeFile = join(__dirname, '../../../docker-compose.test.yml')
// Resolve the `postgres` npm package via the monorepo root's hoisted
// node_modules (packages/shared itself doesn't depend on it directly).
const queryCwd = join(__dirname, '../../..')

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  server.stop()
  if (!port) throw new Error('failed to allocate a free port for the test')
  return port
}

function composeUp(projectName: string, port: number, fakeRepoRoot: string): void {
  Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'up', '-d', 'postgres'], {
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 60_000,
    env: { ...process.env, TEST_DB_PORT: String(port), TEST_REPO_ROOT: fakeRepoRoot },
  })
}

function composeDown(projectName: string): void {
  Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'down', '--volumes'], {
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 20_000,
  })
}

// Poll with the already-trusted, unchanged primitive (canExecuteQuery) —
// not isComposePostgresReady, the function under test — so test setup
// doesn't presuppose the behavior being verified.
function waitUntilQueryable(port: number, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (canExecuteQuery(port, 'tau_test', { timeoutMs: 3000, cwd: queryCwd })) return
    Bun.sleepSync(500)
  }
  throw new Error(`postgres on port ${port} never became queryable within ${timeoutMs}ms`)
}

describe('cross-project port ownership (tau #795 follow-up)', () => {
  const suffix = `${Date.now()}-${process.pid}`
  const projectA = `tau-test-ownercheck-a-${suffix}`
  const projectB = `tau-test-ownercheck-b-${suffix}`
  const portA = freePort()
  const portB = freePort()
  const scratchRoot = mkdtempSync(join(tmpdir(), 'tau-test-db-ready-test-'))

  beforeAll(() => {
    composeUp(projectA, portA, scratchRoot)
    composeUp(projectB, portB, scratchRoot)
    waitUntilQueryable(portA)
    waitUntilQueryable(portB)
  })

  afterAll(() => {
    composeDown(projectA)
    composeDown(projectB)
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  test('getComposeBoundPort reports the real host port for each independent project', () => {
    expect(getComposeBoundPort({ projectName: projectA, composeFile })).toBe(portA)
    expect(getComposeBoundPort({ projectName: projectB, composeFile })).toBe(portB)
  })

  test('accepts a port that genuinely belongs to the named project', () => {
    expect(isComposePostgresReady(portA, { projectName: projectA, composeFile, cwd: queryCwd })).toBe(true)
    expect(isComposePostgresReady(portB, { projectName: projectB, composeFile, cwd: queryCwd })).toBe(true)
  })

  test('rejects a cached port that answers real queries but belongs to a DIFFERENT project', () => {
    // portB is a genuinely live, query-able Postgres (project B's own
    // container) — exactly what a stale `.test-db-port` reassigned by the OS
    // to a different worktree looks like from the outside. project A is also
    // healthy. Before the ownership check, pg_isready on project A would
    // pass and canExecuteQuery(portB) would ALSO pass (project B is real and
    // reachable), so the old two-part check would wrongly vouch for it.
    expect(isComposePostgresReady(portB, { projectName: projectA, composeFile, cwd: queryCwd })).toBe(false)
    expect(isComposePostgresReady(portA, { projectName: projectB, composeFile, cwd: queryCwd })).toBe(false)
  })
})

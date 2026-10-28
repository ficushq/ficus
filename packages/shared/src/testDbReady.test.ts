import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'fs'
import { ownTestDb } from './testDbLifecycle'
import { testDbProjectName } from './testDbPort'
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
// developer's real `ficus-test-<hash>` containers, and tears both down in
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
  const up = Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'up', '-d', 'postgres'], {
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, TEST_DB_PORT: String(port), TEST_REPO_ROOT: fakeRepoRoot },
  })
  if (up.exitCode !== 0 || up.signalCode) throw new Error(`Compose startup failed for ${projectName}`)
}

// Poll with the already-trusted, unchanged primitive (canExecuteQuery) —
// not isComposePostgresReady, the function under test — so test setup
// doesn't presuppose the behavior being verified.
async function waitUntilQueryable(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (canExecuteQuery(port, 'ficus_test', { timeoutMs: 3000, cwd: queryCwd })) return
    await Bun.sleep(500)
  }
  throw new Error(`postgres on port ${port} never became queryable within ${timeoutMs}ms`)
}

describe('cross-project port ownership (Core #795 follow-up)', () => {
  const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-test-db-ready-test-')))
  const rootA = join(scratchRoot, 'a')
  const rootB = join(scratchRoot, 'b')
  for (const root of [rootA, rootB]) {
    mkdirSync(root)
    symlinkSync(composeFile, join(root, 'docker-compose.test.yml'))
  }
  const projectA = testDbProjectName(rootA)
  const projectB = testDbProjectName(rootB)
  const portA = freePort()
  const portB = freePort()
  let sessionA: ReturnType<typeof ownTestDb> | undefined
  let sessionB: ReturnType<typeof ownTestDb> | undefined

  beforeAll(async () => {
    sessionA = ownTestDb(rootA, { scopeRoot: queryCwd })
    composeUp(projectA, portA, rootA)
    sessionB = ownTestDb(rootB, { scopeRoot: queryCwd })
    composeUp(projectB, portB, rootB)
    await waitUntilQueryable(portA)
    await waitUntilQueryable(portB)
  })

  afterAll(() => {
    sessionB?.release()
    sessionA?.release()
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

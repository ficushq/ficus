import { requireTestDbCapacity } from '@ficus/shared/testDbCapacity'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ownTestDb, sweepStaleTestDbs, downTestDb } from '@ficus/shared/testDbLifecycle'
import { withTestDbLockSync } from '@ficus/shared/testDbLock'
import { isComposePostgresReady } from '@ficus/shared/testDbReady'
import { findFreeTestDbPort, testDbPortFile, testDbProjectName } from '@ficus/shared/testDbPort'
import { expectedCheckConstraints, expectedTableColumns, findSchemaDrift, parseColumnRows } from './db/expected-schema'
import { expectedForeignKeys, foreignKeyStatements } from './db/expected-foreign-keys'
import { runnerTestSchemaCache } from './test-utils/schema-cache'
import {
  startTestDb,
  startUnavailableTestDb,
  TEST_DB_NOT_READY,
  testDbFallbackAllowed,
  unavailableTestDbBanner,
  unavailableTestDbMessage,
} from './test-utils/test-db-fallback'

/** Called once, on demand, never by the environment-only preload itself. */
export async function setupTestDatabase(ciDatabaseUrl: string | undefined): Promise<void> {
  // Before external readiness, inventory, ownership, schema work or Compose.
  requireTestDbCapacity()
  // Check if we have a working DATABASE_URL from CI (e.g., GitHub Actions service container)
  let useExternalDb = false

  if (ciDatabaseUrl) {
    // Try to connect only to an explicitly recognized test database.
    try {
      const url = new URL(ciDatabaseUrl)
      const databaseName = url.pathname.slice(1)
      if (!['ficus_test', 'ficus_secret_boundary_test'].includes(databaseName))
        throw new Error('unrecognized test database')
      const port = parseInt(url.port || '5432', 10)
      const result = Bun.spawnSync(
        ['pg_isready', '-h', url.hostname, '-p', String(port), '-U', url.username || 'postgres', '-d', databaseName],
        { stdout: 'ignore', stderr: 'ignore', timeout: 5000 }
      )
      if (result.exitCode === 0) {
        useExternalDb = true
        console.log(`Using CI-provided database: ${url.hostname}:${port}`)
      }
    } catch {
      // Failed to parse or connect, fall through to local setup
    }
  }

  // Clear DATABASE_URL if we're not using the CI-provided one
  if (!useExternalDb) {
    delete process.env.DATABASE_URL
  }

  // --- Isolation: each worktree gets its own test DB on a unique port ---

  const repoRoot = join(__dirname, '../../..')
  const composeFile = join(repoRoot, 'docker-compose.test.yml')
  const portFile = testDbPortFile(repoRoot)

  // Deterministic project name from directory path so each worktree has its own containers
  const projectName = testDbProjectName(repoRoot)

  function tearDownTestDb(): void {
    if (!downTestDb({ repoRoot, project: projectName, composeFile, token: process.env.FICUS_TEST_DB_OWNER })) {
      console.error('Cannot reset this worktree test database; refusing to continue after failed cleanup')
      process.exit(1)
    }
  }

  /**
   * Truncate every table in ficus_test's public schema (structure, extensions
   * and constraints untouched) so the DB is empty by the time `drizzle-kit
   * push` runs, regardless of whether this run tore the container down or is
   * reusing one left up by a previous run. See the call site's comment for why
   * this specifically has to happen before `push` (an interactive prompt that
   * `--force` does not suppress, hanging the whole suite on reuse otherwise).
   */
  function resetTestData(url: string): void {
    const sql =
      `DO $$ DECLARE r RECORD; BEGIN ` +
      `FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP ` +
      `EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE'; ` +
      `END LOOP; END $$;`
    // Fatal, not a warning: this function's entire reason to exist is to stop
    // `drizzle-kit push --force` below from hitting its unsuppressable
    // interactive "truncate this table? y/n" prompt, which hangs the whole
    // suite for the full 60s timeout with no useful message (see the call
    // site's comment). Swallowing a psql failure here as a warning would let
    // execution fall through into `push` and let that exact hang recur —
    // except now it's buried behind a warning a developer has to correlate
    // with a confusing timeout a full minute later, instead of failing fast
    // with the real cause.
    try {
      const result = Bun.spawnSync(['psql', url, '-c', sql], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10000,
      })
      if (result.exitCode !== 0) {
        console.error('Failed to reset test data before schema push:', result.stderr.toString())
        process.exit(1)
      }
    } catch (err) {
      console.error('Failed to reset test data before schema push:', err)
      process.exit(1)
    }
  }

  /**
   * Indexes that `drizzle-kit push` cannot introspect, and which therefore must
   * not exist when it runs.
   *
   * `push` starts by pulling the CURRENT schema out of the database and parsing
   * it with zod. `idx_messages_agent_stream_group_pattern` (added in #883) is an
   * expression index with a non-default operator class —
   * `(metadata->>'streamGroupId') text_pattern_ops` — which drizzle-kit's
   * introspection has no representation for: it reads that column's `expression`
   * back as null, zod rejects it, and the command dies with a `_ZodError` while
   * still EXITING 0 and applying nothing.
   *
   * That is a progressive, silent corruption rather than a one-off, because the
   * suite creates the index itself (analyzer-index.test.ts and
   * schema-indexes.test.ts both create it; neither drops it). A developer's
   * ficus_test therefore works, permanently acquires the index on its first run,
   * and from then on every run silently skips the schema push and executes
   * against whatever schema happened to already be there — surfacing much later
   * as baffling missing-table/column failures in unrelated code. CI cannot catch
   * it: it builds ficus_test fresh and pushes before any test can create the index.
   *
   * Dropping these before the push costs nothing, because `push` does not create
   * them in the first place — it silently skips partial and expression indexes
   * (51 of them, comparing a push-built database against a migration-built one),
   * which is why this file re-applies a hand-written subset further down. The two
   * tests that need this index create it themselves.
   *
   * If a future index trips the same limitation, the ZodError guard at the push
   * call site names it — add it here.
   */
  const INTROSPECTION_HOSTILE_INDEXES = [
    'idx_messages_agent_stream_group_pattern',
    // drizzle-kit also reports the executionId expression as null on re-introspection.
    'idx_messages_agent_execution',
    'idx_webhook_events_verified_repo_delivery',
    'idx_inbox_work_stream_id',
    'idx_messages_chat_source_page',
    'idx_messages_agent_stream_group',
    'idx_messages_agent_inbox_consumed',
    'idx_messages_agent_sandbox_recovery_unique',
    'idx_owned_worktree_path',
  ]

  function dropIntrospectionHostileIndexes(url: string): void {
    const sql = INTROSPECTION_HOSTILE_INDEXES.map((name) => `DROP INDEX IF EXISTS "public"."${name}"`).join('; ')
    // Fatal for the same reason resetTestData is: if this does not happen, the
    // push silently becomes a no-op and the damage surfaces as unrelated schema
    // errors a long way from the actual cause.
    try {
      const result = Bun.spawnSync(['psql', url, '-c', sql], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
      if (result.exitCode !== 0) {
        console.error('Failed to drop introspection-hostile indexes before schema push:', result.stderr.toString())
        process.exit(1)
      }
    } catch (err) {
      console.error('Failed to drop introspection-hostile indexes before schema push:', err)
      process.exit(1)
    }
  }

  const quoteIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'"

  /**
   * Run `statements` as one psql invocation, or halt the run.
   *
   * Fatal for the same reason resetTestData and dropIntrospectionHostileIndexes
   * are: a half-applied constraint set is exactly the silent divergence these
   * exist to remove, and it would resurface later as an unrelated-looking
   * constraint violation a long way from its cause.
   */
  function runDdlOrExit(url: string, statements: string[], what: string): void {
    const fail = (detail: string) => {
      console.error(`Failed to ${what}:\n${detail}\nRecover with: bun run test:db:down && bun run test`)
      process.exit(1)
    }
    try {
      const result = Bun.spawnSync(['psql', url, '-v', 'ON_ERROR_STOP=1', '-c', statements.join('; ')], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10000,
      })
      if (result.exitCode !== 0) fail(result.stderr.toString())
    } catch (err) {
      fail(String(err))
    }
  }

  /**
   * CHECK constraints a warm test database would otherwise keep forever.
   *
   * `drizzle-kit push` emits a table's CHECK constraints inline when it CREATEs
   * the table and then never touches them again — it does not add, drop or ALTER
   * a constraint on a table that already exists (verified: with all of them
   * dropped, a push reports success and recreates none). So widening
   * `squad_activity_lane_check` to admit a newly added lane changed nothing on
   * any database built before that lane: every insert using the new lane failed
   * with a constraint violation until the developer happened to run
   * `bun run test:db:down`, and the symptom — a value schema.ts plainly allows
   * being rejected — points nowhere near the cause.
   *
   * Dropping and re-adding from schema.ts is simpler and more correct than
   * diffing definitions: Postgres normalizes what it stores (`IN (...)` comes
   * back as `= ANY (ARRAY[...])`), so schema.ts is the only comparable source of
   * truth, and re-applying it unconditionally cannot leave a stale definition
   * behind.
   *
   * Restricted to the tables `schema.ts` declares, which is exactly the set this
   * preload owns and can rebuild. `public` also holds tables we did not create:
   * the paradedb image installs PostGIS, whose `spatial_ref_sys` carries a CHECK
   * of its own that nothing here could ever put back. Auditing the CONSTRAINT's
   * extension membership does not catch that — the TABLE is the extension member,
   * not the constraint — so the table list, not `pg_depend`, is the safe filter.
   */
  function dropCheckConstraints(url: string): void {
    const owned = [...expectedTableColumns().keys()].map(sqlLiteral).join(', ')
    runDdlOrExit(
      url,
      [
        `DO $ficus$ DECLARE r RECORD; BEGIN ` +
          `FOR r IN (SELECT c.conname, c.conrelid::regclass AS relation FROM pg_constraint c ` +
          `JOIN pg_class t ON t.oid = c.conrelid AND t.relnamespace = 'public'::regnamespace ` +
          `WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace ` +
          `AND t.relname IN (${owned})) LOOP ` +
          `EXECUTE 'ALTER TABLE ' || r.relation || ' DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname); ` +
          `END LOOP; END $ficus$`,
      ],
      'drop stale CHECK constraints before the schema push'
    )
  }

  /**
   * Re-add what dropCheckConstraints removed, from schema.ts.
   *
   * After the push, not before it, so a CHECK introduced together with the column
   * it constrains can be applied on a warm database in the same run.
   *
   * The NOT EXISTS guard covers the table the push just CREATEd with its CHECKs
   * already inline; the `to_regclass` guard keeps a table the push failed to
   * create from turning into a raw psql error here, so verifySchemaApplied gets
   * to name the real problem instead.
   */
  function applyCheckConstraints(url: string): void {
    runDdlOrExit(
      url,
      [...expectedCheckConstraints()].map(([name, { table, expression }]) => {
        const relation = `public.${quoteIdentifier(table)}`
        return (
          `DO $ficus$ BEGIN IF to_regclass(${sqlLiteral(relation)}) IS NOT NULL AND NOT EXISTS ` +
          `(SELECT 1 FROM pg_constraint WHERE conname = ${sqlLiteral(name)} ` +
          `AND conrelid = ${sqlLiteral(relation)}::regclass) ` +
          `THEN ALTER TABLE ${relation} ADD CONSTRAINT ${quoteIdentifier(name)} CHECK (${expression}); END IF; END $ficus$`
        )
      }),
      'reapply the CHECK constraints schema.ts declares'
    )
  }

  /**
   * Fail the run unless the live database actually contains every table and
   * column `schema.ts` declares.
   *
   * This is the load-bearing guarantee, and it is deliberately positive: the bug
   * it exists to prevent is a schema push that reports success having done
   * nothing, so the push's own exit code cannot be the safety net, and neither
   * can grepping its output — that only ever covers failure modes someone already
   * knew about. Comparing what we asked for against what the database actually
   * has catches any future silent no-op by construction, because the evidence is
   * the database itself rather than something drizzle-kit chose to print.
   *
   * It must halt the process, not throw: this runs in a bun preload, where a
   * thrown error is merely reported as "Unhandled error between tests" and the
   * run CONTINUES into every test file against the broken schema.
   */
  function verifySchemaApplied(url: string): void {
    const query = `SELECT table_name || '|' || column_name FROM information_schema.columns WHERE table_schema = 'public'`
    const result = Bun.spawnSync(['psql', url, '-tAc', query], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    if (result.exitCode !== 0) {
      console.error('Could not verify the test DB schema after the push:', result.stderr.toString())
      process.exit(1)
    }

    // CHECK constraints too, because dropCheckConstraints above removes every one
    // of them first: if applyCheckConstraints (or, for a table the push created,
    // the push itself) failed, the database would be LESS correct than before, so
    // this positive check is what makes that drop safe.
    const constraintQuery = `SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND conrelid <> 0`
    const constraints = Bun.spawnSync(['psql', url, '-tAc', constraintQuery], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    })
    if (constraints.exitCode !== 0) {
      console.error('Could not verify the test DB CHECK constraints after the push:', constraints.stderr.toString())
      process.exit(1)
    }
    const liveConstraints = new Set(
      constraints.stdout
        .toString()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
    const missingConstraints = [...expectedCheckConstraints().keys()]
      .filter((name) => !liveConstraints.has(name))
      .sort()

    const fkQuery = `SELECT t.relname || '|' || c.conname || '|' || c.confdeltype::text || '|' || c.confupdtype::text FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`
    const fkResult = Bun.spawnSync(['psql', url, '-tAc', fkQuery], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    if (fkResult.exitCode !== 0 || fkResult.signalCode) {
      console.error('Could not verify test foreign keys:', fkResult.stderr.toString())
      process.exit(1)
    }
    const liveForeignKeys = new Set(
      fkResult.stdout
        .toString()
        .split('\n')
        .map((line) => line.trim())
    )
    const missingForeignKeys = [...expectedForeignKeys()]
      .filter(([key, value]) => !liveForeignKeys.has(`${key}|${value.deleteAction}|${value.updateAction}`))
      .map(([key]) => key)
      .sort()

    const drift = findSchemaDrift(expectedTableColumns(), parseColumnRows(result.stdout.toString()))
    if (
      drift.missingTables.length === 0 &&
      drift.missingColumns.length === 0 &&
      missingConstraints.length === 0 &&
      missingForeignKeys.length === 0
    )
      return

    const detail = [
      drift.missingTables.length > 0 ? `missing tables: ${drift.missingTables.join(', ')}` : '',
      drift.missingColumns.length > 0 ? `missing columns: ${drift.missingColumns.join(', ')}` : '',
      missingConstraints.length > 0 ? `missing CHECK constraints: ${missingConstraints.join(', ')}` : '',
      missingForeignKeys.length > 0 ? `missing or stale FOREIGN KEY constraints: ${missingForeignKeys.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n  ')
    // A missing table or column means the push silently did nothing; a missing
    // CHECK means the drop/reapply pair around it did not finish. Naming only the
    // cause that actually applies keeps the hint from pointing at the wrong step.
    const cause =
      drift.missingTables.length > 0 || drift.missingColumns.length > 0
        ? 'The push applied nothing (drizzle-kit exits 0 on failures it prints but does not raise).\n'
        : 'The push succeeded; declared constraints were not all synchronized.\n'
    console.error(
      `The schema push reported success but the test DB does not match src/db/schema.ts:\n  ${detail}\n` +
        cause +
        'Recover with: bun run test:db:down && bun run test'
    )
    process.exit(1)
  }

  // cwd for canExecuteQuery's spawned verification script — must resolve the
  // `postgres` package via node_modules; apps/core's own root works.
  const appCwd = join(__dirname, '..')

  const POSTGRES_READY_TIMEOUT_MS = 5000

  function composeReady(port: number): boolean {
    return isComposePostgresReady(port, { projectName, composeFile, cwd: appCwd, timeoutMs: POSTGRES_READY_TIMEOUT_MS })
  }

  function resolveTestPort(): number {
    // Try reusing port from a previous run, but only if it belongs to this
    // worktree's compose project. A different worktree can have its own test DB
    // bound to the cached port; using it would leak rows across isolated tests.
    if (existsSync(portFile)) {
      const cached = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
      // NEVER use production postgres port for tests
      if (cached === 5432) {
        console.warn('Cached test port is 5432 (production) - allocating new port')
      } else if (cached && !isNaN(cached) && composeReady(cached)) {
        return cached
      }
      // Cached port failed readiness (down, stale, owned by another worktree, or overloaded)
      // - tear down before allocating new.
      tearDownTestDb()
    }
    // Allocate a new free port
    return findFreeTestDbPort()
  }

  function isPostgresReady(port: number): boolean {
    // A healthy service on localhost alone is not proof that we own it.
    return composeReady(port)
  }

  // --- Main setup ---

  let TEST_DATABASE_URL: string
  // Set only when a local direct run continues without a database.
  let testDbUnavailableReason: string | undefined
  const allowTestDbFallback = testDbFallbackAllowed()

  if (useExternalDb) {
    // Use CI-provided database (already validated above)
    TEST_DATABASE_URL = ciDatabaseUrl!
    process.env.DATABASE_URL = TEST_DATABASE_URL
    console.log('Using external database from CI')
  } else if (!Bun.which('docker') && allowTestDbFallback) {
    // No Docker executable means this run cannot have created any containers.
    // Preserve the database-free diagnostic path without claiming a DB lifetime.
    TEST_DATABASE_URL = ''
    testDbUnavailableReason = 'Docker executable not found'
  } else {
    // Acquire ownership before the first readiness probe or partial Compose up.
    // EXIT handles schema/setup failures too; independent live runs fail closed.
    try {
      sweepStaleTestDbs(repoRoot)
      ownTestDb(repoRoot)
    } catch (error) {
      console.error(`Cannot acquire test database ownership: ${String(error)}`)
      process.exit(1)
    }

    // Setup is also serialized for preloads borrowing a runner's lifetime token.
    TEST_DATABASE_URL = withTestDbLockSync(repoRoot, () => {
      const port = resolveTestPort()
      const url = `postgres://postgres:postgres@localhost:${port}/ficus_test`
      process.env.DATABASE_URL = url

      const startup = startTestDb({
        isReady: () => isPostgresReady(port),
        // Start a new container on the allocated port
        composeUp: () => {
          const up = Bun.spawnSync(
            ['docker', 'compose', '-p', projectName, '-f', composeFile, 'up', '-d', 'postgres'],
            {
              stdout: 'ignore',
              stderr: 'pipe',
              env: { ...process.env, TEST_DB_PORT: String(port), TEST_REPO_ROOT: repoRoot },
              timeout: 30000,
              killSignal: 'SIGKILL',
            }
          )
          return { exitCode: up.exitCode, stderr: up.stderr.toString() }
        },
        sleep: (ms) => Bun.sleepSync(ms),
        allowFallback: allowTestDbFallback,
      })
      if (!startup.ready) {
        if (!allowTestDbFallback) {
          // This process.exit() skips withTestDbLockSync's `finally` above,
          // so the lockfile is NOT released here via normal cleanup — it is
          // deliberately left held. The next process to contend for the lock
          // recovers via isAbandoned()'s stale-PID check (testDbLock.ts),
          // which sees this PID is gone and reclaims the lockfile itself.
          // Do not "fix" this by wrapping the wait loop in try/finally: a
          // `finally` never runs across process.exit() either, so it
          // wouldn't help — the stale-PID path is the actual safety net.
          console.error(`${TEST_DB_NOT_READY}: ${startup.reason}`)
          process.exit(1)
        }
        // Local direct `bun test` only (see test-utils/test-db-fallback.ts):
        // let database-free files run; DATABASE_URL is replaced below by a
        // stand-in that fails every database use. No port file is written, and
        // the schema setup below is skipped because there is nothing to push to.
        testDbUnavailableReason = startup.reason
        delete process.env.DATABASE_URL
        return ''
      }

      // A preload borrowing the runner's live container can still see rows
      // from a previous isolated batch in ficus_test —
      // unlike the old unconditional-teardown behavior, which always started
      // every run from a genuinely empty container. Leftover rows are not just
      // a cross-run isolation smell: `drizzle-kit push` below inspects row
      // counts, and when it finds a table with existing data that a schema
      // change *might* conflict with, it opens an interactive "truncate this
      // table? y/n" prompt — even with `--force` — and Bun.spawnSync's piped
      // stdin never satisfies it, so the push hangs for the full timeout and
      // the whole suite fails. Truncating every table up front (cheap, schema
      // and extensions untouched) restores the "tests always start from an
      // empty DB" contract the rest of the suite already assumes, without
      // paying for a full container teardown/recreate.
      resetTestData(url)

      // Persist port for reuse and for test:db:down
      writeFileSync(portFile, String(port))
      console.log(`Test postgres ready on port ${port} (project: ${projectName})`)

      // The transaction-mode PgBouncer in front of that database (the pooled
      // path a host with database.pool.enabled takes). Best-effort: when it
      // cannot start, the pooled-path tests skip with a notice rather than the
      // whole suite failing on an optional service.
      const pooled = startTestPooler({ projectName, composeFile, repoRoot, port })
      if (pooled) {
        process.env.TEST_POOLED_DATABASE_URL = pooled
        console.log(`Test pgbouncer ready (${pooled.replace(/:[^:@/]+@/, ':***@')})`)
      }
      return url
    })
  }

  /**
   * `docker compose up -d pgbouncer` for the current test project and the
   * pooled DSN on its Docker-assigned host port, or undefined when the service
   * could not be started or its port read. Never throws.
   */
  function startTestPooler(opts: {
    projectName: string
    composeFile: string
    repoRoot: string
    port: number
  }): string | undefined {
    try {
      // A STABLE host port, cached per worktree like .test-db-port: a
      // Docker-assigned (`0:`) port changes on every `docker compose start`,
      // which is exactly what connection-pooler.test.ts does to the service.
      const poolerPortFile = join(opts.repoRoot, '.test-pgbouncer-port')
      let poolerPort = existsSync(poolerPortFile) ? parseInt(readFileSync(poolerPortFile, 'utf-8').trim(), 10) : NaN
      if (!Number.isInteger(poolerPort) || poolerPort <= 0) poolerPort = findFreeTestDbPort()
      const env = {
        ...process.env,
        TEST_DB_PORT: String(opts.port),
        TEST_PGBOUNCER_PORT: String(poolerPort),
        TEST_REPO_ROOT: opts.repoRoot,
      }
      const up = Bun.spawnSync(
        ['docker', 'compose', '-p', opts.projectName, '-f', opts.composeFile, 'up', '-d', 'pgbouncer'],
        { stdout: 'ignore', stderr: 'pipe', env, timeout: 30000, killSignal: 'SIGKILL' }
      )
      if (up.exitCode !== 0) {
        console.log(
          `[core] pgbouncer test service did not start (pooled-path tests will skip): ${up.stderr.toString().trim().split('\n').pop()}`
        )
        return undefined
      }
      writeFileSync(poolerPortFile, String(poolerPort))
      return `postgres://postgres:postgres@localhost:${poolerPort}/ficus_test`
    } catch {
      return undefined
    }
  }

  if (testDbUnavailableReason !== undefined) {
    const reason = testDbUnavailableReason
    try {
      TEST_DATABASE_URL = (await startUnavailableTestDb(unavailableTestDbMessage(reason))).url
    } catch (error) {
      console.error(`Core test database unavailable (${reason}) and its stand-in failed:`, error)
      process.exit(1)
    }
    process.env.DATABASE_URL = TEST_DATABASE_URL
    console.warn(unavailableTestDbBanner(reason))
  } else {
    // Must happen before the push, in BOTH the local-container and the CI path: on
    // CI the index does not exist yet so this is a no-op, but locally the previous
    // run left it behind and the push would otherwise silently do nothing.
    const schemaCache = runnerTestSchemaCache(TEST_DATABASE_URL)
    if (schemaCache?.matches()) {
      verifySchemaApplied(TEST_DATABASE_URL)
      console.log('Reused verified test schema (identical source and live DDL)')
    } else {
      dropIntrospectionHostileIndexes(TEST_DATABASE_URL)
      dropCheckConstraints(TEST_DATABASE_URL)

      // Push schema to test DB before any tests run (timeout prevents hang on stale DB)
      let result: { exitCode: number; stderr: Buffer; stdout: Buffer }
      try {
        const pushArgs =
          process.env.FICUS_TEST_SCHEMA_PUSH_NO_FORCE === '1'
            ? ['bunx', 'drizzle-kit', 'push']
            : ['bunx', 'drizzle-kit', 'push', '--force']
        result = Bun.spawnSync(pushArgs, {
          env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
          cwd: join(__dirname, '..'),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60000,
        })
      } catch {
        console.error('Schema push timed out or failed. Try: bun run test:db:down && bun test')
        process.exit(1)
      }

      {
        const stderr = result.stderr.toString()
        const stdout = result.stdout.toString()

        if (result.exitCode !== 0) {
          if (!stderr.includes('No changes detected') && !stdout.includes('No changes detected')) {
            console.error('Failed to push schema to test DB:', stderr || stdout || '(no output)')
            process.exit(1)
          }
        }

        // Belt and braces to verifySchemaApplied below. drizzle-kit's schema pull is
        // all-or-nothing, so a zod failure parsing it means nothing was applied even
        // though the process exited 0. The column check would only notice once the
        // schema had actually diverged; catching the signature names the real cause
        // on the run that introduces it, rather than several schema changes later.
        //
        // Deliberately narrow — do NOT widen this to "any error in the output".
        // `push` already prints a harmless `PostgresError: cannot drop view
        // pg_stat_statements_info ...` on every single run (the paradedb image ships
        // that extension in `public`, push wants to drop views that are not in
        // schema.ts, and cannot), then exits 0. Treating that as fatal would break
        // every developer's test run — which is precisely why the POSITIVE check
        // below, and not output matching, is the load-bearing one.
        if (stderr.includes('ZodError') || stdout.includes('ZodError')) {
          console.error(
            'drizzle-kit push could not parse the existing test DB schema (ZodError) and exited 0 having applied nothing.\n' +
              'Something in the database is not introspectable by drizzle-kit — if it is an index, add it to\n' +
              'INTROSPECTION_HOSTILE_INDEXES in apps/core/src/test-db-setup.ts.\n' +
              'Recover with: bun run test:db:down && bun run test\n' +
              (stderr || stdout)
          )
          process.exit(1)
        }
      }

      // Push never maintains CHECK constraints on a table it did not just create,
      // so the set dropped above has to be put back from schema.ts by hand.
      applyCheckConstraints(TEST_DATABASE_URL)

      // Preserve the generated integration-output constraints even when push stops
      // after table creation. Derive this fixture DDL from the actual schema.
      {
        const { getTableConfig } = await import('drizzle-orm/pg-core')
        const {
          integrationOutputEvents,
          integrationOutputDeliveries,
          integrationOutputTriggerRuns,
          channelDirectChats,
          channelDirectAgents,
          machineBoxes,
          remoteHostGrants,
        } = await import('./db/schema')
        const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
        const statements: string[] = []
        for (const table of [
          integrationOutputEvents,
          integrationOutputDeliveries,
          integrationOutputTriggerRuns,
          channelDirectChats,
          channelDirectAgents,
          machineBoxes,
          remoteHostGrants,
        ]) {
          const config = getTableConfig(table)
          const add = (name: string, clause: string) => {
            const literal = name.slice(0, 63).replaceAll("'", "''")
            statements.push(
              `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${literal}' AND conrelid = '${config.name}'::regclass) THEN ALTER TABLE ${quote(config.name)} ADD CONSTRAINT ${quote(name)} ${clause}; END IF; END $$`
            )
          }
          for (const constraint of config.uniqueConstraints)
            add(constraint.getName()!, `UNIQUE (${constraint.columns.map((column) => quote(column.name)).join(', ')})`)
        }
        const result = Bun.spawnSync(
          ['psql', TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c', statements.join('; ')],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 10000,
          }
        )
        if (result.exitCode !== 0)
          throw new Error(`Failed to enforce output schema constraints: ${result.stderr.toString()}`)
      }

      // A reused Docker database must enforce the same FKs as a fresh native DB.
      // Repair all declared keys atomically instead of maintaining a partial list.
      const foreignKeys = Bun.spawnSync(['psql', TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1'], {
        stdin: Buffer.from('BEGIN;\n' + foreignKeyStatements().join(';\n') + ';\nCOMMIT;'),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10000,
      })
      if (foreignKeys.exitCode !== 0 || foreignKeys.signalCode) {
        console.error('Failed to synchronize test foreign keys:', foreignKeys.stderr.toString())
        process.exit(1)
      }

      // drizzle-kit push doesn't reliably create partial unique indexes.
      // Apply them manually so RBAC uniqueness constraints work in tests.
      {
        const idxStatements = [
          // Restore expression indexes removed for push introspection, including
          // the uniqueness fences used by recovery and worktree ownership.
          `CREATE INDEX IF NOT EXISTS "idx_messages_agent_stream_group"
        ON "messages" ("agent_id", ("metadata"->>'streamGroupId'))
        WHERE "role" = 'assistant' AND ("metadata"->>'streamGroupId') IS NOT NULL`,
          `CREATE INDEX IF NOT EXISTS "idx_messages_agent_inbox_consumed"
        ON "messages" ("agent_id", ("metadata"->>'consumedAt'))
        WHERE "metadata"->>'source' = 'inbox' AND ("metadata"->>'consumedAt') IS NOT NULL`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_agent_sandbox_recovery_unique"
        ON "messages" ("agent_id", ("metadata"->>'sandboxId'), ("metadata"->>'recoveryEpisodeId'), ("metadata"->>'recoveryNotificationKind'))
        WHERE "role" = 'human' AND "metadata"->>'source' = 'sandbox-recovery'`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_owned_worktree_path"
        ON "work_stream_worktrees" ("squad_id", ("ownership"->>'worktree'))`,
          // Personal ownership proof: one active Ficus user per stable GitHub account.
          `CREATE UNIQUE INDEX IF NOT EXISTS "github_personal_identity_active_account"
        ON "github_personal_identities" ("host", "account_id")
        WHERE "unlinked_at" IS NULL`,
          // role_assignments: unique assignment when squadId IS NULL
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_role_assignment_no_squad"
        ON "role_assignments" ("subject_type", "subject_id", "role_id", "scope")
        WHERE ("squad_id" IS NULL)`,
          // role_assignments: unique assignment when squadId IS NOT NULL
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_role_assignment_with_squad"
        ON "role_assignments" ("subject_type", "subject_id", "role_id", "scope", "squad_id")
        WHERE ("squad_id" IS NOT NULL)`,
          // execution admission: one nonterminal reservation owns an agent
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_execution_admission_reservations_agent_current"
        ON "execution_admission_reservations" ("agent_id")
        WHERE "agent_id" IS NOT NULL AND "state" NOT IN ('released', 'revoked')`,
          // integrations: at most one enabled provider connection per squad
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_integration_connections_enabled_provider"
        ON "integration_connections" ("squad_id", "provider_key")
        WHERE "enabled" = true`,
          // web push: one subscription row per endpoint (ON CONFLICT arbiter for
          // registerPushSubscription's ownership-transfer upsert, #1111)
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_push_subscriptions_endpoint_unique"
        ON "push_subscriptions" ("endpoint")`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_desktop_notifications_event"
        ON "desktop_notifications" ("user_id", "event_key")`,
          // local deployments: one live deployment per port PER NETWORK SCOPE. On the
          // VM runtime every box on a machine shares one loopback, so a duplicate
          // would let a tokenized app URL reach a different squad's app (#1306).
          `CREATE UNIQUE INDEX IF NOT EXISTS "local_deployments_live_port_scope_uniq"
        ON "local_deployments" ("port_scope", "port")
        WHERE "archived_at" IS NULL`,
          // local deployments: one app per hostname alias per instance.
          `CREATE UNIQUE INDEX IF NOT EXISTS "local_deployments_alias_uniq"
        ON "local_deployments" ("alias")`,
          // squad slots: preserve the three live-state uniqueness fences that
          // drizzle-kit push may omit for partial indexes.
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_slot_pools_active_key_unique"
        ON "slot_pools" ("squad_id", "key")
        WHERE "unregistered_at" IS NULL`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_slot_claims_active_owner_unique"
        ON "slot_claims" ("pool_id", "owner_agent_id")
        WHERE "status" = 'active'`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_slot_waiters_queued_owner_unique"
        ON "slot_waiters" ("pool_id", "owner_agent_id")
        WHERE "status" = 'queued'`,
          // managed BigBrain vaults: idempotent create arbiter, one vault per connection, and
          // unique live display names (deleted tombstones free the name).
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_managed_bigbrain_vaults_create_request"
        ON "managed_bigbrain_vaults" ("create_request_id")`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_managed_bigbrain_vaults_connection"
        ON "managed_bigbrain_vaults" ("connection_id")
        WHERE "connection_id" IS NOT NULL`,
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_managed_bigbrain_vaults_live_display_name"
        ON "managed_bigbrain_vaults" ("display_name")
        WHERE "state" <> 'deleted'`,
        ]

        const idxScript = idxStatements.join('; ')
        const idxResult = Bun.spawnSync(['psql', TEST_DATABASE_URL, '-c', idxScript], {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10000,
        })
        if (idxResult.exitCode !== 0) {
          throw new Error(`Failed to apply test partial unique indexes: ${idxResult.stderr.toString()}`)
        }
      }
      verifySchemaApplied(TEST_DATABASE_URL)
      schemaCache?.record()
    }
  }
}

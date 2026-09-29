import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPostgresConnection, getConnectionString } from './connection'
import { migrationListFingerprint, readMigrationJournal } from './migration-journal'

// apps/core root, two levels up from src/db.
const CORE_DIR = join(import.meta.dir, '..', '..')
const packageJson = JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const buildScript = packageJson.scripts.build

// This suite runs a real `bun build` and spawns the resulting bundle as a
// real subprocess — too jitter-prone for the shared CI runner. It runs only
// in the dedicated `subprocess-tests` CI job (see ci.yml); the main sweep
// sets FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('migrate bundle build contract', () => {
  // Cheap pin: the build script must still produce dist/migrate.js from the
  // guarded migration entrypoint. If either token is edited away, the
  // behavioral test below can no longer find a migrate build step to run.
  test('the build script bundles run-migrations.ts to dist/migrate.js', () => {
    expect(buildScript).toContain('--outfile dist/migrate.js')
    expect(buildScript).toContain('src/db/run-migrations.ts')
  })

  // Behavioral half: actually build the migrate bundle (to a scratch outfile,
  // not dist/) and run it with no DATABASE_URL and no FICUS_MIGRATE_LIVE in the
  // child environment. run-migrations-guard.ts must refuse before the
  // top-level await ever imports execute-migrations (the only module that
  // touches the database) — so this proves the refusal happens with zero DB
  // access, not merely that the process eventually errors.
  test('the bundled migrate entrypoint refuses to run without FICUS_MIGRATE_LIVE, before any DB access', async () => {
    const migrateBuildCommand = buildScript
      .split('&&')
      .map((part) => part.trim())
      .find((part) => part.includes('dist/migrate.js'))
    if (!migrateBuildCommand) {
      throw new Error('no `bun build` step targeting dist/migrate.js found in package.json scripts.build')
    }

    const outDir = mkdtempSync(join(tmpdir(), 'migrate-bundle-'))
    try {
      const outfile = join(outDir, 'migrate.js')
      const buildArgs = migrateBuildCommand.split(/\s+/).map((token) => (token === 'dist/migrate.js' ? outfile : token))

      const build = Bun.spawn(buildArgs, { cwd: CORE_DIR, stdout: 'pipe', stderr: 'pipe' })
      const buildExitCode = await build.exited
      const buildStderr = await new Response(build.stderr).text()
      expect(buildExitCode, `bun build failed:\n${buildStderr}`).toBe(0)
      expect(statSync(outfile).size).toBeGreaterThan(0)
      // The migration list is frozen into the bundle rather than read at runtime;
      // otherwise a stale bundle cannot detect newer migrations, and the offline
      // updater cannot tell that a bundle needs rebuilding.
      expect(readFileSync(outfile, 'utf8')).toContain(
        migrationListFingerprint(readMigrationJournal(join(CORE_DIR, 'drizzle')))
      )

      // Strip DATABASE_URL and FICUS_MIGRATE_LIVE from the child env, and run
      // from a cwd with no .env of its own, so the guard's refusal can only
      // come from the absence of an explicit override — not from picking up
      // ambient config.
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue
        if (key === 'DATABASE_URL' || key === 'FICUS_MIGRATE_LIVE') continue
        env[key] = value
      }
      env.NODE_ENV = 'production'

      const run = Bun.spawn(['bun', outfile], { cwd: outDir, env, stdout: 'pipe', stderr: 'pipe' })
      const runExitCode = await run.exited
      const runStdout = await new Response(run.stdout).text()
      const runStderr = await new Response(run.stderr).text()
      const runOutput = runStdout + runStderr

      expect(runExitCode, `expected a non-zero exit; combined output:\n${runOutput}`).not.toBe(0)
      expect(runOutput).toContain('no explicit DATABASE_URL override was supplied')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 60_000)

  // The incident's shape: a bundle built from one migration list started against
  // a checkout whose apps/core/drizzle has moved on. It must refuse before it
  // connects, so the database keeps no trace of the attempt, while the same
  // bundle migrates normally against its own list.
  test('the built migrate bundle refuses a newer migrations folder and leaves the database untouched', async () => {
    const migrateBuildCommand = buildScript
      .split('&&')
      .map((part) => part.trim())
      .find((part) => part.includes('dist/migrate.js'))!
    const outDir = mkdtempSync(join(tmpdir(), 'migrate-bundle-guard-'))
    const databaseName = `migrate_bundle_guard_${crypto.randomUUID().replaceAll('-', '')}`
    const adminUrl = new URL(getConnectionString())
    adminUrl.pathname = '/postgres'
    const databaseUrl = new URL(adminUrl)
    databaseUrl.pathname = `/${databaseName}`
    const admin = createPostgresConnection(adminUrl.toString(), { max: 1, onnotice: () => {} })
    const database = createPostgresConnection(databaseUrl.toString(), { max: 1, onnotice: () => {} })
    try {
      const outfile = join(outDir, 'migrate.js')
      const buildArgs = migrateBuildCommand.split(/\s+/).map((token) => (token === 'dist/migrate.js' ? outfile : token))
      const build = Bun.spawn(buildArgs, { cwd: CORE_DIR, stdout: 'pipe', stderr: 'pipe' })
      expect(await build.exited, await new Response(build.stderr).text()).toBe(0)

      const root = (name: string) => {
        const path = join(outDir, name)
        mkdirSync(join(path, 'apps/core'), { recursive: true })
        cpSync(join(CORE_DIR, 'drizzle'), join(path, 'apps/core/drizzle'), { recursive: true })
        return path
      }
      const matching = root('matching')
      const newer = root('newer')
      const journalPath = join(newer, 'apps/core/drizzle/meta/_journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number; when: number; tag: string }[]
      }
      const last = journal.entries.at(-1)!
      const future = { ...last, idx: last.idx + 1, when: last.when + 1, tag: `${last.idx + 1}_future_backfill` }
      writeFileSync(
        join(newer, `apps/core/drizzle/${future.tag}.sql`),
        'CREATE TABLE "guard_should_not_exist" (id int)'
      )
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: [...journal.entries, future] }))

      await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
      const runBundle = async (ficusRoot: string) => {
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (value === undefined || /^(DATABASE_URL|FICUS_MIGRATE_LIVE|FICUS_ROOT|FICUS_TEST_MODE)$/.test(key))
            continue
          env[key] = value
        }
        Object.assign(env, { DATABASE_URL: databaseUrl.toString(), FICUS_ROOT: ficusRoot, NODE_ENV: 'production' })
        const run = Bun.spawn(['bun', outfile], { cwd: ficusRoot, env, stdout: 'pipe', stderr: 'pipe' })
        const [exitCode, stdout, stderr] = await Promise.all([
          run.exited,
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
        ])
        return { exitCode, output: stdout + stderr }
      }

      const refused = await runBundle(newer)
      expect(refused.exitCode, refused.output).not.toBe(0)
      // Bun.main is the realpath (/private/var on macOS), so match the bundle by name.
      expect(refused.output).toMatch(
        new RegExp(
          `\\[FICUS_MIGRATION_BUILD_MISMATCH\\] Refusing to migrate: this Core build \\(\\S+/migrate\\.js\\) ` +
            `has ${journal.entries.length} migrations`
        )
      )
      expect(refused.output).toContain('so the build predates the folder.')
      expect(refused.output).not.toContain(databaseName)
      const [untouched] = await database<{ ledger: string | null; guard: string | null }[]>`
        SELECT to_regnamespace('drizzle')::text AS ledger, to_regclass('guard_should_not_exist')::text AS guard`
      expect(untouched).toEqual({ ledger: null, guard: null })

      const migrated = await runBundle(matching)
      expect(migrated.exitCode, migrated.output).toBe(0)
      const [ledger] = await database<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      expect(ledger!.count).toBe(journal.entries.length)
    } finally {
      await database.end()
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 180_000)
})

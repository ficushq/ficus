import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
})

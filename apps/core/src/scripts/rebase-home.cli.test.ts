import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type postgres from 'postgres'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import { HOME_PATH_COLUMNS, homePathColumnKey } from '../db/home-path-columns'

// apps/core root, two levels up from src/scripts.
const CORE_DIR = join(import.meta.dir, '..', '..')
const REPO_ROOT = join(CORE_DIR, '..', '..')
const buildScript = (JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')) as { scripts: { build: string } })
  .scripts.build
const rebaseBuild = buildScript
  .split('&&')
  .map((part) => part.trim())
  .find((part) => part.includes('--outfile dist/rebase-home.js'))

describe('rebase-home bundle contract', () => {
  test('the build bundles the entry to dist/rebase-home.js and the artifact ships it', () => {
    expect(rebaseBuild).toBeDefined()
    expect(rebaseBuild).toContain('src/scripts/rebase-home.ts')
    expect(rebaseBuild).toContain('--target bun')
    expect(readFileSync(join(REPO_ROOT, 'scripts/artifact/build-core-artifact.sh'), 'utf8')).toContain(
      'apps/core/dist/rebase-home.js'
    )
    expect(readFileSync(join(REPO_ROOT, 'scripts/artifact/lib/assemble-core-artifact.ts'), 'utf8')).toContain(
      "{ path: 'apps/core/dist/rebase-home.js', kind: 'file' }"
    )
    // The host layout migration runs exactly this path from the target release.
    expect(readFileSync(join(REPO_ROOT, 'scripts/setup/lib.sh'), 'utf8')).toContain(
      'exec bun dist/rebase-home.js --from "$3" --to "$4"'
    )
  })
})

// A real `bun build` and the bundle spawned as a subprocess: only in the dedicated `subprocess-tests`
// CI job (see ci.yml); the main sweep sets FICUS_TEST_SKIP_SUBPROCESS=1.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('dist/rebase-home.js', () => {
  const ROOT = `/srv/p5t9-cli-${crypto.randomUUID().slice(0, 8)}`
  const OLD = `${ROOT}/.old`
  const NEW = `${ROOT}/.new`
  let outDir: string
  let bundle: string
  let sql: postgres.Sql
  let messageId: string
  let squadId: string

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'rebase-home-bundle-'))
    bundle = join(outDir, 'rebase-home.js')
    const args = rebaseBuild!.split(/\s+/).map((token) => (token === 'dist/rebase-home.js' ? bundle : token))
    const build = Bun.spawn(args, { cwd: CORE_DIR, stdout: 'pipe', stderr: 'pipe' })
    const code = await build.exited
    expect(code, await new Response(build.stderr).text()).toBe(0)

    sql = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
    const [squad] =
      await sql`INSERT INTO squads (name, purpose) VALUES (${`rebase-home-cli-${ROOT}`}, 'fixture') RETURNING id`
    squadId = squad!.id
    const [inbox] = await sql`
      INSERT INTO inbox (recipient_type, recipient_id, sender_type, content)
      VALUES ('user', 'rebase-home-cli', 'system', ${ROOT}) RETURNING id`
    messageId = inbox!.id
    await sql`
      INSERT INTO inbox_attachments (message_id, filename, content_type, byte_size, sha256, storage_path)
      VALUES (${messageId}, 'a.txt', 'text/plain', 1, ${'0'.repeat(64)}, ${`${OLD}/inbox-attachments/m1/a1`})`
  }, 120_000)

  afterAll(async () => {
    await sql`DELETE FROM inbox WHERE id = ${messageId}`
    await sql`DELETE FROM squads WHERE id = ${squadId}`
    await sql.end()
    rmSync(outDir, { recursive: true, force: true })
  })

  /** Runs the bundle from an empty cwd, with a scratch HOME and only the given database settings. */
  async function run(argv: string[], databaseUrl?: string) {
    const home = mkdtempSync(join(tmpdir(), 'rebase-home-run-'))
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, FICUS_TEST_MODE: '1' }
    if (databaseUrl) env.DATABASE_URL = databaseUrl
    try {
      const child = Bun.spawn(['bun', bundle, ...argv], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' })
      const exitCode = await child.exited
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      // It never creates a Ficus home (or anything else) under HOME.
      return { exitCode, stdout, stderr, homeEntries: readdirSync(home) }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test('exits 2 when DATABASE_URL is not set', async () => {
    const result = await run(['--from', OLD, '--to', NEW])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('DATABASE_URL is not set')
    expect(result.stdout).toBe('')
  })

  test('exits 2 with the usage on a bad command line, before reading DATABASE_URL', async () => {
    for (const argv of [[], ['--from', OLD], ['--from', `${OLD}/`, '--to', NEW], ['--from', OLD, '--to', NEW, '-x']]) {
      const result = await run(argv, getConnectionString())
      expect(result.exitCode, argv.join(' ')).toBe(2)
      expect(result.stderr).toContain('usage: bun dist/rebase-home.js --from')
      expect(result.stdout).toBe('')
    }
  })

  test('prints a count for every column, rebases, and exits 0 on a second run that finds nothing', async () => {
    const keys = HOME_PATH_COLUMNS.map(homePathColumnKey)
    const line = (key: string, n: number) => `REBASE_HOME ${key}=${n}`

    const dry = await run(['--from', OLD, '--to', NEW, '--dry-run'], getConnectionString())
    expect(dry.exitCode, dry.stderr).toBe(0)
    expect(dry.stdout.trim().split('\n')).toEqual(
      keys.map((key) => line(key, key === 'inbox_attachments.storage_path' ? 1 : 0))
    )
    expect(dry.stderr).toContain('nothing was written')
    const [unchanged] = await sql`SELECT storage_path FROM inbox_attachments WHERE message_id = ${messageId}`
    expect(unchanged!.storage_path).toBe(`${OLD}/inbox-attachments/m1/a1`)

    const first = await run(['--from', OLD, '--to', NEW], getConnectionString())
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stdout.trim().split('\n')).toEqual(
      keys.map((key) => line(key, key === 'inbox_attachments.storage_path' ? 1 : 0))
    )
    expect(first.homeEntries).toEqual([])
    const [moved] = await sql`SELECT storage_path FROM inbox_attachments WHERE message_id = ${messageId}`
    expect(moved!.storage_path).toBe(`${NEW}/inbox-attachments/m1/a1`)

    const second = await run([`--from=${OLD}`, `--to=${NEW}`], getConnectionString())
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.stdout.trim().split('\n')).toEqual(keys.map((key) => line(key, 0)))
    expect(existsSync(bundle)).toBe(true)
  })
})

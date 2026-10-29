import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

// Exercise the shipped bunfig/preloads, not a replacement preload. All external
// DB/capacity commands are refusing spies, including during the red phase.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-test-db-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'commands')
  for (const command of ['docker', 'psql', 'pg_isready', 'bunx', 'ficus']) {
    writeFileSync(join(bin, command), `#!/bin/sh\necho ${command} >> "$LAZY_DB_LOG"\nexit 7\n`, { mode: 0o755 })
  }
  const run = (args: string[], cwd = root, overrides = {}) => {
    const result = Bun.spawnSync([process.execPath, ...args], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAZY_DB_LOG: log,
        FICUS_SANDBOX_ID: 'squad_fixture',
        FICUS_SQUAD_ID: 'fixture',
        FICUS_TOKEN: 'fixture-only-token',
        FICUS_API_URL: 'http://capacity.invalid',
        DATABASE_URL: '',
        FICUS_TEST_DB_OWNER: '',
        XDG_CACHE_HOME: join(dir, 'cache'),
        CI: 'true',
        ...overrides,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    })
    return {
      code: result.exitCode,
      signal: result.signalCode,
      output: result.stdout.toString() + result.stderr.toString(),
      commands: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }
  }
  return { dir, run, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

for (const path of [
  'apps/cli/src/dormant-agent.test.ts',
  'apps/web/src/lib/agentDisplay.test.ts',
  'apps/core/src/lib/utils/agent-names.test.ts',
]) {
  test(`root preload: ${path} needs neither DB nor capacity`, () => {
    const f = fixture()
    try {
      const result = f.run(['test', path])
      expect(result.commands).toBe('')
      expect(result.signal).toBeUndefined()
      expect(result.code).toBe(0)
      expect(result.output).toMatch(/\b0 fail\b/)
      expect(result.output).toMatch(/Ran \d+ tests? across 1 file/)
    } finally {
      f.clean()
    }
  }, 40000)
}

test('focused Core package runner also leaves DB-free tests alone', () => {
  const f = fixture()
  try {
    const result = f.run(['run', 'scripts/run-core-tests.ts', 'apps/core/src/lib/utils/agent-names.test.ts'])
    expect(result.commands).toBe('')
    expect(result.code).toBe(0)
    expect(result.output).toContain('Test suite passed')
  } finally {
    f.clean()
  }
}, 40000)

test('readiness is single-flight, resolves only after setup, and latches failure', async () => {
  const { lazyTestDatabase } = await import('../apps/core/src/test-utils/lazy-test-database')
  let starts = 0
  let ready = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ensure = lazyTestDatabase(async () => {
    starts++
    await gate
    ready = true
  })
  const first = ensure()
  const second = ensure()
  expect(second).toBe(first)
  expect(ready).toBe(false)
  release()
  await Promise.all([first, second])
  await ensure()
  expect(ready).toBe(true)
  expect(starts).toBe(1)

  let failures = 0
  const failure = new Error('schema failed')
  const broken = lazyTestDatabase(async () => {
    failures++
    throw failure
  })
  await expect(broken()).rejects.toBe(failure)
  await expect(broken()).rejects.toBe(failure)
  expect(failures).toBe(1)
})

for (const path of ['apps/core/src/db/integrations-migration.test.ts', 'apps/core/src/db/pooled-queries.test.ts']) {
  test(`raw-client readiness cannot bypass capacity: ${path}`, () => {
    const f = fixture()
    try {
      const result = f.run(['test', path])
      expect(result.commands).toBe('ficus\n')
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('[test-db capacity: unavailable]')
      expect(result.output).not.toContain('Skipping')
    } finally {
      f.clean()
    }
  }, 40000)
}

async function externalFixture(f: ReturnType<typeof fixture>, slowPush = false): Promise<string> {
  const { expectedTableColumns, expectedCheckConstraints } = await import('../apps/core/src/db/expected-schema')
  const { expectedForeignKeys } = await import('../apps/core/src/db/expected-foreign-keys')
  const rows = [
    ...[...expectedTableColumns()].flatMap(([table, columns]) => [...columns].map((column) => `${table}|${column}`)),
    ...expectedCheckConstraints().keys(),
    ...[...expectedForeignKeys()].map(([key, value]) => `${key}|${value.deleteAction}|${value.updateAction}`),
  ].join('\n')
  writeFileSync(join(f.dir, 'schema'), rows)
  writeFileSync(
    join(f.dir, 'bin', 'ficus'),
    '#!/bin/sh\necho ficus >> "$LAZY_DB_LOG"\necho \'{"key":"shared-box-intensive","squadId":"fixture","enabled":false}\'\n',
    { mode: 0o755 }
  )
  for (const command of ['psql', 'bunx', 'pg_isready']) {
    writeFileSync(
      join(f.dir, 'bin', command),
      `#!/bin/sh\necho ${command} >> "$LAZY_DB_LOG"\n${command === 'bunx' && slowPush ? 'sleep 6\n' : ''}cat "${join(f.dir, 'schema')}"\n`,
      { mode: 0o755 }
    )
  }
  return 'postgres://postgres:postgres@127.0.0.1:12345/ficus_test'
}

test('external DB readiness publishes the validated DSN before concurrent first imports', async () => {
  const f = fixture()
  try {
    const url = await externalFixture(f)
    const probe = join(f.dir, 'external.test.ts')
    writeFileSync(
      probe,
      `import {test, expect} from 'bun:test';
      import {ensureTestDatabase} from ${JSON.stringify(join(root, 'apps/core/src/db/test-readiness.ts'))};
      await Promise.all([ensureTestDatabase(), ensureTestDatabase(), import(${JSON.stringify(join(root, 'apps/core/src/db/index.ts'))})]);
      test('ready environment', () => expect(process.env.DATABASE_URL).toBe(${JSON.stringify(url)}));`
    )
    const result = f.run(['test', probe], root, { DATABASE_URL: url })
    expect(result.output).toContain('0 fail')
    expect(result.code).toBe(0)
    expect(result.commands.split('\n').filter((line) => line === 'ficus')).toHaveLength(1)
    expect(result.commands.split('\n').filter((line) => line === 'bunx')).toHaveLength(1)
    expect(result.commands).not.toContain('docker')
  } finally {
    f.clean()
  }
}, 40000)

test('mixed tests defer startup until DB use, and partial startup failure cleans only the owned project', () => {
  const f = fixture()
  try {
    writeFileSync(
      join(f.dir, 'bin', 'ficus'),
      `#!/bin/sh
echo ficus >> "$LAZY_DB_LOG"
echo '{"key":"shared-box-intensive","squadId":"fixture","enabled":false}'
`,
      { mode: 0o755 }
    )
    writeFileSync(
      join(f.dir, 'bin', 'docker'),
      `#!/bin/sh
echo "docker $*" >> "$LAZY_DB_LOG"
case " $* " in *" up "*) echo 'fixture compose failure' >&2; exit 7;; esac
exit 0
`,
      { mode: 0o755 }
    )
    const probe = join(f.dir, 'mixed.test.ts')
    writeFileSync(
      probe,
      `import {test, expect} from 'bun:test'; import {existsSync} from 'node:fs';
      test('pure before database', () => expect(existsSync(process.env.LAZY_DB_LOG!)).toBe(false));
      test('first database use', async () => { await import(${JSON.stringify(join(root, 'apps/core/src/db/index.ts'))}) });
      test('never run after broken setup', () => { throw new Error('ran after failed setup') });`
    )
    const result = f.run(['test', probe])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('(pass) pure before database')
    expect(result.output).toContain('fixture compose failure')
    expect(result.output).not.toContain('ran after failed setup')
    expect(result.commands.split('\n').filter((line) => line === 'ficus')).toHaveLength(1)
    expect(result.commands).not.toContain('bunx')
    const up = result.commands.split('\n').find((line) => line.includes(' up -d postgres'))!
    const project = up.match(/ -p (ficus-test-[a-f0-9]+) /)![1]
    expect(result.commands).toContain(
      `docker compose -p ${project} -f ${join(root, 'docker-compose.test.yml')} down --volumes --remove-orphans --timeout 2`
    )
    for (const line of result.commands.split('\n').filter((line) => line.startsWith('docker compose '))) {
      expect(line).toContain(` -p ${project} `)
    }
  } finally {
    f.clean()
  }
}, 40000)

test('an already-expired full-lane deadline never acquires DB ownership or capacity', () => {
  const f = fixture()
  try {
    const result = f.run(['run', 'scripts/run-core-tests.ts', '--subprocess', '--subprocess-shard', '1/2'], root, {
      FICUS_TEST_DEADLINE_MS: '1',
    })
    expect(result.commands).toBe('')
    expect(result.code).toBe(1)
    expect(result.output).toContain('Lane deadline exceeded')
    expect(result.output).not.toContain('PASSED')
  } finally {
    f.clean()
  }
}, 40000)

test('dynamic DB-dependent command suites request readiness before entering test budgets', () => {
  const f = fixture()
  try {
    const result = f.run(['test', 'apps/core/src/services/integrations/execution-wrappers.test.ts'])
    expect(result.commands).toBe('ficus\n')
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    // Cold schema work must finish at module readiness, not consume a later
    // dynamic import's 5s test budget after the pure cases have already run.
    expect(result.output).not.toContain('(pass)')
  } finally {
    f.clean()
  }
}, 40000)

test('cold schema setup longer than the default timeout stays outside dynamic-import test bodies', async () => {
  const f = fixture()
  try {
    // Six seconds is deliberately longer than the existing 5s test budget. All
    // DB commands are fixtures; only this harness test has an integration budget.
    const url = await externalFixture(f, true)
    const result = f.run(['test', 'apps/core/src/services/integrations/execution-wrappers.test.ts'], root, {
      DATABASE_URL: url,
    })
    expect(result.code).toBe(0)
    expect(result.signal).toBeUndefined()
    expect(result.output).toContain('15 pass')
    expect(result.output).toContain('0 fail')
    expect(result.output).not.toContain('timed out')
    expect(result.commands.split('\n').filter((line) => line === 'bunx')).toHaveLength(1)
    expect(result.commands).not.toContain('docker')
  } finally {
    f.clean()
  }
}, 40000)

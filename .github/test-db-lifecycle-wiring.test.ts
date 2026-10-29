import { expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
function capacityFixture(bin: string): void {
  writeFileSync(
    join(bin, 'ficus'),
    `#!/bin/sh
printf '{"key":"shared-box-intensive","squadId":"%s","enabled":false}\n' "$FICUS_SQUAD_ID"
`,
    { mode: 0o755 }
  )
}
// Run the real manual script from a temporary checkout so successful setup
// cannot write a port cache into the source worktree.
function manualScript(dir: string): string {
  mkdirSync(join(dir, 'scripts'))
  const file = join(dir, 'scripts/test-db.ts')
  writeFileSync(
    file,
    read('scripts/test-db.ts').replace(/'@ficus\/shared\/(\w+)'/g, (_, name) =>
      JSON.stringify(resolve(root, `packages/shared/src/${name}.ts`))
    )
  )
  writeFileSync(join(dir, 'docker-compose.test.yml'), '')
  return file
}
test('Core preload owns its DB before probing or starting it and always runs safe startup hygiene', () => {
  const code = read('apps/core/src/test-db-setup.ts')
  expect(code).toContain('ownTestDb(repoRoot)')
  expect(code.indexOf('ownTestDb(repoRoot)')).toBeLessThan(code.indexOf('TEST_DATABASE_URL = withTestDbLockSync'))
  expect(code).toContain('sweepStaleTestDbs(repoRoot)')
  expect(code).not.toContain("FICUS_TEST_SWEEP_ORPHANS === '1'")
  expect(code).toContain('timeout: 30000')
})
test('manual aliases cannot start an unowned detached compose project', () => {
  const pkg = JSON.parse(read('package.json')).scripts
  expect(pkg.test).not.toContain('test:db:up')
  expect(pkg['docker:up:test']).toBe('bun run test:db:up')
  expect(pkg['docker:down:test']).toBe('bun run test:db:down')
  expect(read('scripts/test-db.ts')).toContain('ownTestDb(repoRoot)')
  expect(read('scripts/test-db.ts')).toContain('setInterval')
  expect(read('apps/core/src/test-db.ts')).not.toContain('Bun.spawn')
  expect(read('scripts/docker-gc.ts')).not.toContain('status=exited')
  expect(read('scripts/run-core-tests.ts')).toContain('handleSignals: false')
})
for (const manual of [false, true])
  for (const interrupt of [false, true]) {
    test(`${manual ? 'manual test:db:up' : 'root-invoked Bun diagnostic'} cleans up failed${interrupt ? ' and interrupted' : ''} DB preload startup`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'root-preload-lifecycle-'))
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      capacityFixture(bin)
      const log = join(dir, 'docker.log')
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\ncase "$*" in\n *'up -d postgres'*) ${interrupt ? 'kill -TERM "$PPID";' : ''} echo injected-up-failure >&2; exit 1;;\n *'exec -T'*|*'port postgres'*) exit 1;;\nesac\nexit 0\n`,
        { mode: 0o755 }
      )
      writeFileSync(join(bin, 'pg_isready'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const file = join(dir, 'diagnostic.test.ts')
      writeFileSync(
        file,
        `import ${JSON.stringify(join(root, 'apps/core/src/db/index.ts'))}; import {test} from "bun:test"; test("diagnostic", () => {})`
      )
      const child = Bun.spawn(manual ? [process.execPath, manualScript(dir), 'up'] : [process.execPath, 'test', file], {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: dir,
          XDG_CACHE_HOME: dir,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_LOG: log,
          DATABASE_URL: '',
          FICUS_TEST_DB_OWNER: '',
          FICUS_TEST_REQUIRE_DB: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        const [exit, , error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exit).not.toBe(0)
        const calls = readFileSync(log, 'utf8')
        expect(calls).toContain('up -d postgres')
        expect(calls).toContain('down --volumes --remove-orphans')
        expect(error).toMatch(/database|postgres|interrupted|injected-up-failure/i)
      } finally {
        child.kill('SIGKILL')
        await child.exited
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15000)
  }

test('setup shell tests are render-only, not hidden database starters', () => {
  for (const file of ['lib.test.sh', 'pooler.test.sh']) {
    const code = read(`scripts/setup/${file}`)
    expect(code).not.toMatch(/docker\s+compose[^\n]*\bup\b/)
  }
})

test('standalone persistent restart fixture tears down its project on TERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fifo-preload-lifecycle-'))
  const log = join(dir, 'docker.log')
  writeFileSync(
    join(dir, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\ncase "$*" in *"up -d"*) kill -TERM "$PPID";; esac\nexit 0\n',
    { mode: 0o755 }
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '--config=./bunfig.fifo-restart.toml',
      'test',
      './apps/core/src/db/message-enqueue-order-restart.standalone.ts',
    ],
    {
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  try {
    const exit = await child.exited
    expect(exit).not.toBe(0)
    expect(readFileSync(log, 'utf8')).toContain('down -v --remove-orphans')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)

test('shared Compose readiness fixture tears down partial setup on TERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-ready-lifecycle-'))
  const log = join(dir, 'docker.log')
  writeFileSync(
    join(dir, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\ncase "$*" in *"up -d"*) kill -TERM "$PPID";; esac\nexit 0\n',
    { mode: 0o755 }
  )
  writeFileSync(join(dir, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const child = Bun.spawn([process.execPath, 'test', 'src/testDbReady.test.ts'], {
    cwd: join(root, 'packages/shared'),
    env: { ...process.env, TMPDIR: dir, XDG_CACHE_HOME: dir, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    expect(await child.exited).not.toBe(0)
    expect(readFileSync(log, 'utf8')).toContain('down --volumes --remove-orphans')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)

test('a root database-free diagnostic still runs when Docker is not installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-docker-diagnostic-'))
  const file = join(dir, 'diagnostic.test.ts')
  writeFileSync(file, 'import {test,expect} from "bun:test"; test("database-free", () => expect(1).toBe(1))')
  const child = Bun.spawn([process.execPath, 'test', file], {
    cwd: root,
    env: {
      ...process.env,
      PATH: dir,
      TMPDIR: dir,
      XDG_CACHE_HOME: dir,
      DATABASE_URL: '',
      FICUS_TEST_REQUIRE_DB: '0',
      CI: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const [exit, , error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exit).toBe(0)
    expect(error).toContain('1 pass')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`successful manual DB session stays foreground until ${signal}, then removes volumes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manual-db-ready-'))
    capacityFixture(dir)
    const log = join(dir, 'docker.log')
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *'up -d postgres'*) printf '%s' "$TEST_DB_PORT" > "$DOCKER_LOG.port";;
  *'port postgres'*) printf '0.0.0.0:'; cat "$DOCKER_LOG.port";;
esac
exit 0
`,
      { mode: 0o755 }
    )
    // canExecuteQuery's disposable Bun probe is fake: never connect to Postgres.
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const child = Bun.spawn([process.execPath, manualScript(dir), 'up'], {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: dir,
        XDG_CACHE_HOME: dir,
        PATH: `${dir}:${process.env.PATH}`,
        DOCKER_LOG: log,
        FICUS_TEST_DB_OWNER: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const reader = child.stdout.getReader()
      let output = ''
      while (!output.includes('foreground session')) {
        const chunk = await reader.read()
        if (chunk.done) break
        output += new TextDecoder().decode(chunk.value)
      }
      expect(output).toContain('foreground session')
      expect(child.exitCode).toBeNull()
      child.kill(signal)
      expect(await child.exited).toBe(signal === 'SIGINT' ? 130 : 143)
      expect(readFileSync(log, 'utf8')).toContain('down --volumes --remove-orphans')
    } finally {
      child.kill('SIGKILL')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)
}

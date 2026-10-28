import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canReapTestDb } from './testDbLifecycle'
import { testDbProjectName } from './testDbPort'

const now = Date.now()
const record = {
  version: 2,
  repoRoot: '/repo',
  project: testDbProjectName('/repo'),
  composeFile: '/repo/docker-compose.test.yml',
  scope: '/repo/.git',
  host: 'local',
  pid: 123,
  token: 'unique',
  createdAt: now - 7200001,
  ownerReleased: false,
  borrowers: [],
}
// Identity is checked separately from age/liveness; ambiguous owners fail closed.
test('stale classification requires age, matching scope/host, and a provably dead owner', () => {
  const classify = (changes = {}, alive: boolean | undefined = false) =>
    canReapTestDb({ ...record, ...changes }, { now, host: 'local', scope: '/repo/.git', ownerAlive: () => alive })
  expect(classify()).toBe(true)
  expect(classify({ createdAt: now - 7199999 })).toBe(false)
  expect(classify({}, true)).toBe(false)
  expect(canReapTestDb(record, { now, host: 'local', scope: '/repo/.git', ownerAlive: () => undefined })).toBe(false)
  expect(classify({ host: 'other' })).toBe(false)
  expect(classify({ scope: '/other/.git' })).toBe(false)
  expect(classify({ project: 'production' })).toBe(false)
  expect(classify({ composeFile: '/other/compose.yml' })).toBe(false)
})

const source = resolve(import.meta.dir, 'testDbLifecycle.ts')
async function fixture(body: string, docker = 'exit 0') {
  const dir = mkdtempSync(join(tmpdir(), 'test-db-lifecycle-'))
  const root = join(dir, 'repo')
  mkdirSync(root)
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'docker-compose.test.yml'), '')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'docker.log')
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\n${docker}\n`, { mode: 0o755 })
  const script = join(dir, 'run.ts')
  writeFileSync(
    script,
    `import { ownTestDb } from ${JSON.stringify(source)};\nconst root = ${JSON.stringify(root)}; const session = ownTestDb(root);\n${body}`
  )
  mkdirSync(join(dir, 'temporary'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: join(dir, 'temporary'),
    XDG_CACHE_HOME: dir,
    PATH: `${bin}:${process.env.PATH}`,
    DOCKER_LOG: log,
  }
  delete env.FICUS_TEST_DB_OWNER
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' })
  return { child, dir, log, root, env, clean: () => rmSync(dir, { recursive: true, force: true }) }
}
test('unrecorded existing projects are never adopted or destroyed', async () => {
  const f = await fixture('', 'case "$*" in *ps*) echo existing-container;; esac')
  try {
    expect(await f.child.exited).toBe(1)
    expect(await new Response(f.child.stderr).text()).toContain('unrecorded')
    expect(readFileSync(f.log, 'utf8')).not.toContain('down')
  } finally {
    f.clean()
  }
})

test('overlapping independent runs refuse a live owner, inherited children borrow without teardown', async () => {
  const f = await fixture(`
    const code = 'import { ownTestDb } from ' + JSON.stringify(${JSON.stringify(source)}) + '; ownTestDb(' + JSON.stringify(root) + ');';
    const env = { ...process.env }; delete env.FICUS_TEST_DB_OWNER;
    const independent = Bun.spawnSync([process.execPath, '-e', code], {env, stdout:'pipe', stderr:'pipe'});
    if (independent.exitCode !== 1 || !independent.stderr.toString().includes('live or unknown owner')) process.exit(8);
    const stopCode = 'import {stopOwnedTestDb} from ' + JSON.stringify(${JSON.stringify(source)}) + '; process.exit(stopOwnedTestDb(' + JSON.stringify(root) + ') ? 0 : 1)';
    const stop = Bun.spawnSync([process.execPath, '-e', stopCode], {env,stdout:'pipe',stderr:'pipe'});
    if (stop.exitCode !== 1 || !stop.stderr.toString().includes('live owner')) process.exit(10);
    const borrowed = Bun.spawnSync([process.execPath, '-e', code], {env: {...process.env}, stdout:'pipe',stderr:'pipe'});
    if (borrowed.exitCode !== 0) process.exit(9);
  `)
  try {
    expect(await f.child.exited).toBe(0)
    expect(readFileSync(f.log, 'utf8').split('down --volumes')).toHaveLength(2)
  } finally {
    f.clean()
  }
})

for (const body of ['', 'process.exit(7)', 'throw new Error("setup failed")']) {
  test(`owned run tears down with volumes on exit: ${body || 'success'}`, async () => {
    const f = await fixture(body)
    try {
      await f.child.exited
      expect(readFileSync(f.log, 'utf8')).toContain('down --volumes --remove-orphans')
    } finally {
      f.clean()
    }
  })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} tears down once and preserves signal exit status`, async () => {
    const f = await fixture('console.log("ready"); setInterval(() => {}, 1000)')
    try {
      await f.child.stdout.getReader().read()
      f.child.kill(signal)
      expect(await f.child.exited).toBe(signal === 'SIGINT' ? 130 : 143)
      expect(
        readFileSync(f.log, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line.includes('down --volumes'))
      ).toHaveLength(1)
    } finally {
      f.child.kill()
      await f.child.exited
      f.clean()
    }
  })
}
test('cleanup failure is visible and turns an otherwise successful run red', async () => {
  const f = await fixture('', 'echo daemon-unavailable >&2; exit 1')
  try {
    expect(await f.child.exited).toBe(1)
    expect(await new Response(f.child.stderr).text()).toContain('daemon-unavailable')
  } finally {
    f.clean()
  }
})

test('hung Docker cleanup is hard-bounded with a named diagnostic', async () => {
  const f = await fixture('', 'case "$*" in *down*) exec sleep 60;; esac')
  const started = Date.now()
  try {
    expect(await f.child.exited).toBe(1)
    expect(Date.now() - started).toBeLessThan(14000)
    const error = await new Response(f.child.stderr).text()
    expect(error).toContain('limit 10000ms')
    expect(error).toContain('ficus-test-')
  } finally {
    f.child.kill()
    await f.child.exited
    f.clean()
  }
}, 15000)

for (const mode of [
  'dead-old',
  'dead-missing-compose',
  'dead-fresh',
  'live-old',
  'other-clone',
  'other-host',
  'failed-down',
] as const) {
  test(`startup sweep safety: ${mode}`, async () => {
    const f = await fixture(
      'console.log("ready"); setInterval(() => {}, 1000)',
      mode === 'dead-missing-compose'
        ? 'while [ "$#" -gt 0 ]; do if [ "$1" = -f ]; then shift; [ -f "$1" ] || exit 1; fi; shift; done; exit 0'
        : mode === 'failed-down'
          ? 'case "$*" in *down*) exit 1;; esac'
          : 'exit 0'
    )
    try {
      await f.child.stdout.getReader().read()
      if (mode !== 'live-old') {
        f.child.kill('SIGKILL')
        await f.child.exited
      }
      if (mode === 'dead-missing-compose') rmSync(join(f.root, 'docker-compose.test.yml'))
      const registry = join(
        f.dir,
        readdirSync(f.dir).find((name) => name.startsWith('ficus-test-db-owners-'))!
      )
      const file = join(registry, readdirSync(registry)[0]!)
      const owner = JSON.parse(readFileSync(file, 'utf8'))
      const currentRoot = mode === 'dead-missing-compose' ? join(f.dir, 'surviving-checkout') : f.root
      if (mode === 'dead-missing-compose') {
        mkdirSync(currentRoot)
        writeFileSync(join(currentRoot, 'docker-compose.test.yml'), '')
        owner.scope = join(currentRoot, '.git')
      }
      if (mode !== 'dead-fresh') owner.createdAt = Date.now() - 7200001
      if (mode === 'other-clone') owner.scope = '/other/.git'
      if (mode === 'other-host') owner.host = 'other-host'
      writeFileSync(file, JSON.stringify(owner))
      const code = `import {sweepStaleTestDbs} from ${JSON.stringify(source)}; console.log(JSON.stringify(sweepStaleTestDbs(${JSON.stringify(currentRoot)})))`
      const sweep = Bun.spawnSync([process.execPath, '-e', code], {
        env: f.env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15000,
      })
      expect(sweep.exitCode).toBe(0)
      expect(JSON.parse(sweep.stdout.toString())).toEqual(
        ['dead-old', 'dead-missing-compose'].includes(mode) ? [owner.project] : []
      )
      expect(readdirSync(registry)).toHaveLength(['dead-old', 'dead-missing-compose'].includes(mode) ? 0 : 1)
      const downs = readFileSync(f.log, 'utf8').split('down --volumes').length - 1
      expect(downs).toBe(['dead-old', 'dead-missing-compose', 'failed-down'].includes(mode) ? 1 : 0)
    } finally {
      f.child.kill('SIGKILL')
      await f.child.exited
      f.clean()
    }
  })
}

test('recorded ownership cannot delete a project replaced by another owner', async () => {
  const f = await fixture('', 'case "$*" in *--format*) echo foreign-token;; esac')
  try {
    expect(await f.child.exited).toBe(1)
    expect(await new Response(f.child.stderr).text()).toContain('ownership labels')
    expect(readFileSync(f.log, 'utf8')).not.toContain('down --volumes')
  } finally {
    f.clean()
  }
})

test('sequential runner lanes borrow one lifetime and clean up only after both complete', async () => {
  const runner = resolve(import.meta.dir, '../../../scripts/test-runner.ts')
  const f = await fixture(`
    const {runTests} = await import(${JSON.stringify(runner)});
    await Bun.write(root + '/preload.ts', 'import {ownTestDb} from ' + JSON.stringify(${JSON.stringify(source)}) + '; ownTestDb(' + JSON.stringify(root) + ');');
    await Bun.write(root + '/bunfig.toml', ${JSON.stringify('[test]\npreload=["./preload.ts"]\n')});
    await Bun.write(root + '/a.test.ts', 'import {test} from "bun:test"; test("first lane", () => {})');
    await Bun.write(root + '/b.test.ts', 'import {test} from "bun:test"; test("second lane", () => {})');
    await runTests({cwd:root, roots:['a.test.ts']});
    await runTests({cwd:root, roots:['b.test.ts'], isolated:true, cacheSchema:true});
  `)
  try {
    const [exit, , error] = await Promise.all([
      f.child.exited,
      new Response(f.child.stdout).text(),
      new Response(f.child.stderr).text(),
    ])
    if (exit !== 0) console.error(error)
    expect(exit).toBe(0)
    expect(readFileSync(f.log, 'utf8').split('down --volumes')).toHaveLength(2)
  } finally {
    f.child.kill('SIGKILL')
    await f.child.exited
    f.clean()
  }
})

for (const inventory of ['exit 1', 'kill -KILL $$', 'exec sleep 60']) {
  test(`failed initial inventory never claims or mutates a project: ${inventory}`, async () => {
    const f = await fixture('console.log("CLAIMED")', `case "$*" in *-q*) ${inventory};; esac`)
    try {
      const [exit, output, error] = await Promise.all([
        f.child.exited,
        new Response(f.child.stdout).text(),
        new Response(f.child.stderr).text(),
      ])
      expect(exit).toBe(1)
      expect(output).not.toContain('CLAIMED')
      expect(error).toContain('inventory')
      expect(readFileSync(f.log, 'utf8')).not.toMatch(/\b(up|down)\b/)
      const registry = join(
        f.dir,
        readdirSync(f.dir).find((name) => name.startsWith('ficus-test-db-owners-'))!
      )
      expect(readdirSync(registry)).toEqual([])
    } finally {
      f.child.kill('SIGKILL')
      await f.child.exited
      f.clean()
    }
  }, 10000)
}

for (const action of ['reclaim', 'sweep', 'manual-down'] as const) {
  test(`live borrower protects a dead parent's project from ${action}, then last borrower cleans up`, async () => {
    const f = await fixture('console.log(process.env.FICUS_TEST_DB_OWNER); setInterval(() => {}, 1000)')
    let borrower: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    try {
      const token = new TextDecoder().decode((await f.child.stdout.getReader().read()).value).trim()
      const code = `import {ownTestDb} from ${JSON.stringify(source)}; ownTestDb(${JSON.stringify(f.root)}); console.log("borrowed"); setInterval(() => {}, 1000)`
      borrower = Bun.spawn([process.execPath, '-e', code], {
        env: { ...f.env, FICUS_TEST_DB_OWNER: token },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode((await borrower.stdout.getReader().read()).value)).toContain('borrowed')
      f.child.kill('SIGKILL')
      await f.child.exited
      const registry = join(
        f.dir,
        readdirSync(f.dir).find((name) => name.startsWith('ficus-test-db-owners-'))!
      )
      const file = join(registry, readdirSync(registry)[0]!)
      const owner = JSON.parse(readFileSync(file, 'utf8'))
      owner.createdAt = Date.now() - 7200001
      writeFileSync(file, JSON.stringify(owner))
      writeFileSync(f.log, '')
      const request =
        action === 'reclaim'
          ? `ownTestDb(${JSON.stringify(f.root)})`
          : action === 'sweep'
            ? `console.log(JSON.stringify(sweepStaleTestDbs(${JSON.stringify(f.root)})))`
            : `process.exit(stopOwnedTestDb(${JSON.stringify(f.root)}) ? 0 : 1)`
      const result = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          `import {ownTestDb,sweepStaleTestDbs,stopOwnedTestDb} from ${JSON.stringify(source)}; ${request}`,
        ],
        { env: f.env, stdout: 'pipe', stderr: 'pipe', timeout: 15000 }
      )
      expect(result.exitCode).toBe(action === 'sweep' ? 0 : 1)
      if (action === 'sweep') expect(JSON.parse(result.stdout.toString())).toEqual([])
      expect(readFileSync(f.log, 'utf8')).not.toContain('down')
      expect(() => process.kill(borrower!.pid, 0)).not.toThrow()
      borrower.kill('SIGTERM')
      await borrower.exited
      expect(readFileSync(f.log, 'utf8')).toContain('down --volumes --remove-orphans')
      expect(readdirSync(registry)).toEqual([])
    } finally {
      borrower?.kill('SIGKILL')
      if (borrower) await borrower.exited
      f.child.kill('SIGKILL')
      await f.child.exited
      f.clean()
    }
  })
}

test('stale decisions fail closed for unknown borrowers and old membership schemas', () => {
  const withBorrower = { ...record, borrowers: [456] }
  const context = {
    now,
    host: 'local',
    scope: '/repo/.git',
    ownerAlive: (pid: number): boolean | undefined => (pid === 456 ? undefined : false),
  }
  expect(canReapTestDb(withBorrower, context)).toBe(false)
  expect(canReapTestDb(withBorrower, { ...context, ownerAlive: (pid) => pid === 456 })).toBe(false)
  expect(canReapTestDb(withBorrower, { ...context, ownerAlive: () => false })).toBe(true)
  expect(canReapTestDb({ ...record, version: 1 }, { ...context, ownerAlive: () => false })).toBe(false)
})

test('normal owner release defers teardown to its last live borrower, even while owner PID exists', async () => {
  const f = await fixture(
    'console.log(process.env.FICUS_TEST_DB_OWNER); process.on("SIGUSR1", () => {session.release();console.log("released")}); setInterval(() => {}, 1000)'
  )
  let borrower: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  try {
    const reader = f.child.stdout.getReader()
    const token = new TextDecoder().decode((await reader.read()).value).trim()
    const code = `import {ownTestDb} from ${JSON.stringify(source)}; ownTestDb(${JSON.stringify(f.root)}); console.log("borrowed"); setInterval(() => {},1000)`
    borrower = Bun.spawn([process.execPath, '-e', code], {
      env: { ...f.env, FICUS_TEST_DB_OWNER: token },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await borrower.stdout.getReader().read()
    writeFileSync(f.log, '')
    f.child.kill('SIGUSR1')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('released')
    expect(readFileSync(f.log, 'utf8')).not.toContain('down')
    borrower.kill('SIGTERM')
    await borrower.exited
    expect(() => process.kill(f.child.pid, 0)).not.toThrow()
    expect(readFileSync(f.log, 'utf8').split('down --volumes')).toHaveLength(2)
  } finally {
    borrower?.kill('SIGKILL')
    if (borrower) await borrower.exited
    f.child.kill('SIGKILL')
    await f.child.exited
    f.clean()
  }
})

test('Compose teardown gives graceful stop a shorter budget than the hard command deadline', async () => {
  const f = await fixture('')
  try {
    expect(await f.child.exited).toBe(0)
    const down = readFileSync(f.log, 'utf8')
      .split('\n')
      .find((line) => line.includes('down --volumes'))!
      .split(' ')
    expect(down).toContain('--timeout')
    const graceMs = Number(down[down.indexOf('--timeout') + 1]) * 1000
    expect(graceMs).toBeGreaterThan(0)
    expect(graceMs).toBeLessThanOrEqual(5000) // leave at least 5s of the existing 10s CLI bound for overhead
  } finally {
    f.child.kill('SIGKILL')
    await f.child.exited
    f.clean()
  }
})

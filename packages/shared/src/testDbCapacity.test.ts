import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const squadId = 'fixture-squad'
const pool = { key: 'shared-box-intensive', squadId, enabled: true }
const claim = { id: 'fixture-claim', ownerAgentId: 'fixture-agent', expiresAt: '2999-01-01T00:00:00Z' }

// Every external command is a fixture. In particular, a regression must NEVER
// start Docker or contact the real capacity API, even during the red phase.
function fixture(response: unknown = pool, cliExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'test-db-capacity-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'commands')
  writeFileSync(join(dir, 'response.json'), JSON.stringify(response))
  for (const command of ['docker', 'psql', 'pg_isready']) {
    writeFileSync(join(bin, command), `#!/bin/sh\necho ${command} >> "$CAPACITY_FIXTURE_LOG"\nexit 7\n`, {
      mode: 0o755,
    })
  }
  writeFileSync(
    join(bin, 'ficus'),
    `#!/bin/sh\n[ "$FICUS_AGENT_CONTEXT" = 1 ] || exit 6\necho "ficus $*" >> "$CAPACITY_FIXTURE_LOG"\ncat "$CAPACITY_FIXTURE_RESPONSE"\necho 'private-auth-diagnostic' >&2\nexit ${cliExit}\n`,
    { mode: 0o755 }
  )
  writeFileSync(join(dir, 'probe.test.ts'), "import {test} from 'bun:test'; test('probe', () => {});\n")
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FICUS_SANDBOX_ID: `squad_${squadId}`,
    FICUS_SQUAD_ID: squadId,
    FICUS_TOKEN: 'fixture-only-token',
    FICUS_API_URL: 'http://capacity.invalid',
    FICUS_TEST_REQUIRE_DB: '1',
    DATABASE_URL: '',
    FICUS_TEST_DB_OWNER: '',
    XDG_CACHE_HOME: join(dir, 'cache'),
    CAPACITY_FIXTURE_LOG: log,
    CAPACITY_FIXTURE_RESPONSE: join(dir, 'response.json'),
  }
  const run = (args: string[], overrides = {}, cwd = root) => {
    const result = Bun.spawnSync([process.execPath, ...args], {
      cwd,
      env: { ...env, ...overrides },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20000,
    })
    return {
      code: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      commands: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }
  }
  return { dir, run, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

for (const entry of ['root preload', 'Core preload', 'direct startup', 'Core runner'] as const) {
  test(`${entry}: unclaimed admission stops before any DB command (including CI=true)`, () => {
    const f = fixture()
    try {
      const args =
        entry === 'root preload' || entry === 'Core preload'
          ? ['test', join(f.dir, 'probe.test.ts')]
          : entry === 'direct startup'
            ? ['run', 'apps/core/src/test-db.ts', 'up']
            : ['run', 'scripts/run-core-tests.ts', 'apps/core/src/services/sandbox/client/http-client.test.ts']
      const result = f.run(args, { CI: 'true' }, entry === 'Core preload' ? join(root, 'apps/core') : root)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('[test-db capacity: unavailable]')
      expect(result.commands).toBe(`ficus --json slot list shared-box-intensive --squad ${squadId}\n`)
      expect(result.output).not.toContain('private-auth-diagnostic')
    } finally {
      f.clean()
    }
  }, 30000)
}

const capacitySource = resolve(import.meta.dir, 'testDbCapacity.ts')
const check = [
  '-e',
  `import {requireTestDbCapacity} from ${JSON.stringify(capacitySource)}; requireTestDbCapacity(); console.log('admitted')`,
]

for (const [name, response, outcome] of [
  ['queued', { ...pool, callerWaiter: { id: 'waiter' } }, 'queued'],
  ['expired', { ...pool, callerClaim: { ...claim, expiresAt: '2000-01-01T00:00:00Z' } }, 'expired'],
  ['lost ownership', { ...pool, holders: [claim] }, 'unavailable'],
  ['wrong squad', { ...pool, squadId: 'another-squad', callerClaim: claim }, 'unavailable'],
  ['malformed claim', { ...pool, callerClaim: { ...claim, id: [], ownerAgentId: 4 } }, 'unavailable'],
  ['invalid expiry', { ...pool, callerClaim: { ...claim, expiresAt: 'not-a-time' } }, 'unavailable'],
  ['old/malformed API', { ...pool, enabled: undefined, callerClaim: claim }, 'unavailable'],
  ['missing pool', null, 'unavailable'],
] as const) {
  test(`${name} does not admit DB work`, () => {
    const f = fixture(response)
    try {
      const result = f.run(check)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain(`[test-db capacity: ${outcome}]`)
      expect(result.output).not.toContain('private-auth-diagnostic')
    } finally {
      f.clean()
    }
  })
}

for (const response of [
  { ...pool, callerClaim: claim },
  { ...pool, enabled: false },
]) {
  test(`${response.enabled ? 'existing claim' : 'disabled pool'} admits without claiming, renewing, or queueing`, () => {
    const f = fixture(response)
    try {
      const result = f.run(check)
      expect(result.code).toBe(0)
      expect(result.output).toContain('admitted')
      expect(result.commands).toBe(`ficus --json slot list shared-box-intensive --squad ${squadId}\n`)
      expect(result.output).not.toContain('private-auth-diagnostic')
      expect(result.output).toContain(`[test-db capacity: ${response.enabled ? 'granted' : 'disabled'}]`)
    } finally {
      f.clean()
    }
  })
}

test('CLI failure fails closed without echoing credentials or raw diagnostics', () => {
  const f = fixture({ ...pool, callerClaim: claim }, 1)
  try {
    const result = f.run(check)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.output).not.toContain('private-auth-diagnostic')
    expect(result.output).not.toContain('fixture-only-token')
  } finally {
    f.clean()
  }
})

test('each check observes current ownership, not a cached grant', () => {
  const f = fixture({ ...pool, callerClaim: claim })
  try {
    const script = `import {requireTestDbCapacity} from ${JSON.stringify(capacitySource)};
      requireTestDbCapacity();
      await Bun.write(process.env.CAPACITY_FIXTURE_RESPONSE, ${JSON.stringify(JSON.stringify(pool))});
      requireTestDbCapacity();`
    const result = f.run(['-e', script])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.commands.match(/ficus --json slot list/g)).toHaveLength(2)
  } finally {
    f.clean()
  }
})

test('missing runtime credentials fail closed without falling back to a saved login', () => {
  const f = fixture({ ...pool, callerClaim: claim })
  try {
    const result = f.run(check, { FICUS_TOKEN: '' })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('Runtime squad/agent identity is missing')
    expect(result.commands).toBe('')
  } finally {
    f.clean()
  }
})

// Exercise runtime detection with explicit fixture identities, never by
// stripping the real box identity to run database tooling.
for (const ci of ['', 'true']) {
  test(`non-Ficus ${ci ? 'CI' : 'local development'} needs no CLI or Core API`, () => {
    const f = fixture(null, 1)
    try {
      const script = `import {requireTestDbCapacity} from ${JSON.stringify(capacitySource)};
        requireTestDbCapacity(process.env, 'developer'); console.log('admitted');`
      const result = f.run(['-e', script], {
        FICUS_SANDBOX_ID: '',
        FICUS_BOX_HOME: '',
        FICUS_AGENT_CONTEXT: '',
        FICUS_SQUAD_ID: '',
        FICUS_API_URL: '',
        FICUS_TOKEN: '',
        CI: ci,
      })
      expect({ code: result.code, output: result.output }).toEqual({ code: 0, output: 'admitted\n' })
      expect(result.commands).toBe('')
    } finally {
      f.clean()
    }
  })
}

test('OS box identity still enforces admission with stripped runtime markers and CI=true', () => {
  const f = fixture()
  try {
    const script = `import {requireTestDbCapacity} from ${JSON.stringify(capacitySource)};
      requireTestDbCapacity(process.env, 'box_0123456789ab');`
    const result = f.run(['-e', script], {
      FICUS_SANDBOX_ID: '',
      FICUS_BOX_HOME: '',
      FICUS_AGENT_CONTEXT: '',
      CI: 'true',
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.commands).toContain('ficus --json slot list')
  } finally {
    f.clean()
  }
})

for (const entry of ['root preload', 'direct startup']) {
  test(`${entry}: a valid claim reaches the existing project-owned DB path`, () => {
    const f = fixture({ ...pool, callerClaim: claim })
    try {
      const result = f.run(
        entry === 'root preload' ? ['test', join(f.dir, 'probe.test.ts')] : ['run', 'apps/core/src/test-db.ts', 'up']
      )
      // The fixture Docker refuses inventory; reaching it proves admission
      // succeeded without starting a real container or changing DB ownership.
      expect(result.output).toContain('Cannot verify test database inventory')
      expect(result.commands).toBe(`ficus --json slot list shared-box-intensive --squad ${squadId}\ndocker\n`)
    } finally {
      f.clean()
    }
  }, 30000)
}

test('down remains available after capacity is lost, without contacting the API', () => {
  const f = fixture(null, 1)
  try {
    const result = f.run(['run', 'apps/core/src/test-db.ts', 'down'])
    expect(result.commands).not.toContain('ficus')
    expect(result.output).not.toContain('test-db capacity:')
  } finally {
    f.clean()
  }
})

test('a supplied test DATABASE_URL and CI flag cannot bypass the root preload guard', () => {
  const f = fixture()
  try {
    const result = f.run(['test', join(f.dir, 'probe.test.ts')], {
      CI: 'true',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:12345/ficus_test',
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.commands).toBe(`ficus --json slot list shared-box-intensive --squad ${squadId}\n`)
  } finally {
    f.clean()
  }
})

test('malformed JSON is a bounded fail-closed diagnostic, not raw CLI output', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'response.json'), 'private-auth-diagnostic')
    const result = f.run(check)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.output).not.toContain('private-auth-diagnostic')
  } finally {
    f.clean()
  }
})

test('a stalled CLI check has a hard deadline and never reaches the DB', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'bin', 'ficus'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const result = f.run(check)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('[test-db capacity: unavailable]')
    expect(result.commands).toBe('')
  } finally {
    f.clean()
  }
}, 15000)

test('capacity imports respect the Core composite project file boundary', async () => {
  // Resolve membership only: do not build/typecheck the full Core program here.
  const ts = await import('typescript')
  const configFile = join(root, 'apps/core/tsconfig.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'apps/core'))
  const wrapper = join(root, 'scripts/check-test-db-capacity.ts')
  expect(parsed.fileNames).toContain(wrapper)
  for (const source of [wrapper, join(root, 'scripts/test-db.ts'), join(root, 'scripts/run-core-tests.ts')]) {
    const imported = ts
      .preProcessFile(readFileSync(source, 'utf8'))
      .importedFiles.find((entry) => entry.fileName.endsWith('/testDbCapacity'))
    expect(imported).toBeDefined()
    const resolved = ts.resolveModuleName(imported!.fileName, source, parsed.options, ts.sys).resolvedModule
    expect(resolved?.resolvedFileName).toEndWith('/testDbCapacity.ts')
    expect(resolved?.isExternalLibraryImport || parsed.fileNames.includes(resolved!.resolvedFileName)).toBe(true)
  }
})

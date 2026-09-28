import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { eq } from 'drizzle-orm'
import { db } from './db'
import { systemTokens } from './db/schema'
import { createSystemToken, resolveSystemToken } from './services/auth/system-tokens'
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  REISSUE_PLATFORM_ORCHESTRATOR,
  formatReissueOutput,
  parseSystemTokenControlRequest,
  rootRefusal,
} from './system-token-control'

const CORE_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(CORE_DIR, '..', '..')
const ENTRY = join(import.meta.dir, 'system-token-control.ts')
const OUTPUT_PATTERN = /^FICUS_SYSTEM_TOKEN=ficus_sys_[A-Za-z0-9_-]+\nFICUS_SYSTEM_TOKEN_REVOKED=\d+\n$/

describe('system-token-control request parsing', () => {
  test('accepts exactly the re-issue action, with no arguments', () => {
    expect(parseSystemTokenControlRequest({ FICUS_STC_ACTION: 'reissue-platform-orchestrator' }, [])).toEqual({
      action: REISSUE_PLATFORM_ORCHESTRATOR,
    })
  })

  test.each([
    ['a missing action', {}, []],
    ['an empty action', { FICUS_STC_ACTION: '' }, []],
    ['an unknown action', { FICUS_STC_ACTION: 'bogus' }, []],
    ['a padded action', { FICUS_STC_ACTION: ' reissue-platform-orchestrator' }, []],
    ['a differently-cased action', { FICUS_STC_ACTION: 'Reissue-Platform-Orchestrator' }, []],
    ['a positional argument', { FICUS_STC_ACTION: 'reissue-platform-orchestrator' }, ['extra']],
  ])('rejects %s as a usage error', (_label, env, argv) => {
    expect(() => parseSystemTokenControlRequest(env, argv)).toThrow(/usage/i)
  })
})

describe('system-token-control root gate', () => {
  const bundle = '/opt/ficus-core/current/apps/core/dist/system-token-control.js'

  test('the shipped bundle runs for root', () => {
    expect(rootRefusal(bundle, 0)).toBeNull()
  })

  test('the shipped bundle refuses every other user, and an unknown uid', () => {
    for (const euid of [1, 501, 65534, undefined]) expect(rootRefusal(bundle, euid)).toMatch(/must run as root/)
  })

  test('the TypeScript source (dev and tests only; artifacts ship no src/) is not gated', () => {
    expect(rootRefusal('/repo/apps/core/src/system-token-control.ts', 501)).toBeNull()
  })
})

describe('system-token-control output', () => {
  test('is exactly the two marker lines Platform parses', () => {
    const token = 'ficus_sys_' + 'A'.repeat(43)
    expect(formatReissueOutput({ token, revoked: 3 })).toBe(
      `FICUS_SYSTEM_TOKEN=${token}\nFICUS_SYSTEM_TOKEN_REVOKED=3\n`
    )
    expect(formatReissueOutput({ token, revoked: 0 })).toMatch(OUTPUT_PATTERN)
  })

  test('refuses to print anything that is not a system token on one line', () => {
    expect(() => formatReissueOutput({ token: 'not-a-token', revoked: 0 })).toThrow()
    expect(() => formatReissueOutput({ token: 'ficus_sys_a\nFICUS_SYSTEM_TOKEN_REVOKED=9', revoked: 0 })).toThrow()
    expect(() => formatReissueOutput({ token: 'ficus_sys_' + 'A'.repeat(43), revoked: -1 })).toThrow()
  })

  test('exit codes match the Platform contract', () => {
    expect([EXIT_OK, EXIT_FAILURE, EXIT_USAGE]).toEqual([0, 1, 2])
  })
})

describe('system-token-control reachability', () => {
  function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) found.push(...sourceFiles(full))
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full)
    }
    return found
  }

  test('only the entry calls the re-issue: no route, CLI command or package reaches it', () => {
    const roots = [join(CORE_DIR, 'src'), join(REPO_ROOT, 'apps/cli/src'), join(REPO_ROOT, 'packages')]
    const callers = roots
      .flatMap(sourceFiles)
      .filter((file) => /reissuePlatformOrchestratorToken|system-token-control/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file))
      .sort()
    expect(callers).toEqual(['apps/core/src/services/auth/system-tokens.ts', 'apps/core/src/system-token-control.ts'])
  })

  test('the entry does not load the legacy-env bridge (D21)', () => {
    expect(readFileSync(ENTRY, 'utf8')).not.toContain('boot/legacy-env')
  })

  test('the build bundles the entry and the artifact ships it', () => {
    const buildScript = (
      JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')) as { scripts: { build: string } }
    ).scripts.build
    const firstBuild = buildScript.split('&&')[0]!
    expect(firstBuild).toContain('src/system-token-control.ts')
    expect(firstBuild).toContain('--outdir dist')
    expect(readFileSync(join(REPO_ROOT, 'scripts/artifact/build-core-artifact.sh'), 'utf8')).toContain(
      'apps/core/dist/system-token-control.js'
    )
    expect(readFileSync(join(REPO_ROOT, 'scripts/artifact/lib/assemble-core-artifact.ts'), 'utf8')).toContain(
      "{ path: 'apps/core/dist/system-token-control.js', kind: 'file' }"
    )
  })
})

// These spawn a real bun subprocess, so they run only in the dedicated
// `subprocess-tests` CI job (see ci.yml); the main sweep sets
// FICUS_TEST_SKIP_SUBPROCESS=1 to skip them there.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('system-token-control entry (subprocess)', () => {
  let cwd: string

  beforeAll(() => {
    // No .env here, so the child sees only the environment the test hands it.
    cwd = mkdtempSync(join(tmpdir(), 'system-token-control-'))
  })

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  afterEach(async () => {
    await db.delete(systemTokens)
  })

  async function run(
    entry: string,
    overrides: Record<string, string | undefined>,
    args: string[] = []
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries({ ...process.env, LOG_LEVEL: 'debug', ...overrides })) {
      if (value !== undefined) env[key] = value
    }
    // --no-install: nothing may be fetched implicitly; the bundle needs only builtins.
    const child = Bun.spawn([process.execPath, '--no-install', entry, ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  async function orchestratorRows() {
    return db.select().from(systemTokens).where(eq(systemTokens.name, 'platform-orchestrator'))
  }

  test('an unknown action exits 2 with empty stdout and touches nothing', async () => {
    const result = await run(ENTRY, { FICUS_STC_ACTION: 'bogus' })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/usage/i)
    expect(await orchestratorRows()).toHaveLength(0)
  }, 30_000)

  test('a missing action exits 2 with empty stdout', async () => {
    const result = await run(ENTRY, { FICUS_STC_ACTION: undefined })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
  }, 30_000)

  test('a positional argument exits 2 with empty stdout', async () => {
    const result = await run(ENTRY, { FICUS_STC_ACTION: 'reissue-platform-orchestrator' }, ['extra'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(await orchestratorRows()).toHaveLength(0)
  }, 30_000)

  test('the re-issue prints only the markers, the secret exactly once, and never on stderr', async () => {
    const old = await createSystemToken({ name: 'platform-orchestrator', scopes: ['machines:read'] })

    const result = await run(ENTRY, { FICUS_STC_ACTION: 'reissue-platform-orchestrator' })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toMatch(OUTPUT_PATTERN)
    const token = result.stdout.match(/^FICUS_SYSTEM_TOKEN=(\S+)$/m)![1]!
    expect(result.stdout).toContain('FICUS_SYSTEM_TOKEN_REVOKED=1\n')
    expect(result.stdout.split(token)).toHaveLength(2)
    // Logging ran (LOG_LEVEL=debug), and went to stderr without the secret.
    expect(result.stderr).toContain('Re-issued the platform-orchestrator system token')
    expect(result.stderr).not.toContain(token)
    expect(result.stderr).not.toContain(token.slice('ficus_sys_'.length))

    expect(await resolveSystemToken(old.token)).toBeNull()
    const resolved = await resolveSystemToken(token)
    expect(resolved?.name).toBe('platform-orchestrator')
    expect(resolved?.scopes.sort()).toEqual(['machines:read', 'machines:write', 'system:pause'])
    expect((await orchestratorRows()).filter((row) => !row.revokedAt)).toHaveLength(1)
  }, 30_000)

  test('a retry supersedes the first run: the first token dies and one live token remains', async () => {
    const first = await run(ENTRY, { FICUS_STC_ACTION: 'reissue-platform-orchestrator' })
    const second = await run(ENTRY, { FICUS_STC_ACTION: 'reissue-platform-orchestrator' })

    expect([first.exitCode, second.exitCode]).toEqual([0, 0])
    expect(first.stdout).toContain('FICUS_SYSTEM_TOKEN_REVOKED=0\n')
    expect(second.stdout).toContain('FICUS_SYSTEM_TOKEN_REVOKED=1\n')
    const firstToken = first.stdout.match(/^FICUS_SYSTEM_TOKEN=(\S+)$/m)![1]!
    const secondToken = second.stdout.match(/^FICUS_SYSTEM_TOKEN=(\S+)$/m)![1]!
    expect(await resolveSystemToken(firstToken)).toBeNull()
    expect(await resolveSystemToken(secondToken)).not.toBeNull()
    expect((await orchestratorRows()).filter((row) => !row.revokedAt)).toHaveLength(1)
  }, 60_000)

  test('an unreachable database exits 1 with empty stdout', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    url.hostname = '127.0.0.1'
    url.port = '1'
    const result = await run(ENTRY, { FICUS_STC_ACTION: 'reissue-platform-orchestrator', DATABASE_URL: url.toString() })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
  }, 60_000)

  test('the shipped bundle refuses a non-root caller before touching the database', async () => {
    if (process.geteuid?.() === 0) return // The gate cannot be observed as root.
    const buildScript = (
      JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')) as { scripts: { build: string } }
    ).scripts.build
    // The first `bun build` step's externals, applied to this entry alone.
    const externals = buildScript
      .split('&&')[0]!
      .trim()
      .split(/\s+/)
      .filter((token) => token.startsWith('--external='))
    expect(buildScript.split('&&')[0]).toContain('--target bun')
    const outDir = mkdtempSync(join(tmpdir(), 'system-token-control-bundle-'))
    try {
      const build = Bun.spawn(
        [process.execPath, 'build', 'src/system-token-control.ts', '--outdir', outDir, '--target', 'bun', ...externals],
        { cwd: CORE_DIR, stdout: 'pipe', stderr: 'pipe' }
      )
      const buildExit = await build.exited
      expect(buildExit, await new Response(build.stderr).text()).toBe(0)

      const result = await run(join(outDir, 'system-token-control.js'), {
        FICUS_STC_ACTION: 'reissue-platform-orchestrator',
      })

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/must run as root/)
      expect(await orchestratorRows()).toHaveLength(0)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 120_000)
})

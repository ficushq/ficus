import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildMachineBundles } from '../../../../../scripts/artifact/build-machine-bundles'
import { discoverTests } from '../../../../../scripts/test-runner'
import { CLI_WRAPPER_BYTES } from './cli-bundle'

const repo = resolve(import.meta.dir, '../../../../..')

async function installedFixture(run: (root: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ficus-installed-'))
  try {
    const root = join(dir, 'opt/ficus')
    await mkdir(join(root, 'bun/bin'), { recursive: true })
    await mkdir(join(root, 'bin'))
    // Never touch the real /opt or modify the current interpreter.
    await copyFile(process.execPath, join(root, 'bun/bin/bun'))
    await symlink(join(root, 'bun/bin/bun'), join(root, 'bin/bun'))
    await buildMachineBundles(join(root, 'machine'))
    await mkdir(join(root, 'cli'))
    await mkdir(join(root, 'server'))
    await copyFile(join(root, 'machine/ficus.js'), join(root, 'cli/ficus.js'))
    for (const name of ['server.js', 'librust_pty.so'])
      await copyFile(join(root, 'machine', name), join(root, 'server', name))
    // Exact production wrapper with ONLY /opt/ficus relocated into the owned
    // fixture. A side-effect-free counter proves tests actually invoke it.
    const wrapper = new TextDecoder().decode(CLI_WRAPPER_BYTES).replaceAll('/opt/ficus', root)
    await writeFile(join(root, 'bin/ficus'), wrapper, { mode: 0o755 })
    await writeFile(
      join(root, 'bin/counted-ficus'),
      `#!/bin/sh\necho invoked >> '${root}/wrapper-calls'\nexec '${root}/bin/ficus' "$@"\n`,
      { mode: 0o755 }
    )
    await run(root)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function execute(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  // Own a foreground process group so failed nested runners cannot leave
  // their server children behind. Never unref; always signal, close and await.
  const proc = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  proc.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  proc.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', resolve)
  })
  const signal = (name: NodeJS.Signals) => {
    if (!proc.pid) return
    try {
      process.kill(-proc.pid, name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  let hardStop: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const timeout = setTimeout(() => {
    expired = true
    signal('SIGTERM')
    hardStop = setTimeout(() => signal('SIGKILL'), 20000)
  }, timeoutMs)
  try {
    const code = await closed
    if (expired) throw new Error('Installed-bundle validation exceeded its foreground deadline')
    return { code, output }
  } finally {
    clearTimeout(timeout)
    clearTimeout(hardStop)
    signal('SIGKILL')
    await closed.catch(() => {})
  }
}

test('PR 765 stdout-completion matrix runs the installed CLI wrapper and bundle on pinned Bun', async () => {
  await installedFixture(async (root) => {
    const bun = join(root, 'bin/bun')
    const version = await execute([bun, '--version'], root, { PATH: process.env.PATH }, 5000)
    expect(version).toEqual({ code: 0, output: '1.4.2\n' })
    const result = await execute(
      [bun, 'test', 'src/stdout-completion.test.ts'],
      join(repo, 'apps/cli'),
      {
        ...process.env,
        FICUS_CLI_TEST_WRAPPER: join(root, 'bin/counted-ficus'),
      },
      40000
    )
    expect(result.code).toBe(0)
    expect(result.output).toContain('10 pass')
    expect(result.output).toContain('0 fail')
    console.info('Installed CLI: 10 stdout-completion cases passed on Bun 1.4.2 (wrapper verified below).')
    // Ten process-level cases: file, pipe, slow pipe, UTF-8 boundary cases,
    // JSON/quiet precedence, quiet output and API failure. Source execution
    // instead of the installed wrapper cannot satisfy this assertion.
    expect(existsSync(join(root, 'wrapper-calls'))).toBe(true)
    expect((await readFile(join(root, 'wrapper-calls'), 'utf8')).trim().split('\n')).toHaveLength(10)
  })
}, 60000) // Builds real release bundles, then runs ten real subprocess/pipe cases.

test('sandbox-server package suite runs on installed Bun with the installed server bundle', async () => {
  await installedFixture(async (root) => {
    // A missing override MUST fail the existing real-process auth test. This
    // prevents a falsely-green package suite that silently runs source instead.
    const unavailable = await execute(
      [join(root, 'bin/bun'), 'test', 'src/server.test.ts', '-t', 'EXECUTOR_BIND set without a token'],
      join(repo, 'packages/sandbox-server'),
      {
        ...process.env,
        FICUS_SANDBOX_TEST_SERVER_ENTRY: join(root, 'server/missing.js'),
      },
      10000
    )
    expect(unavailable.code).not.toBe(0)
    const result = await execute(
      [join(root, 'bin/bun'), 'run', 'test'],
      join(repo, 'packages/sandbox-server'),
      {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        FICUS_SANDBOX_TEST_SERVER_ENTRY: join(root, 'server/server.js'),
        BUN_PTY_LIB: join(root, 'server/librust_pty.so'),
      },
      150000
    )
    expect(result.code).toBe(0)
    const count = discoverTests(join(repo, 'packages/sandbox-server'), ['src']).length
    expect(result.output).toContain(`Completed ${count} test files`)
    expect(result.output).toContain('Test suite passed')
    expect(result.output).not.toMatch(/\(skip\)|^\s*[1-9]\d* skip$/m)
    console.info(result.output)
  })
}, 180000) // Required full package suite is isolated/sequential (~75s), not Core's suite.

test('installed legacy bundle adopts pinned Bun after natural idle exit through normal VM ensure', async () => {
  await installedFixture(async (root) => {
    const legacy = process.env.FICUS_TEST_LEGACY_SERVER_ENTRY
    if (legacy) await copyFile(legacy, join(root, 'server/legacy.js'))
    const result = await execute(
      [
        join(root, 'bin/bun'),
        'run',
        'test',
        'src/services/sandbox/vm/manager.test.ts',
        '-t',
        'legacy installed executor',
      ],
      join(repo, 'apps/core'),
      {
        ...process.env,
        FICUS_SANDBOX_TEST_SERVER_ENTRY: join(root, 'server/server.js'),
        ...(legacy ? { FICUS_TEST_LEGACY_SERVER_ENTRY: join(root, 'server/legacy.js') } : {}),
        BUN_PTY_LIB: join(root, 'server/librust_pty.so'),
      },
      60000
    )
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('Test suite passed')
    console.info(
      'Installed legacy server: normal ensure adopted Bun 1.4.2 after natural idle exit; active/unknown work remained deferred.'
    )
  })
}, 90000) // Build installed release layout, run focused real legacy/current process proof.

test('installed server preserves box-scoped agent-visible graceful restart and unrelated work', async () => {
  await installedFixture(async (root) => {
    const result = await execute(
      [join(root, 'bin/bun'), 'run', 'test', 'src/services/sandbox/box-command-restart.test.ts'],
      join(repo, 'apps/core'),
      {
        ...process.env,
        FICUS_SANDBOX_TEST_SERVER_ENTRY: join(root, 'server/server.js'),
        BUN_PTY_LIB: join(root, 'server/librust_pty.so'),
      },
      60000
    )
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('Test suite passed')
    console.info(
      'Installed server: trusted box-scoped restart reached the agent tool/recovery boundary with zero failures; unrelated executor uninterrupted.'
    )
  })
}, 90000)

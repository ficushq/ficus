import '../../test-utils/require-test-db'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MONITOR_CREDENTIALS_NOTICE_MARKER,
  monitorCredentialsNotice,
  renderExecutionWrapper,
  writeExecutionWrappers,
} from './execution-wrappers'
import { expectCleanExit, runCapturedProcess } from '../../test-utils/captured-process'
import { LAUNCHER_SCRIPT } from '../monitors/launcher'
import { LAUNCH_PATH_FILE } from '../sandbox/launch-path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'integration-wrappers-'))
  roots.push(root)
  const wrappers = join(root, '.ficus', 'integration-bin'),
    real = join(root, 'real bin')
  mkdirSync(wrappers, { recursive: true })
  mkdirSync(real)
  writeFileSync(join(real, 'example'), '#!/bin/sh\nprintf "<%s>\\n" "$@"\nexit "${TEST_EXIT:-0}"\n', { mode: 0o755 })
  writeFileSync(
    join(real, 'ficus'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >&2\n[ "${TEST_REFUSE:-}" != yes ] || exit 79\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
    { mode: 0o755 }
  )
  return {
    root,
    wrappers,
    real,
    env: { PATH: `${wrappers}:${real}:/usr/bin:/bin`, FICUS_TOKEN: 'synthetic-agent-identity', HOME: root },
  }
}

test('executable wrapper preserves argv/status and finds real binary after duplicate and symlink PATH entries', async () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  const alias = join(f.root, 'alias')
  symlinkSync(f.wrappers, alias)
  const result = await runCapturedProcess([join(f.wrappers, 'example'), 'arg with spaces', '', '*', 'a;b'], {
    env: { ...f.env, PATH: `${f.wrappers}:${alias}:${f.wrappers}:${f.real}:/bin`, TEST_EXIT: '17' },
    timeoutMs: 3000,
  })
  expect(result).toMatchObject({ kind: 'exited', code: 17, stdout: '<arg with spaces>\n<>\n<*>\n<a;b>\n' })
  expect(result.stderr).toContain(`integration exec example --squad squad -- ${f.real}/example`)
  expect(statSync(join(f.wrappers, 'example')).mode & 0o777).toBe(0o755)
  expect(readFileSync(join(f.wrappers, 'example'), 'utf8')).not.toContain('synthetic-agent-identity')
})

test('nested non-shell subprocesses find the wrapper on PATH and refusals never run the real binary', async () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  const result = await runCapturedProcess(
    [
      process.execPath,
      '-e',
      'const c=Bun.spawn(["example", "child"], {stdout:"inherit",stderr:"inherit"}); process.exit(await c.exited)',
    ],
    { env: f.env, timeoutMs: 3000 }
  )
  expect(result).toMatchObject({ kind: 'exited', code: 0, stdout: '<child>\n' })
  expect(result.stderr).toContain('integration exec example')
  const refused = await runCapturedProcess(['example', 'child'], {
    env: { ...f.env, TEST_REFUSE: 'yes' },
    timeoutMs: 3000,
  })
  expect(refused).toMatchObject({ kind: 'exited', code: 79, stdout: '' })
})

test('human terminal passes through unchanged with exactly one stderr notice and no ficus invocation', async () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  const result = await runCapturedProcess(['example', 'login'], {
    env: { ...f.env, FICUS_TOKEN: undefined },
    timeoutMs: 3000,
  })
  expect(result).toMatchObject({
    kind: 'exited',
    code: 0,
    stdout: '<login>\n',
    stderr: 'Ficus integration credentials are only available to agents; running example without Ficus credentials.\n',
  })
})

function monitorFixture() {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  const monitorDir = join(f.root, '.ficus', 'monitors', 'monitor-id')
  mkdirSync(join(monitorDir, 'logs'), { recursive: true })
  return { ...f, monitorDir, logFile: join(monitorDir, 'logs', 'current.log') }
}

test('inside a monitor without credentials the notice reaches the monitor log once, even with stderr discarded', async () => {
  const f = monitorFixture()
  const env = { ...f.env, FICUS_TOKEN: undefined, FICUS_MONITOR_DIR: f.monitorDir, TEST_EXIT: '4' }
  for (let i = 0; i < 3; i++) {
    const result = await runCapturedProcess(['/bin/sh', '-c', 'example poll 2>/dev/null'], { env, timeoutMs: 3000 })
    // The real binary still runs unauthenticated with its own status, exactly as before.
    expect(result).toMatchObject({ kind: 'exited', code: 4, stdout: '<poll>\n', stderr: '' })
  }
  expect(readFileSync(f.logFile, 'utf8')).toBe(`${monitorCredentialsNotice('example')}\n`)
  expect(existsSync(join(f.monitorDir, MONITOR_CREDENTIALS_NOTICE_MARKER))).toBe(true)
})

test('inside a monitor with credentials, or outside any monitor, nothing is written to a monitor log', async () => {
  const f = monitorFixture()
  const credentialed = await runCapturedProcess(['example', 'poll'], {
    env: { ...f.env, FICUS_MONITOR_DIR: f.monitorDir },
    timeoutMs: 3000,
  })
  expect(credentialed).toMatchObject({ kind: 'exited', code: 0, stdout: '<poll>\n' })
  const outside = await runCapturedProcess(['example', 'poll'], {
    env: { ...f.env, FICUS_TOKEN: undefined },
    timeoutMs: 3000,
  })
  expect(outside).toMatchObject({ kind: 'exited', code: 0, stdout: '<poll>\n' })
  // A monitor dir without its logs directory is not a live monitor: never create one.
  const stray = join(f.root, 'not-a-monitor')
  mkdirSync(stray)
  const strayRun = await runCapturedProcess(['example'], {
    env: { ...f.env, FICUS_TOKEN: undefined, FICUS_MONITOR_DIR: stray },
    timeoutMs: 3000,
  })
  expect(strayRun).toMatchObject({ kind: 'exited', code: 0 })
  expect(existsSync(f.logFile)).toBe(false)
  expect(existsSync(join(f.monitorDir, MONITOR_CREDENTIALS_NOTICE_MARKER))).toBe(false)
  expect(existsSync(join(stray, MONITOR_CREDENTIALS_NOTICE_MARKER))).toBe(false)
  expect(existsSync(join(stray, 'logs'))).toBe(false)
})

test('the real monitor launcher surfaces the notice from a polling loop that hides the CLI errors', async () => {
  // The Desktop 0.5.25 shape: poll an integration CLI with stderr discarded and
  // print only on completion. Without credentials it can never complete, and
  // before this notice the monitor log stayed empty for the whole run.
  const f = monitorFixture()
  writeFileSync(join(f.monitorDir, LAUNCH_PATH_FILE), f.env.PATH)
  const script = join(f.monitorDir, 'run.sh')
  writeFileSync(script, LAUNCHER_SCRIPT, { mode: 0o755 })
  const result = await runCapturedProcess(['bash', script], {
    env: {
      PATH: f.env.PATH,
      HOME: f.root,
      FICUS_MONITOR_DIR: f.monitorDir,
      FICUS_MONITOR_CWD: f.root,
      FICUS_MONITOR_TIMEOUT_SECONDS: '30',
      TEST_EXIT: '4',
      FICUS_MONITOR_COMMAND:
        'for i in 1 2 3; do s=$(example status 2>/dev/null); case "$s" in completed*) echo done; exit 0;; esac; done; exit 9',
    },
    timeoutMs: 10_000,
  })
  expect(result).toMatchObject({ kind: 'exited', code: 9 })
  expect(readFileSync(join(f.monitorDir, 'exitCode'), 'utf8').trim()).toBe('9')
  expect(readFileSync(f.logFile, 'utf8')).toBe(`${monitorCredentialsNotice('example')}\n`)
})

test('missing real binary fails clearly without recursion', async () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'absent', providerKey: 'example' }], 'squad')
  const result = await runCapturedProcess(['absent'], { env: f.env, timeoutMs: 3000 })
  expect(result).toMatchObject({ kind: 'exited', code: 127 })
  expect(result.stderr).toContain('Cannot find real absent on PATH')
})

test('projection removes unassigned/disabled wrappers and rejects unsafe or conflicting declarations', () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  writeExecutionWrappers(f.wrappers, [], 'squad')
  expect(existsSync(join(f.wrappers, 'example'))).toBe(false)
  expect(() => renderExecutionWrapper('bad/path', 'example', 'squad')).toThrow()
  expect(() =>
    writeExecutionWrappers(
      f.wrappers,
      [
        { binary: 'example', providerKey: 'one' },
        { binary: 'example', providerKey: 'two' },
      ],
      'squad'
    )
  ).toThrow()
})

test('lookup skips distinct wrapper copies even when PATH has no core utilities', async () => {
  const f = fixture(),
    copy = join(f.root, 'other-wrappers')
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  writeExecutionWrappers(copy, [{ binary: 'example', providerKey: 'example' }], 'other-squad')
  const result = await runCapturedProcess([join(f.wrappers, 'example'), 'copied'], {
    env: { ...f.env, PATH: `${f.wrappers}:${copy}:${f.real}` },
    timeoutMs: 1500,
  })
  expect(result).toMatchObject({ kind: 'exited', code: 0, stdout: '<copied>\n' })
})

test('human pass-through does not overwrite ordinary inherited shell variables', async () => {
  const f = fixture()
  writeExecutionWrappers(f.wrappers, [{ binary: 'example', providerKey: 'example' }], 'squad')
  writeFileSync(
    join(f.real, 'example'),
    '#!/bin/sh\n[ "$directory" = parent-directory ] && [ "$candidate" = parent-candidate ]\n',
    { mode: 0o755 }
  )
  const result = await runCapturedProcess(['example'], {
    env: { ...f.env, FICUS_TOKEN: undefined, directory: 'parent-directory', candidate: 'parent-candidate' },
    timeoutMs: 3000,
  })
  expect(result).toMatchObject({ kind: 'exited', code: 0 })
})

test('ntn nested invocations select Notion and human login passes through without credentials', async () => {
  const f = fixture()
  writeFileSync(join(f.real, 'ntn'), '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
  writeExecutionWrappers(f.wrappers, [{ binary: 'ntn', providerKey: 'notion' }], 'squad')
  const child = await runCapturedProcess(
    [
      process.execPath,
      '-e',
      'const c=Bun.spawn(["ntn", "search"], {stdout:"inherit",stderr:"inherit"}); process.exit(await c.exited)',
    ],
    { env: f.env, timeoutMs: 3000 }
  )
  expect(child).toMatchObject({ kind: 'exited', code: 0, stdout: '<search>\n' })
  expect(child.stderr).toContain(`integration exec notion --squad squad -- ${f.real}/ntn search`)
  const human = await runCapturedProcess(['ntn', 'login'], {
    env: { ...f.env, FICUS_TOKEN: undefined },
    timeoutMs: 3000,
  })
  expect(human).toMatchObject({
    kind: 'exited',
    code: 0,
    stdout: '<login>\n',
    stderr: 'Ficus integration credentials are only available to agents; running ntn without Ficus credentials.\n',
  })
})

for (const [provider, binary, variable] of [
  ['notion', 'ntn', 'NOTION_API_TOKEN'],
  ['cloudflare', 'wrangler', 'CLOUDFLARE_API_TOKEN'],
  ['digitalocean', 'doctl', 'DIGITALOCEAN_ACCESS_TOKEN'],
  ['netlify', 'netlify', 'NETLIFY_AUTH_TOKEN'],
  ['railway', 'railway', 'RAILWAY_API_TOKEN'],
  ['supabase', 'supabase', 'SUPABASE_ACCESS_TOKEN'],
  ['vercel', 'vercel', 'VERCEL_TOKEN'],
] as const)
  test(`Docker, k8s, VM and host command preambles reach ${binary} wrappers from nested children`, async () => {
    const { DockerSandboxManager } = await import('../sandbox/docker/manager')
    const { buildHostPreamble, hostBinDir } = await import('../sandbox/host/env')
    const previousHomeDir = process.env.HOME_DIR
    const squad = '11111111-2222-4333-8444-555555555555'
    const f = fixture()
    process.env.HOME_DIR = f.root
    const nested = `${JSON.stringify(process.execPath)} -e 'const c=Bun.spawn([${JSON.stringify(binary)}, "search"], {stdout:"inherit",stderr:"inherit"}); process.exit(await c.exited)'`
    try {
      writeFileSync(join(f.real, binary), '#!/bin/sh\nprintf "provider-child\\n"\n', { mode: 0o755 })
      mkdirSync(hostBinDir(), { recursive: true })
      writeFileSync(join(hostBinDir(), 'ficus'), readFileSync(join(f.real, 'ficus')), { mode: 0o755 })
      for (const runtime of ['docker', 'k8s', 'vm', 'host']) {
        const workspace =
          runtime === 'host' ? join(f.root, 'workspaces', 'squads', squad) : join(f.root, runtime, 'workspace')
        const wrappers = join(workspace, '.ficus', 'integration-bin')
        writeExecutionWrappers(wrappers, [{ binary, providerKey: provider }], squad)
        let preamble: string
        if (runtime === 'docker') {
          // Generate the actual spawn-hook script with its mount mapped to the test directory.
          const manager = {
            sandboxes: new Map([
              ['fixture', { workspacePath: workspace, workspaceMount: workspace, containerId: 'fixture' }],
            ]),
            getSandboxUserArgs: () => [],
          }
          const hook = DockerSandboxManager.prototype.getSpawnHook.call(manager as any, 'fixture', workspace)!
          hook({ command: nested, cwd: workspace, env: {} })
          const scripts = (await import('node:fs')).readdirSync(join(workspace, '.tmp'))
          preamble = readFileSync(join(workspace, '.tmp', scripts[0]!), 'utf8')
        } else if (runtime === 'host') {
          preamble = buildHostPreamble({ squadId: squad, ficusToken: 'synthetic-agent-identity' }) + nested
        } else {
          // Run the real server implementation without importing its sources into Core's composite TS project.
          // Use a fixture file so captured-process diagnostic clipping cannot truncate the generated script.
          const scriptPath = join(f.root, `${runtime}-preamble.sh`)
          const generated = await runCapturedProcess(
            [
              process.execPath,
              '-e',
              'const { buildPreamble } = await import(process.argv[1]); await Bun.write(process.argv[2], buildPreamble({ sourceEnv: true, activateDevbox: true }))',
              join(import.meta.dir, '../../../../../packages/sandbox-server/src/services/bash.ts'),
              scriptPath,
            ],
            {
              env: {
                ...f.env,
                WORKSPACE_PATH: runtime === 'vm' ? join(f.root, runtime, '.private') : workspace,
                ...(runtime === 'vm' ? { FICUS_BOX_HOME: join(f.root, runtime) } : {}),
              },
              timeoutMs: 3000,
            }
          )
          expectCleanExit(generated)
          preamble = readFileSync(scriptPath, 'utf8') + nested
        }
        const result = await runCapturedProcess(['/bin/sh', '-c', preamble], {
          env: {
            ...f.env,
            PATH: `${f.real}:/usr/bin:/bin`,
            ...(runtime === 'host' ? { FICUS_IDENTITY_TOKEN: f.env.FICUS_TOKEN } : {}),
          },
          timeoutMs: 3000,
        })
        expect(result).toMatchObject({ kind: 'exited', code: 0, stdout: 'provider-child\n' })
        expect(result.stderr).toContain(`integration exec ${provider} --squad ${squad} -- ${f.real}/${binary} search`)
        expect(preamble).not.toContain(variable)
      }
    } finally {
      if (previousHomeDir === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = previousHomeDir
    }
  })

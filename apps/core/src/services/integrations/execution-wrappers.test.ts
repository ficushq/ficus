import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderExecutionWrapper, writeExecutionWrappers } from './execution-wrappers'
import { expectCleanExit, runCapturedProcess } from '../../test-utils/captured-process'

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

test('Docker, k8s, VM and host command preambles reach ntn wrappers from nested children', async () => {
  const { DockerSandboxManager } = await import('../sandbox/docker/manager')
  const { buildHostPreamble, hostBinDir } = await import('../sandbox/host/env')
  const previousHomeDir = process.env.HOME_DIR
  const squad = '11111111-2222-4333-8444-555555555555'
  const f = fixture()
  process.env.HOME_DIR = f.root
  const nested = `${JSON.stringify(process.execPath)} -e 'const c=Bun.spawn(["ntn", "search"], {stdout:"inherit",stderr:"inherit"}); process.exit(await c.exited)'`
  try {
    writeFileSync(join(f.real, 'ntn'), '#!/bin/sh\nprintf "notion-child\\n"\n', { mode: 0o755 })
    mkdirSync(hostBinDir(), { recursive: true })
    writeFileSync(join(hostBinDir(), 'ficus'), readFileSync(join(f.real, 'ficus')), { mode: 0o755 })
    for (const runtime of ['docker', 'k8s', 'vm', 'host']) {
      const workspace =
        runtime === 'host' ? join(f.root, 'workspaces', 'squads', squad) : join(f.root, runtime, 'workspace')
      const wrappers = join(workspace, '.ficus', 'integration-bin')
      writeExecutionWrappers(wrappers, [{ binary: 'ntn', providerKey: 'notion' }], squad)
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
      expect(result).toMatchObject({ kind: 'exited', code: 0, stdout: 'notion-child\n' })
      expect(result.stderr).toContain(`integration exec notion --squad ${squad} -- ${f.real}/ntn search`)
      expect(preamble).not.toContain('NOTION_API_TOKEN')
    }
  } finally {
    if (previousHomeDir === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = previousHomeDir
  }
})

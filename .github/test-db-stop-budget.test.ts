import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dir, '..')

test('manual single-process proxy respects the actual Core composite project file boundary', () => {
  const file = join(root, 'apps/core/tsconfig.json')
  const config = ts.readConfigFile(file, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'apps/core'), undefined, file)
  const proxy = join(root, 'apps/core/src/test-db.ts')
  const entry = join(root, 'scripts/test-db.ts')
  // Compile only this small import graph with Core's actual composite options
  // and declared roots; full Core checking remains CI-owned.
  const program = ts.createProgram(
    [proxy, entry, join(root, 'apps/core/src/test-utils/test-pooler.ts')].filter((path) =>
      parsed.fileNames.includes(path)
    ),
    parsed.options
  )
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error)
  expect(errors.map((d) => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)).toEqual([])
  expect(parsed.fileNames).toContain(entry)
}, 15000)

test('Docker and Compose pooler stop grace has overhead margin inside the unchanged hard deadline', async () => {
  const { testPoolerCommand, TEST_POOLER_COMMAND_TIMEOUT_MS } = await import('../apps/core/src/test-utils/test-pooler')
  for (const container of ['pgbouncer-test', undefined]) {
    const stop = testPoolerCommand({ repoRoot: root, container }, 'stop')
    expect(stop).toContain('--timeout')
    const graceMs = Number(stop[stop.indexOf('--timeout') + 1]) * 1000
    expect(graceMs).toBeGreaterThan(0)
    expect(TEST_POOLER_COMMAND_TIMEOUT_MS - graceMs).toBeGreaterThanOrEqual(5000)
    expect(TEST_POOLER_COMMAND_TIMEOUT_MS).toBe(10000)
    expect(testPoolerCommand({ repoRoot: root, container }, 'start')).not.toContain('--timeout')
  }
})

for (const failure of ['stop', 'body', 'none'] as const) {
  test(`pooler restoration runs after ${failure === 'none' ? 'a successful check' : `failed ${failure}`}`, async () => {
    const { withStoppedTestPooler } = await import('../apps/core/src/test-utils/test-pooler')
    const dir = mkdtempSync(join(tmpdir(), 'pooler-restoration-'))
    const log = join(dir, 'docker.log')
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\n${failure === 'stop' ? 'case "$*" in *stop*) echo injected-stop-failure >&2; exit 1;; esac' : ''}\nexit 0\n`,
      { mode: 0o755 }
    )
    let checked = false
    try {
      const check = withStoppedTestPooler(
        {
          repoRoot: root,
          container: 'pgbouncer-test',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log },
        },
        async () => {
          checked = true
          if (failure === 'body') throw new Error('check failed')
          return 42
        }
      )
      if (failure === 'none') expect(await check).toBe(42)
      else await expect(check).rejects.toThrow(failure === 'stop' ? 'injected-stop-failure' : 'check failed')
      expect(checked).toBe(failure !== 'stop')
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'stop --timeout 2 pgbouncer-test',
        'start pgbouncer-test',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('standalone fixture teardown and restart specify a stop grace inside its 10s command deadline', () => {
  const source = readFileSync(join(root, 'apps/core/src/db/message-enqueue-order-restart.standalone.ts'), 'utf8')
  expect(source).toContain('timeout: 10000')
  expect(source).toContain("['down', '-v', '--remove-orphans', '--timeout', '2']")
  expect(source).toContain("['restart', '--timeout', '2', 'postgres']")
})

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultExeExec,
  supportsExePosixIdentityCleaner,
  EXE_EXEC_MAX_TIMEOUT_MS,
  EXE_EXEC_TIMEOUT_ENV_VARS,
  resolveExeExecTimeoutOverrides,
  type ExeExecObservation,
} from './exe-api'

const TEST_BUDGET_MS = 30_000
/** A synthetic pin: these fake ssh binaries never check it. */
const testPin = async () => ({ knownHostsPath: '/nonexistent/known_hosts', alias: 'ficus-trust.test' })
const cleanupDirs: string[] = []

async function writeFakeSsh(body: string | ((dir: string) => string)) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-exe-lobby-'))
  cleanupDirs.push(dir)
  const scriptPath = join(dir, 'ssh')
  const resolvedBody = typeof body === 'function' ? body(dir) : body
  await Bun.write(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${resolvedBody}\n`)
  await Bun.$`chmod +x ${scriptPath}`.quiet()
  return { dir, scriptPath }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && processIsAlive(pid); attempt++) await Bun.sleep(25)
  expect(processIsAlive(pid)).toBe(false)
}

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('defaultExeExec subprocess lifecycle', () => {
  test('uses the cwd-pinned identity cleaner on both supported POSIX platforms', () => {
    expect(supportsExePosixIdentityCleaner('linux')).toBe(true)
    expect(supportsExePosixIdentityCleaner('darwin')).toBe(true)
    expect(supportsExePosixIdentityCleaner('win32')).toBe(false)
  })

  test(
    'returns stdout, stderr, and the exit code from a real subprocess',
    async () => {
      const { scriptPath } = await writeFakeSsh("printf 'result-json'; printf 'warning' >&2; exit 7")

      const result = await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([
        'ls',
        '--json',
      ])

      expect(result).toEqual({ exitCode: 7, stdout: 'result-json', stderr: 'warning' })
    },
    TEST_BUDGET_MS
  )

  test(
    'connects to exe.dev with strict checking against the pinned key only (never accept-new)',
    async () => {
      const { scriptPath } = await writeFakeSsh('printf "%s\\n" "$@"')
      const pin = async () => ({ knownHostsPath: '/pins/exe.known_hosts', alias: 'ficus-trust.exe' })

      const result = await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: pin })(['ls'])

      const argv = result.stdout.split('\n')
      expect(argv).toContain('StrictHostKeyChecking=yes')
      expect(argv).toContain('UserKnownHostsFile=/pins/exe.known_hosts')
      expect(argv).toContain('HostKeyAlias=ficus-trust.exe')
      expect(argv).toContain('GlobalKnownHostsFile=/dev/null')
      expect(result.stdout).not.toContain('accept-new')
    },
    TEST_BUDGET_MS
  )

  test(
    'never starts ssh when exe.dev has no trusted host key',
    async () => {
      const { dir, scriptPath } = await writeFakeSsh((d) => `touch ${d}/spawned`)
      const refuse = async () => {
        throw new Error('exe.dev host key not confirmed')
      }

      await expect(
        defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: refuse })(['ls'])
      ).rejects.toThrow('exe.dev host key not confirmed')
      expect(await readdir(dir)).not.toContain('spawned')
    },
    TEST_BUDGET_MS
  )

  test(
    'drains large output while bounding captured stdout and stderr',
    async () => {
      const { scriptPath } = await writeFakeSsh(
        'head -c 2097152 /dev/zero | tr "\\0" o; head -c 2097152 /dev/zero | tr "\\0" e >&2; exit 9'
      )

      const result = await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])

      expect(result.exitCode).toBe(9)
      expect(result.stdout).toEndWith('[stdout truncated]')
      expect(result.stderr).toEndWith('[stderr truncated]')
      expect(result.stdout.length).toBeLessThan(1_100_000)
      expect(result.stderr.length).toBeLessThan(1_100_000)
    },
    TEST_BUDGET_MS
  )

  test(
    'selects the typed operation budget while retaining a bounded fallback for unknown commands',
    async () => {
      const { scriptPath } = await writeFakeSsh('printf done')
      const observations: ExeExecObservation[] = []
      const exec = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        timeoutMs: 12_000,
        operationTimeoutMs: { create: 10_000, list: 11_000 },
        onObservation: (observation) => observations.push(observation),
      })

      await expect(exec(['new', '--name', 'disposable', '--json'])).resolves.toMatchObject({ stdout: 'done' })
      await expect(exec(['ls', '--json'])).resolves.toMatchObject({ stdout: 'done' })
      await expect(exec(['future-command', '--secret', 'must-not-appear'])).resolves.toMatchObject({ stdout: 'done' })

      expect(observations.map(({ operation, outcome, timeoutMs }) => ({ operation, outcome, timeoutMs }))).toEqual([
        { operation: 'create', outcome: 'success', timeoutMs: 10_000 },
        { operation: 'list', outcome: 'success', timeoutMs: 11_000 },
        { operation: 'unknown', outcome: 'success', timeoutMs: 12_000 },
      ])
      expect(JSON.stringify(observations)).not.toContain('secret')
      expect(observations.every(({ durationMs }) => typeof durationMs === 'number')).toBe(true)
    },
    TEST_BUDGET_MS
  )

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, EXE_EXEC_MAX_TIMEOUT_MS + 1])(
    'rejects invalid explicit budget %p before creating an executor',
    (timeoutMs) => {
      expect(() => defaultExeExec('private-key', { operationTimeoutMs: { create: timeoutMs } })).toThrow(RangeError)
    }
  )

  // The budgets are a bound, not a measurement — nobody has timed `ssh exe.dev
  // new` live — so the operator escape hatch below is the only way to widen a
  // deadline on a running instance without shipping code. Every case injects
  // `env` explicitly: Bun auto-loads `./.env` into `process.env` before user
  // code runs, so "absent from the ambient environment" proves nothing here.
  test(
    'applies all four operator env overrides independently',
    async () => {
      const { scriptPath } = await writeFakeSsh('printf done')
      const observations: ExeExecObservation[] = []
      const exec = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        env: {
          [EXE_EXEC_TIMEOUT_ENV_VARS.create]: '90001',
          [EXE_EXEC_TIMEOUT_ENV_VARS.destroy]: '90002',
          [EXE_EXEC_TIMEOUT_ENV_VARS.list]: '90003',
          [EXE_EXEC_TIMEOUT_ENV_VARS.clone]: '90004',
        },
        onObservation: (observation) => observations.push(observation),
      })

      await exec(['new'])
      await exec(['rm'])
      await exec(['ls'])
      await exec(['cp'])

      expect(observations.map(({ operation, timeoutMs }) => ({ operation, timeoutMs }))).toEqual([
        { operation: 'create', timeoutMs: 90_001 },
        { operation: 'destroy', timeoutMs: 90_002 },
        { operation: 'list', timeoutMs: 90_003 },
        { operation: 'clone', timeoutMs: 90_004 },
      ])
    },
    TEST_BUDGET_MS
  )

  test.each([
    ['non-numeric', '20s'],
    ['empty', ''],
    ['whitespace', '   '],
    ['signed', '+20'],
    ['exponent', '2e4'],
    ['hex', '0x20'],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['infinite', '1e400'],
    ['unsafe integer', String(Number.MAX_SAFE_INTEGER)],
    ['timer max + 1', String(EXE_EXEC_MAX_TIMEOUT_MS + 1)],
  ])('ignores a %s operator env override and emits a sanitized warning', (_label, raw) => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const overrides = resolveExeExecTimeoutOverrides({ [EXE_EXEC_TIMEOUT_ENV_VARS.create]: raw })

      expect(overrides).toEqual({})
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warning = JSON.stringify(warnSpy.mock.calls)
      expect(warning).toContain(EXE_EXEC_TIMEOUT_ENV_VARS.create)
      expect(warning).toContain('supported timer range')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not echo an arbitrary invalid env value in its warning', () => {
    const secret = `credential-${'x'.repeat(2_000)}`
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveExeExecTimeoutOverrides({ [EXE_EXEC_TIMEOUT_ENV_VARS.create]: secret })
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret)
      expect(JSON.stringify(warnSpy.mock.calls).length).toBeLessThan(2_000)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('accepts the documented timer-safe maximum', () => {
    expect(
      resolveExeExecTimeoutOverrides({
        [EXE_EXEC_TIMEOUT_ENV_VARS.create]: String(EXE_EXEC_MAX_TIMEOUT_MS),
      })
    ).toEqual({ create: EXE_EXEC_MAX_TIMEOUT_MS })
  })

  test(
    'lets explicit budgets win over env overrides for every operation',
    async () => {
      const { scriptPath } = await writeFakeSsh('printf done')
      const observations: ExeExecObservation[] = []
      const exec = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        env: {
          [EXE_EXEC_TIMEOUT_ENV_VARS.create]: '90001',
          [EXE_EXEC_TIMEOUT_ENV_VARS.destroy]: '90002',
          [EXE_EXEC_TIMEOUT_ENV_VARS.list]: '90003',
          [EXE_EXEC_TIMEOUT_ENV_VARS.clone]: '90004',
        },
        operationTimeoutMs: { create: 7_001, destroy: 7_002, list: 7_003, clone: 7_004 },
        onObservation: (observation) => observations.push(observation),
      })

      await exec(['new'])
      await exec(['rm'])
      await exec(['ls'])
      await exec(['cp'])

      expect(observations.map(({ timeoutMs }) => timeoutMs)).toEqual([7_001, 7_002, 7_003, 7_004])
    },
    TEST_BUDGET_MS
  )

  test(
    'times out after the configured deadline and completes bounded cleanup without waiting for pipe EOF',
    async () => {
      const { scriptPath } = await writeFakeSsh('sleep 30')
      const started = performance.now()

      const execution = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        timeoutMs: 50,
      })([])

      await expect(execution).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(performance.now() - started).toBeLessThan(1_500)
    },
    TEST_BUDGET_MS
  )

  test(
    'bounds stream cancellation when a reader cancel never settles',
    async () => {
      const originalGetReader = ReadableStream.prototype.getReader
      const getReaderSpy = spyOn(ReadableStream.prototype, 'getReader').mockImplementation(function (
        this: ReadableStream<unknown>
      ) {
        const reader = originalGetReader.call(this) as ReadableStreamDefaultReader<unknown>
        return {
          read: reader.read.bind(reader),
          cancel: () => new Promise<void>(() => {}),
          releaseLock: reader.releaseLock.bind(reader),
          get closed() {
            return reader.closed
          },
        } as ReadableStreamDefaultReader<unknown>
      } as typeof ReadableStream.prototype.getReader)
      const { scriptPath } = await writeFakeSsh('sleep 30')
      const started = performance.now()

      try {
        const outcome = await Promise.race([
          defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin, timeoutMs: 50 })([]).then(
            () => 'resolved',
            (error: Error) => error.name
          ),
          Bun.sleep(1_000).then(() => 'stalled'),
        ])
        expect(outcome).toBe('TimeoutError')
        expect(performance.now() - started).toBeLessThan(1_000)
      } finally {
        getReaderSpy.mockRestore()
      }
    },
    TEST_BUDGET_MS
  )

  test(
    'kills a spawned process when output setup throws',
    async () => {
      const originalSpawn = Bun.spawn
      const { scriptPath } = await writeFakeSsh('sleep 30')
      let spawnedPid: number | undefined
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        const proc = originalSpawn(...args)
        if ((args[0] as string[])[0] !== scriptPath) return proc
        spawnedPid = proc.pid
        return {
          pid: proc.pid,
          exited: proc.exited,
          kill: proc.kill.bind(proc),
          stdout: {
            getReader: () => {
              throw new Error('injected reader setup failure')
            },
          },
          stderr: proc.stderr,
        } as unknown as ReturnType<typeof Bun.spawn>
      }) as typeof Bun.spawn)
      const before = (await readdir(tmpdir())).filter((name) => name.startsWith('exe-lobby-')).sort()

      try {
        await expect(
          defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])
        ).rejects.toThrow('injected reader setup failure')
      } finally {
        spawnSpy.mockRestore()
      }

      expect(spawnedPid).toBeNumber()
      await expectProcessGone(spawnedPid!)
      const after = (await readdir(tmpdir())).filter((name) => name.startsWith('exe-lobby-')).sort()
      expect(after).toEqual(before)
    },
    TEST_BUDGET_MS
  )

  test(
    'kills descendants on timeout',
    async () => {
      const { dir, scriptPath } = await writeFakeSsh(
        (fixtureDir) => `sleep 30 &\necho $! > "${join(fixtureDir, 'child.pid')}"\nwait $!`
      )
      const execution = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        timeoutMs: 1_000,
      })([])
      const pidPath = join(dir, 'child.pid')
      for (let attempt = 0; attempt < 40 && !(await Bun.file(pidPath).exists()); attempt++) await Bun.sleep(25)
      const childPid = Number((await readFile(pidPath, 'utf8')).trim())

      await expect(execution).rejects.toMatchObject({ name: 'TimeoutError' })
      await expectProcessGone(childPid)
    },
    TEST_BUDGET_MS
  )

  test(
    'aborts predictably and kills descendants',
    async () => {
      const controller = new AbortController()
      const { dir, scriptPath } = await writeFakeSsh(
        (fixtureDir) => `sleep 30 &\necho $! > "${join(fixtureDir, 'child.pid')}"\nwait $!`
      )
      const execution = defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        timeoutMs: 10_000,
        signal: controller.signal,
      })([])
      const pidPath = join(dir, 'child.pid')
      for (let attempt = 0; attempt < 40 && !(await Bun.file(pidPath).exists()); attempt++) await Bun.sleep(25)
      const childPid = Number((await readFile(pidPath, 'utf8')).trim())

      controller.abort()

      await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
      await expectProcessGone(childPid)
    },
    TEST_BUDGET_MS
  )

  test(
    'observes cancellation that happens while the invocation is starting',
    async () => {
      const controller = new AbortController()
      const { scriptPath } = await writeFakeSsh('sleep 30')
      const spawnSpy = spyOn(Bun, 'spawn')
      try {
        const execution = defaultExeExec('private-key', {
          sshBin: scriptPath,
          resolveHostKeyPin: testPin,
          timeoutMs: 2_000,
          signal: controller.signal,
        })([])

        controller.abort()

        const started = performance.now()
        await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
        expect(performance.now() - started).toBeLessThan(1_000)
        expect(spawnSpy.mock.calls.some((call) => (call[0] as string[])[0] === scriptPath)).toBe(false)
      } finally {
        spawnSpy.mockRestore()
      }
    },
    TEST_BUDGET_MS
  )

  test(
    'does not let a timeout scheduled after exit overwrite a near-budget exit',
    async () => {
      const { scriptPath } = await writeFakeSsh('sleep 0.04; printf done')

      const result = await defaultExeExec('private-key', {
        sshBin: scriptPath,
        resolveHostKeyPin: testPin,
        timeoutMs: 500,
      })([])

      expect(result).toEqual({ exitCode: 0, stdout: 'done', stderr: '' })
    },
    TEST_BUDGET_MS
  )

  test(
    'cleans up descendants after a normal parent exit',
    async () => {
      const { dir, scriptPath } = await writeFakeSsh(
        (fixtureDir) => `sleep 30 &\necho $! > "${join(fixtureDir, 'child.pid')}"`
      )

      const result = await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])
      const childPid = Number((await readFile(join(dir, 'child.pid'), 'utf8')).trim())

      expect(result.exitCode).toBe(0)
      await expectProcessGone(childPid)
    },
    TEST_BUDGET_MS
  )

  test(
    'preserves unrelated shared-tmp paths when cleaning its owned identity directory',
    async () => {
      const unrelatedDir = await mkdtemp(join(tmpdir(), 'exe-lobby-unrelated-'))
      cleanupDirs.push(unrelatedDir)
      const sentinel = join(unrelatedDir, 'keep')
      await writeFile(sentinel, 'preserve me')
      const { scriptPath } = await writeFakeSsh('exit 0')

      await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me')
    },
    TEST_BUDGET_MS
  )

  test(
    'does not recursively delete a directory swapped into its owned tmp path',
    async () => {
      const movedPathFile = join(await mkdtemp(join(tmpdir(), 'exe-lobby-swap-fixture-')), 'moved-path')
      cleanupDirs.push(join(movedPathFile, '..'))
      const { scriptPath } = await writeFakeSsh(`identity=''
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == '-i' ]]; then j=$((i+1)); identity="\${!j}"; break; fi
done
owned="$(dirname "$identity")"
moved="\${owned}-moved"
mv "$owned" "$moved"
printf '%s' "$moved" > "${movedPathFile}"
mkdir "$owned"
printf preserve > "$owned/unrelated"
printf 'foreign identity' > "$owned/id"`)

      await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])

      const moved = await readFile(movedPathFile, 'utf8')
      cleanupDirs.push(moved, moved.slice(0, -'-moved'.length))
      await expect(readFile(join(moved.slice(0, -'-moved'.length), 'unrelated'), 'utf8')).resolves.toBe('preserve')
      await expect(readFile(join(moved.slice(0, -'-moved'.length), 'id'), 'utf8')).resolves.toBe('foreign identity')
      expect(await Bun.file(join(moved, 'id')).exists()).toBe(false)
    },
    TEST_BUDGET_MS
  )

  test(
    'unlinks a replaced identity symlink without deleting its unrelated target',
    async () => {
      const unrelatedDir = await mkdtemp(join(tmpdir(), 'exe-lobby-target-'))
      cleanupDirs.push(unrelatedDir)
      const sentinel = join(unrelatedDir, 'keep')
      await writeFile(sentinel, 'preserve me')
      const { scriptPath } = await writeFakeSsh(`identity=''
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == '-i' ]]; then j=$((i+1)); identity="\${!j}"; break; fi
done
rm -f "$identity"
ln -s "${sentinel}" "$identity"`)

      await defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })([])

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me')
    },
    TEST_BUDGET_MS
  )

  test(
    'removes temporary identities after success, failure, and timeout',
    async () => {
      const before = (await readdir(tmpdir())).filter((name) => name.startsWith('exe-lobby-')).sort()
      const success = await writeFakeSsh('exit 0')
      await defaultExeExec('private-key', { sshBin: success.scriptPath, resolveHostKeyPin: testPin })([])
      const failure = await writeFakeSsh('exit 8')
      await defaultExeExec('private-key', { sshBin: failure.scriptPath, resolveHostKeyPin: testPin })([])
      const timeout = await writeFakeSsh('sleep 30')
      await expect(
        defaultExeExec('private-key', { sshBin: timeout.scriptPath, resolveHostKeyPin: testPin, timeoutMs: 50 })([])
      ).rejects.toMatchObject({ name: 'TimeoutError' })

      const after = (await readdir(tmpdir())).filter((name) => name.startsWith('exe-lobby-')).sort()
      expect(after).toEqual(before)
    },
    TEST_BUDGET_MS
  )

  test(
    'remains stable under repeated concurrent execution',
    async () => {
      const { scriptPath } = await writeFakeSsh('printf ok')
      const exec = defaultExeExec('private-key', { sshBin: scriptPath, resolveHostKeyPin: testPin })

      const results = await Promise.all(Array.from({ length: 24 }, (_, index) => exec([String(index)])))

      expect(results).toEqual(Array.from({ length: 24 }, () => ({ exitCode: 0, stdout: 'ok', stderr: '' })))
    },
    TEST_BUDGET_MS
  )
})

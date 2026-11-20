import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAmtpCliJson, runScopedCliProcess } from './node-conformance-cli'
import { runFileCapturedProcess } from './node-conformance-process'
import { ScenarioScope } from './node-conformance-scenario'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('runScopedCliProcess', () => {
  test('scope abort cancels and joins a hung nonexistent-recipient child before resource disposal', async () => {
    const captureDir = await mkdtemp(join(tmpdir(), 'amtp-scoped-cli-'))
    temporaryDirectories.push(captureDir)
    const scope = new ScenarioScope('concurrent-nonexistent-recipient', { cleanupTimeoutMs: 1_000 })
    const operation = scope.operation('cli', 'amtp-cli:send-nonexistent')
    let childError: unknown
    let disposed = false

    const cliProcess = runScopedCliProcess({
      scope,
      operation,
      run: (signal) =>
        runFileCapturedProcess(['bun', '-e', 'setInterval(() => {}, 1_000)'], {
          phase: 'amtp-cli:send-nonexistent',
          timeoutMs: 250,
          captureDir,
          signal,
        }).catch((error: unknown) => {
          childError = error
          throw error
        }),
    })
    const settledProcess = cliProcess.catch((error: unknown) => error)

    scope.own({
      kind: 'nonexistent-recipient-fixture',
      id: 'sentinel',
      dispose: async () => {
        expect(childError).toMatchObject({
          code: 'SUBPROCESS_PHASE_CANCELLED',
          phase: 'amtp-cli:send-nonexistent',
        })
        expect(() => process.kill((childError as { pid: number }).pid, 0)).toThrow()
        expect(await readdir(captureDir)).toEqual([])
        expect(scope.snapshot().operations).toBe(0)
        disposed = true
      },
      assertGone: async () => expect(disposed).toBe(true),
    })

    const disposal = scope.dispose()
    const [error] = await Promise.all([settledProcess, disposal])

    expect(error).toMatchObject({
      code: 'SUBPROCESS_PHASE_CANCELLED',
      phase: 'amtp-cli:send-nonexistent',
    })
    expect(scope.snapshot()).toEqual({ resources: 0, operations: 0, aborted: true })
  })
})

describe('parseAmtpCliJson', () => {
  test('returns the parsed document for complete JSON stdout', () => {
    expect(
      parseAmtpCliJson(['peer', 'add'], { stdout: '{\n  "alias": "ficus"\n}\n', stderr: '', exitCode: 0 })
    ).toEqual({ alias: 'ficus' })
  })

  test('names the command and shows the raw stdout and stderr when stdout is not one JSON document', () => {
    const stdout = '{"alias":"ficus"}\n}\u0000'
    let error: unknown
    try {
      parseAmtpCliJson(['peer', 'add', '--alias', 'ficus'], { stdout, stderr: 'phase trace\n', exitCode: 0 })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('amtp peer add --alias ficus printed stdout that is not one JSON document (exit 0)')
    expect(message).toContain('JSON Parse error')
    // JSON-quoted so trailing bytes, control characters and whitespace stay visible in CI logs.
    expect(message).toContain(`raw stdout (${Buffer.byteLength(stdout)} bytes)=${JSON.stringify(stdout)}`)
    expect(message).toContain(`stderr (12 bytes)=${JSON.stringify('phase trace\n')}`)
    expect((error as Error).cause).toBeInstanceOf(SyntaxError)
  })

  test('keeps the tail of very large captures', () => {
    const stdout = `${'x'.repeat(20_000)}END`
    const message = (() => {
      try {
        parseAmtpCliJson(['init'], { stdout, stderr: '', exitCode: 0 })
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()

    expect(message).toContain('raw stdout (20003 bytes, last 8192 shown)=')
    expect(message).toContain('END"')
    expect(message.length).toBeLessThan(9_000)
  })
})

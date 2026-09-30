import { describe, expect, it } from 'bun:test'
import { defaultRunner, recordingRunner } from './runner'

describe('defaultRunner', () => {
  it('resolves with code 127 and non-empty stderr when binary is missing', async () => {
    const result = await defaultRunner(['definitely-not-a-real-binary-xyz', '--version'])
    expect(result.code).toBe(127)
    expect(result.stdout).toBe('')
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('resolves with code 0 and captured stdout for a real successful command', async () => {
    const result = await defaultRunner(['sh', '-c', 'printf hello'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('')
  })

  it('lays options.env over the process env and removes a key mapped to undefined', async () => {
    process.env.FICUS_RUNNER_TEST_STALE = 'stale'
    process.env.FICUS_RUNNER_TEST_KEPT = 'kept'
    try {
      const result = await defaultRunner(
        [
          'sh',
          '-c',
          'printf "%s|%s|%s" "${FICUS_RUNNER_TEST_STALE-unset}" "$FICUS_RUNNER_TEST_KEPT" "$FICUS_RUNNER_TEST_NEW"',
        ],
        { env: { FICUS_RUNNER_TEST_STALE: undefined, FICUS_RUNNER_TEST_NEW: 'new' } }
      )
      expect(result.stdout).toBe('unset|kept|new')
    } finally {
      delete process.env.FICUS_RUNNER_TEST_STALE
      delete process.env.FICUS_RUNNER_TEST_KEPT
    }
  })

  it('resolves with non-zero exit code', async () => {
    const result = await defaultRunner(['sh', '-c', 'exit 3'])
    expect(result.code).toBe(3)
  })
})

describe('recordingRunner', () => {
  it('records calls and answers from prefix-matched response', async () => {
    const { runner, calls } = recordingRunner({
      echo: { code: 0, stdout: 'hello', stderr: '' },
    })

    const result = await runner(['echo', 'test'], { cwd: '/tmp' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')

    expect(calls.length).toBe(1)
    expect(calls[0].command).toEqual(['echo', 'test'])
    expect(calls[0].options.cwd).toBe('/tmp')
  })
})

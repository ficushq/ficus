import { describe, expect, test } from 'bun:test'
import { parseDockerCommandIdentity, resolveDockerCommandIdentity } from './command-identity'
import { DockerSandboxCompatibilityError, DockerSandboxLifecycleError } from './errors'

const contract = { version: 1, user: 'ficus', home: '/home/ficus', uid: 1000, gid: 1000 } as const

describe('Docker command identity', () => {
  test('strictly parses and deterministically fingerprints the contract', () => {
    const a = parseDockerCommandIdentity(JSON.stringify(contract))
    const b = parseDockerCommandIdentity('{"gid":1000,"uid":1000,"home":"/home/ficus","user":"ficus","version":1}')
    expect(a).toEqual(b)
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  test('uses only a complete safe host identity pair', () => {
    expect(resolveDockerCommandIdentity(contract, { uid: 501, gid: 20 })).toMatchObject({
      user: 'ficus',
      home: '/home/ficus',
      source: 'host',
      resolvedUid: 501,
      resolvedGid: 20,
    })
    for (const host of [
      { uid: 0, gid: 0 },
      { uid: 501 },
      { gid: 20 },
      { uid: -1, gid: 20 },
      { uid: 1.2, gid: 20 },
      { uid: Number.MAX_SAFE_INTEGER + 1, gid: 20 },
      { uid: 65534, gid: 65534 },
      {},
    ]) {
      expect(resolveDockerCommandIdentity(contract, host)).toMatchObject({
        source: 'image',
        resolvedUid: 1000,
        resolvedGid: 1000,
      })
    }
  })

  test('rejects malformed, unsafe, and extended contracts', () => {
    for (const value of [
      {},
      { ...contract, version: 2 },
      { ...contract, user: 'root' },
      { ...contract, home: '/root' },
      { ...contract, uid: 0 },
      { ...contract, gid: 65534 },
      { ...contract, extra: true },
    ])
      expect(() => parseDockerCommandIdentity(JSON.stringify(value))).toThrow()
  })
})

describe('Docker typed errors', () => {
  test('exposes stable codes and only safe bounded context', () => {
    const secret = 'EXECUTOR_AUTH_TOKEN=super-secret'
    const cause = new Error(secret)
    const error = new DockerSandboxLifecycleError({
      operation: 'stop',
      sandboxId: 'agent-safe',
      reason: 'STOP_FAILED',
      stderr: `${secret}\nBearer abcdef`,
      cause,
    })
    expect(error.name).toBe('DockerSandboxLifecycleError')
    expect(error.code).toBe('STOP_FAILED')
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error)).not.toContain('super-secret')
    expect(error.stderr).not.toContain('abcdef')
    expect(error.stderr!.length).toBeLessThanOrEqual(512)
  })

  test('compatibility error includes an actionable rebuild command', () => {
    const error = new DockerSandboxCompatibilityError({
      operation: 'inspect-image',
      reason: 'IMAGE_REBUILD_REQUIRED',
      containerName: 'ficus-sandbox-safe',
    })
    expect(error.message).toContain('bun run sandbox:build:docker')
    expect(error.code).toBe('IMAGE_REBUILD_REQUIRED')
  })
})

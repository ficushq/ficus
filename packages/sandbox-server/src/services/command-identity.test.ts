import { describe, expect, test } from 'bun:test'
import { commandSpawn, readExecutorCommandIdentity } from './command-identity'
const digest = 'a'.repeat(64)
describe('executor Docker command identity', () => {
  test('is opt-in and preserves direct bash otherwise', () =>
    expect(commandSpawn(undefined, 'id')).toEqual({ executable: 'bash', args: ['-c', 'id'] }))
  test('uses an execing named-user launcher', () => {
    const identity = readExecutorCommandIdentity({
      EXECUTOR_DOCKER_RUNTIME: '1',
      EXECUTOR_COMMAND_USER: 'tau',
      EXECUTOR_COMMAND_HOME: '/home/tau',
      EXECUTOR_COMMAND_UID: '1000',
      EXECUTOR_COMMAND_GID: '1000',
      EXECUTOR_COMMAND_CONTRACT_DIGEST: digest,
    })!
    expect(commandSpawn(identity, 'id')).toEqual({ executable: 'su-exec', args: ['tau', 'bash', '-c', 'id'] })
  })
  test('fails closed for root or partial Docker configuration', () => {
    expect(() => readExecutorCommandIdentity({ EXECUTOR_DOCKER_RUNTIME: '1', EXECUTOR_COMMAND_USER: 'tau' })).toThrow()
    expect(() =>
      readExecutorCommandIdentity({
        EXECUTOR_DOCKER_RUNTIME: '1',
        EXECUTOR_COMMAND_USER: 'tau',
        EXECUTOR_COMMAND_HOME: '/home/tau',
        EXECUTOR_COMMAND_UID: '0',
        EXECUTOR_COMMAND_GID: '0',
        EXECUTOR_COMMAND_CONTRACT_DIGEST: digest,
      })
    ).toThrow()
  })
})

import { describe, expect, test } from 'bun:test'
import { SANDBOX_IDENTITY_WRITE } from '../identity-names'
import { DockerSandboxCompatibilityError, DockerSandboxLifecycleError } from './errors'
import { classifyDockerContainerOwnership, classifyDockerInspectStatus } from './lifecycle-contract'
import {
  activeDriftError,
  cleanupFailedInitialization,
  cleanupTrackedSandboxes,
  dockerExecWithStdinArgs,
  immutableLifecycleTarget,
  releaseTrackedState,
  runDestructiveLifecycle,
  runWithPrimaryCleanup,
  type ContainerState,
} from './lifecycle-runtime'

const id = 'a'.repeat(64)
const sandboxId = 'agent_test'
const containerName = `${SANDBOX_IDENTITY_WRITE.containerPrefix}${sandboxId}`
const result = (exitCode: number, stderr = '') => ({ exitCode, stderr: Buffer.from(stderr) })

function lifecycle(options: {
  operation?: 'stop' | 'remove'
  execute?: () => ReturnType<typeof result>
  state?: ContainerState
  release?: () => void
}) {
  return () =>
    runDestructiveLifecycle({
      operation: options.operation ?? 'stop',
      sandboxId,
      immutableId: id,
      containerName,
      execute: options.execute ?? (() => result(0)),
      inspect: () => options.state ?? (options.operation === 'remove' ? 'not_found' : 'stopped'),
      release: options.release ?? (() => {}),
    })
}

describe('Docker lifecycle contract', () => {
  test('immutable lifecycle target cannot fall back to a mutable name', () => {
    expect(immutableLifecycleTarget(id)).toBe(id)
  })

  test('stops the immutable inspected ID, proves stopped, then closes/deletes state', () => {
    const events: string[] = []
    lifecycle({
      execute: () => (events.push(`stop:${id}`), result(0)),
      state: 'stopped',
      release: () => events.push('release'),
    })()
    expect(events).toEqual([`stop:${id}`, 'release'])
  })

  test('removes the immutable inspected ID and requires exact absence', () => {
    const events: string[] = []
    lifecycle({
      operation: 'remove',
      execute: () => (events.push(`remove:${id}`), result(0)),
      state: 'not_found',
      release: () => events.push('release'),
    })()
    expect(events).toEqual([`remove:${id}`, 'release'])
  })

  test.each([
    ['nonzero stop', 'stop', () => result(1, 'denied'), 'stopped'],
    [
      'thrown stop',
      'stop',
      () => {
        throw new Error('spawn')
      },
      'stopped',
    ],
    ['unknown stop postcondition', 'stop', () => result(0), 'unknown'],
    ['still running', 'stop', () => result(0), 'running'],
    ['nonzero remove', 'remove', () => result(1, 'denied'), 'stopped'],
    [
      'thrown remove',
      'remove',
      () => {
        throw new Error('spawn')
      },
      'not_found',
    ],
    ['unknown remove postcondition', 'remove', () => result(0), 'unknown'],
    ['still-present remove', 'remove', () => result(0), 'stopped'],
  ] as const)('%s retains tracked state and throws typed', (_name, operation, execute, state) => {
    let released = false
    expect(lifecycle({ operation, execute, state, release: () => void (released = true) })).toThrow(
      DockerSandboxLifecycleError
    )
    expect(released).toBe(false)
  })

  test('client-close failure is typed, ordered after the postcondition, and retains state', () => {
    let deleted = false
    expect(() =>
      releaseTrackedState({
        sandboxId,
        containerId: id,
        close: () => {
          throw new Error('close')
        },
        deleteState: () => void (deleted = true),
      })
    ).toThrow(expect.objectContaining({ code: 'CLEANUP_UNPROVEN', operation: 'close-client' }))
    expect(deleted).toBe(false)
  })

  test('failed initialization cleanup orders remove before client-close and aggregates both', async () => {
    const events: string[] = []
    const error = (await cleanupFailedInitialization({
      remove: async () => {
        events.push('remove')
        throw new Error('remove')
      },
      isTracked: () => true,
      close: () => {
        events.push('close')
        throw new Error('close')
      },
    }).catch((caught: unknown) => caught)) as AggregateError
    expect(events).toEqual(['remove', 'close'])
    expect(error.errors.map((cause: Error) => cause.message)).toEqual(['remove', 'close'])
  })

  test('active identity drift is distinguished behaviorally from legacy compatibility drift', () => {
    const identity = new DockerSandboxCompatibilityError({ operation: 'health', reason: 'IDENTITY_MISMATCH' })
    const protocol = new DockerSandboxCompatibilityError({ operation: 'health', reason: 'PROTOCOL_MISMATCH' })
    expect(activeDriftError(identity, sandboxId, id)).toMatchObject({ code: 'SECURITY_DRIFT_ACTIVE' })
    expect(activeDriftError(protocol, sandboxId, id)).toMatchObject({ code: 'LEGACY_RECREATION_DEFERRED' })
  })

  test('stdin execution behavior includes the exact command-user boundary', () => {
    expect(dockerExecWithStdinArgs('container', '/workspace', ['--user', 'tau'], ['tee', '/workspace/file'])).toEqual([
      'docker',
      'exec',
      '-i',
      '--user',
      'tau',
      '-w',
      '/workspace',
      'container',
      'tee',
      '/workspace/file',
    ])
  })

  test('ownership rejects a labeled neighbor and unknown Docker state is not absence', () => {
    const labels = {
      [SANDBOX_IDENTITY_WRITE.managedLabel]: 'true',
      [SANDBOX_IDENTITY_WRITE.sandboxIdLabel]: 'neighbor',
    }
    expect(classifyDockerContainerOwnership({ Name: `/${containerName}`, Config: { Labels: labels } }, sandboxId)).toBe(
      'unproven'
    )
    expect(classifyDockerInspectStatus(1, 'daemon unavailable')).toBe('unknown')
    expect(classifyDockerInspectStatus(1, 'No such container')).toBe('not_found')
  })

  test('preserves the initialization failure first and orders secondary cleanup causes', async () => {
    const primary = new Error('connect failed')
    const secondary = new Error('remove failed')
    const thrown = await runWithPrimaryCleanup(
      async () => {
        throw primary
      },
      async () => {
        throw secondary
      }
    ).catch((error: unknown) => error as AggregateError)
    expect(thrown.cause).toBe(primary)
    expect(thrown.errors).toEqual([primary, secondary])
  })

  test('rethrows the primary failure when cleanup succeeds', async () => {
    const primary = new Error('initialize')
    await expect(
      runWithPrimaryCleanup(
        async () => {
          throw primary
        },
        async () => {}
      )
    ).rejects.toBe(primary)
  })

  test('returns the initialized value without invoking cleanup', async () => {
    let cleaned = false
    await expect(
      runWithPrimaryCleanup(
        async () => 'ready',
        async () => void (cleaned = true)
      )
    ).resolves.toBe('ready')
    expect(cleaned).toBe(false)
  })

  test('cleanup attempts all entries and reports every failure', async () => {
    const attempted: string[] = []
    await expect(
      cleanupTrackedSandboxes(['a', 'b'], async (key) => {
        attempted.push(key)
        throw new Error(key)
      })
    ).rejects.toBeInstanceOf(AggregateError)
    expect(attempted.sort()).toEqual(['a', 'b'])
  })
})

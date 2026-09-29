import { describe, expect, test } from 'bun:test'
import { computeDockerSpecDigest, parseDockerImageContract, validateDockerHealthContract } from './runtime-contract'
const id = `sha256:${'a'.repeat(64)}`
const labels = {
  'io.hiretau.sandbox.managed': 'true',
  'io.hiretau.sandbox.runtime-contract': '1',
  'io.hiretau.sandbox.executor-protocol': '1',
  'io.hiretau.sandbox.command-contract': '1',
}
describe('Docker runtime contract', () => {
  test('same-tag immutable image and executor protocol drift change the canonical spec', () => {
    const base = {
      imageReference: 'ficus:latest',
      imageId: `sha256:${'a'.repeat(64)}`,
      runtimeContractVersion: 1 as const,
      executorProtocolVersion: 1 as const,
      commandIdentityFingerprint: 'ficus:1000:1000:image',
      runtime: 'docker-socket',
      workspacePath: '/workspace',
      privateVolumePath: null,
      squadId: null,
      volumes: ['/b:/b', '/a:/a'],
      shmSize: '512m',
    }
    expect(computeDockerSpecDigest(base)).toBe(
      computeDockerSpecDigest({ ...base, volumes: [...base.volumes].reverse() })
    )
    expect(computeDockerSpecDigest(base)).not.toBe(
      computeDockerSpecDigest({ ...base, imageId: `sha256:${'b'.repeat(64)}` })
    )
    expect(computeDockerSpecDigest(base)).not.toBe(
      computeDockerSpecDigest({ ...base, executorProtocolVersion: 2 as any })
    )
    expect(computeDockerSpecDigest({ ...base, lifecycleGeneration: 'generation-a' })).not.toBe(
      computeDockerSpecDigest({ ...base, lifecycleGeneration: 'generation-b' })
    )
  })
  test('requires immutable image identity and exact labels', () => {
    expect(parseDockerImageContract('tau-sandbox:latest', [{ Id: id, Config: { Labels: labels } }])).toMatchObject({
      imageId: id,
      runtimeContractVersion: 1,
    })
    const missingManaged = { ...labels }
    delete (missingManaged as Partial<typeof labels>)['io.hiretau.sandbox.managed']
    const missingRuntime = { ...labels }
    delete (missingRuntime as Partial<typeof labels>)['io.hiretau.sandbox.runtime-contract']
    const missingExecutor = { ...labels }
    delete (missingExecutor as Partial<typeof labels>)['io.hiretau.sandbox.executor-protocol']
    const missingCommand = { ...labels }
    delete (missingCommand as Partial<typeof labels>)['io.hiretau.sandbox.command-contract']
    for (const inspect of [
      [],
      [{ Id: 'tag', Config: { Labels: labels } }],
      [{ Id: id, Config: { Labels: {} } }],
      [{ Id: id, Config: { Labels: missingManaged } }],
      [{ Id: id, Config: { Labels: missingRuntime } }],
      [{ Id: id, Config: { Labels: missingExecutor } }],
      [{ Id: id, Config: { Labels: missingCommand } }],
    ])
      expect(() => parseDockerImageContract('image', inspect)).toThrow('bun run sandbox:build:docker')
  })
  test('requires exact non-root executor capabilities and identity', () => {
    const digest = 'b'.repeat(64)
    const health = {
      runtimeContract: {
        runtime: 'docker',
        version: 1,
        executorProtocol: 1,
        capabilities: ['bash', 'bash-cancel', 'command-identity', 'socket-proxy'],
        commandIdentity: {
          user: 'tau' as const,
          home: '/home/tau' as const,
          uid: 1000,
          gid: 1000,
          source: 'image' as const,
          contractDigest: digest,
        },
      },
    }
    expect(() => validateDockerHealthContract(health, health.runtimeContract.commandIdentity)).not.toThrow()
    expect(() => validateDockerHealthContract({}, health.runtimeContract.commandIdentity)).toThrow(
      expect.objectContaining({ code: 'EXECUTOR_MISSING' })
    )
    expect(() =>
      validateDockerHealthContract(
        { runtimeContract: { ...health.runtimeContract, capabilities: ['bash'] } },
        health.runtimeContract.commandIdentity
      )
    ).toThrow()
    expect(() =>
      validateDockerHealthContract(
        {
          runtimeContract: {
            ...health.runtimeContract,
            commandIdentity: { ...health.runtimeContract.commandIdentity, uid: 0 },
          },
        },
        health.runtimeContract.commandIdentity
      )
    ).toThrow()
    expect(() =>
      validateDockerHealthContract(
        { runtimeContract: { ...health.runtimeContract, executorProtocol: 2 } },
        health.runtimeContract.commandIdentity
      )
    ).toThrow()
    expect(() =>
      validateDockerHealthContract(
        {
          runtimeContract: {
            ...health.runtimeContract,
            commandIdentity: { ...health.runtimeContract.commandIdentity, user: 'root' },
          },
        },
        health.runtimeContract.commandIdentity
      )
    ).toThrow()
    expect(() =>
      validateDockerHealthContract(
        {
          runtimeContract: {
            ...health.runtimeContract,
            commandIdentity: { ...health.runtimeContract.commandIdentity, home: '/root' },
          },
        },
        health.runtimeContract.commandIdentity
      )
    ).toThrow()
    for (const commandIdentity of [
      { ...health.runtimeContract.commandIdentity, uid: 1001 },
      { ...health.runtimeContract.commandIdentity, gid: 1001 },
      { ...health.runtimeContract.commandIdentity, source: 'host' },
      { ...health.runtimeContract.commandIdentity, contractDigest: 'c'.repeat(64) },
    ]) {
      expect(() => validateDockerHealthContract(health, commandIdentity as any)).toThrow()
    }
  })
})

import { describe, it, expect } from 'bun:test'
import { getHealthResponse } from './health'

describe('getHealthResponse', () => {
  it('should return health info', () => {
    const res = getHealthResponse()
    expect(res.healthy).toBe(true)
    expect(res.version).toBeDefined()
    expect(typeof res.uptimeSeconds).toBe('number')
  })

  it('adds a non-secret runtime contract only for Docker', () => {
    const legacy = getHealthResponse({})
    expect(legacy).not.toHaveProperty('runtimeContract')
    const docker = getHealthResponse({
      EXECUTOR_DOCKER_RUNTIME: '1',
      EXECUTOR_COMMAND_USER: 'tau',
      EXECUTOR_COMMAND_HOME: '/home/tau',
      EXECUTOR_COMMAND_UID: '1000',
      EXECUTOR_COMMAND_GID: '1000',
      EXECUTOR_COMMAND_CONTRACT_DIGEST: 'a'.repeat(64),
    })
    expect(docker.runtimeContract).toMatchObject({
      runtime: 'docker',
      version: 1,
      executorProtocol: 1,
      commandIdentity: { user: 'tau', uid: 1000 },
    })
    expect(JSON.stringify(docker)).not.toContain('TOKEN')
  })
})

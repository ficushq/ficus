import { afterEach, describe, expect, it } from 'bun:test'
import { detectProvider, getSystemLogProvider, type SystemLogFactoryDependencies } from './factory'
import { DockerLogProvider } from './docker-provider'
import { K8sLogProvider } from './k8s-provider'
import { Pm2LogProvider } from './pm2-provider'
import { UnavailableLogProvider } from './unavailable-provider'

describe('system log provider selection', () => {
  const originalEnv = { ...process.env }
  const pm2Processes = (...names: string[]): SystemLogFactoryDependencies => ({
    listPm2Processes: () => ({ exitCode: 0, stdout: JSON.stringify(names.map((name) => ({ name }))) }),
  })
  const pm2Unavailable: SystemLogFactoryDependencies = {
    listPm2Processes: () => ({ exitCode: 127, stdout: '' }),
  }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('selects explicitly configured k8s targets', () => {
    process.env.FICUS_SYSTEM_LOG_PROVIDER = 'k8s'
    process.env.FICUS_SYSTEM_LOG_K8S_NAMESPACE = 'tau-core'
    expect(detectProvider()).toBe('k8s')
    expect(getSystemLogProvider(true)).toBeInstanceOf(K8sLogProvider)
  })

  it('selects explicitly configured Docker targets', () => {
    process.env.FICUS_SYSTEM_LOG_PROVIDER = 'docker'
    process.env.FICUS_DOCKER_API_CONTAINER = 'tau-api'
    process.env.FICUS_DOCKER_WORKER_CONTAINER = 'tau-worker'
    expect(getSystemLogProvider(true)).toBeInstanceOf(DockerLogProvider)
  })

  it('does not fall back when explicit configuration is invalid', () => {
    process.env.FICUS_SYSTEM_LOG_PROVIDER = 'file'
    delete process.env.FICUS_LOG_FILE_API
    delete process.env.FICUS_LOG_FILE_WORKER
    expect(detectProvider()).toBe('unavailable')
    expect(getSystemLogProvider(true)).toBeInstanceOf(UnavailableLogProvider)
  })

  it('does not use PM2 fallback when the command is unavailable', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    expect(detectProvider(pm2Unavailable)).toBe('unavailable')
    expect(getSystemLogProvider(true, pm2Unavailable)).toBeInstanceOf(UnavailableLogProvider)
  })

  it('does not use PM2 fallback for an empty process list', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    const dependencies = pm2Processes()
    expect(detectProvider(dependencies)).toBe('unavailable')
    expect(getSystemLogProvider(true, dependencies)).toBeInstanceOf(UnavailableLogProvider)
  })

  it('does not use PM2 fallback when only one target is running', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    const dependencies = pm2Processes('tau-api')
    expect(detectProvider(dependencies)).toBe('unavailable')
    expect(getSystemLogProvider(true, dependencies)).toBeInstanceOf(UnavailableLogProvider)
  })

  it('uses PM2 fallback when both targets are running', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    const dependencies = pm2Processes('tau-api', 'tau-worker')
    expect(detectProvider(dependencies)).toBe('pm2')
    expect(getSystemLogProvider(true, dependencies)).toBeInstanceOf(Pm2LogProvider)
  })

  it('uses configured target names when verifying PM2 fallback', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    process.env.FICUS_PM2_API_NAME = 'custom-api'
    process.env.FICUS_PM2_WORKER_NAME = 'custom-worker'
    const dependencies = pm2Processes('custom-api', 'custom-worker')
    expect(detectProvider(dependencies)).toBe('pm2')
  })

  it('sanitizes malformed PM2 output and command errors as unavailable', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    const malformed: SystemLogFactoryDependencies = {
      listPm2Processes: () => ({ exitCode: 0, stdout: '{not json' }),
    }
    const throws: SystemLogFactoryDependencies = {
      listPm2Processes: () => {
        throw new Error('ENOENT: pm2')
      },
    }
    expect(detectProvider(malformed)).toBe('unavailable')
    expect(detectProvider(throws)).toBe('unavailable')
  })

  it('keeps the cached provider unless forceFresh is requested', () => {
    delete process.env.FICUS_SYSTEM_LOG_PROVIDER
    const selected = getSystemLogProvider(true, pm2Processes('tau-api', 'tau-worker'))
    expect(getSystemLogProvider(false, pm2Unavailable)).toBe(selected)
    expect(getSystemLogProvider(true, pm2Unavailable)).toBeInstanceOf(UnavailableLogProvider)
  })

  it('selects explicitly configured PM2 targets', () => {
    process.env.FICUS_SYSTEM_LOG_PROVIDER = 'pm2'
    expect(getSystemLogProvider(true)).toBeInstanceOf(Pm2LogProvider)
  })
})

import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadExplicitSystemLogConfig } from './config'
import { SystemLogProviderError } from './types'

describe('loadExplicitSystemLogConfig — file provider paths', () => {
  it('expands a leading ~ in FICUS_LOG_FILE_API / FICUS_LOG_FILE_WORKER', () => {
    // `~/logs/api.log` was rejected as CONFIG_INVALID ("must be absolute"),
    // because isAbsolute() sees a relative path. Expanding first makes it
    // absolute, and the check then passes on its own terms.
    const config = loadExplicitSystemLogConfig({
      FICUS_SYSTEM_LOG_PROVIDER: 'file',
      FICUS_LOG_FILE_API: '~/logs/api.log',
      FICUS_LOG_FILE_WORKER: '~/logs/worker.log',
    } as NodeJS.ProcessEnv)

    expect(config).toEqual({
      provider: 'file',
      targets: { api: join(homedir(), 'logs/api.log'), worker: join(homedir(), 'logs/worker.log') },
    })
  })

  it('still leaves absolute paths untouched', () => {
    const config = loadExplicitSystemLogConfig({
      FICUS_SYSTEM_LOG_PROVIDER: 'file',
      FICUS_LOG_FILE_API: '/var/log/tau/api.log',
      FICUS_LOG_FILE_WORKER: '/var/log/tau/worker.log',
    } as NodeJS.ProcessEnv)

    expect(config).toEqual({
      provider: 'file',
      targets: { api: '/var/log/tau/api.log', worker: '/var/log/tau/worker.log' },
    })
  })

  it('still rejects a genuinely relative path — expansion is not resolution', () => {
    expect(() =>
      loadExplicitSystemLogConfig({
        FICUS_SYSTEM_LOG_PROVIDER: 'file',
        FICUS_LOG_FILE_API: 'logs/api.log',
        FICUS_LOG_FILE_WORKER: '/var/log/tau/worker.log',
      } as NodeJS.ProcessEnv)
    ).toThrow(SystemLogProviderError)
  })

  it('still rejects ~user, which is not absolute after expansion', () => {
    expect(() =>
      loadExplicitSystemLogConfig({
        FICUS_SYSTEM_LOG_PROVIDER: 'file',
        FICUS_LOG_FILE_API: '~someoneelse/logs/api.log',
        FICUS_LOG_FILE_WORKER: '/var/log/tau/worker.log',
      } as NodeJS.ProcessEnv)
    ).toThrow(SystemLogProviderError)
  })
})

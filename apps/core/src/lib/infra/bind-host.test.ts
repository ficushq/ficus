import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { apiBindHost, beyondLoopback, workerBindHost } from './bind-host'

const repoRoot = join(dirname(import.meta.dir), '..', '..', '..', '..')

describe('apiBindHost', () => {
  it('HOST wins; k8s binds all interfaces; otherwise IPv4 loopback for host agent CLI connectivity', () => {
    expect(apiBindHost({ HOST: '0.0.0.0' }, false)).toBe('0.0.0.0')
    expect(apiBindHost({ HOST: '10.0.0.5' }, true)).toBe('10.0.0.5')
    expect(apiBindHost({}, true)).toBe('0.0.0.0')
    expect(apiBindHost({}, false)).toBe('127.0.0.1')
  })
})

describe('workerBindHost', () => {
  it('FICUS_WORKER_BIND > HOST > k8s-all-interfaces > loopback', () => {
    expect(workerBindHost({ FICUS_WORKER_BIND: '0.0.0.0', HOST: '127.0.0.1' }, false)).toBe('0.0.0.0')
    expect(workerBindHost({ HOST: '0.0.0.0' }, false)).toBe('0.0.0.0')
    expect(workerBindHost({}, true)).toBe('0.0.0.0')
    expect(workerBindHost({}, false)).toBe('127.0.0.1')
  })
  it('treats a whitespace-only FICUS_WORKER_BIND as unset', () => {
    expect(workerBindHost({ FICUS_WORKER_BIND: '   ', HOST: '0.0.0.0' }, false)).toBe('0.0.0.0')
    expect(workerBindHost({ FICUS_WORKER_BIND: '   ' }, false)).toBe('127.0.0.1')
  })
})

describe('beyondLoopback', () => {
  it('flags binds beyond loopback so callers can warn', () => {
    expect(beyondLoopback('127.0.0.1')).toBe(false)
    expect(beyondLoopback('localhost')).toBe(false)
    expect(beyondLoopback('::1')).toBe(false)
    expect(beyondLoopback('0.0.0.0')).toBe(true)
    expect(beyondLoopback('10.1.2.3')).toBe(true)
  })
})

describe('docker-compose.core.yml keeps the worker reachable on the container network', () => {
  it('sets HOST=0.0.0.0 on tau-worker (the loopback default would strand tau-api)', () => {
    const file = join(repoRoot, 'docker-compose.core.yml')
    expect(existsSync(file)).toBe(true)
    const compose = readFileSync(file, 'utf8')
    const worker = compose.split('  tau-worker:')[1] ?? ''
    expect(worker).toMatch(/^\s+HOST: 0\.0\.0\.0$/m)
  })
})

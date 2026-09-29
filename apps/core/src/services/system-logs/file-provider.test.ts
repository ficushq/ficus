import { expect, test } from 'bun:test'
import { buildTailArgs, FileLogProvider } from './file-provider'

test('builds tail argv with rotation-safe follow', () => {
  expect(buildTailArgs('/var/log/tau/api.log', { tailLines: 50, follow: true })).toEqual([
    'tail',
    '-n',
    '50',
    '-F',
    '/var/log/tau/api.log',
  ])
})

test('rejects a relative file target', () => {
  expect(() => new FileLogProvider({ api: 'api.log', worker: '/var/log/tau/worker.log' })).toThrow('absolute')
})

test('omits follow flags for a finite file tail', () => {
  expect(buildTailArgs('/var/log/tau/api.log', { tailLines: 50, follow: false })).toEqual([
    'tail',
    '-n',
    '50',
    '/var/log/tau/api.log',
  ])
})

test('reports actionable sanitized file subprocess failure', async () => {
  const path = `/tmp/ficus-system-log-${crypto.randomUUID()}.log`
  await Bun.write(path, 'line\n')
  const errors: Error[] = []
  const provider = new FileLogProvider(
    { api: path, worker: path },
    { spawn: () => ({ stdout: null, stderr: null, exited: Promise.resolve(1), kill() {} }) }
  )
  provider.stream(
    ['api'],
    { tailLines: 1, follow: false },
    () => {},
    (error) => errors.push(error)
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(errors[0].message).toContain('file paths and permissions')
  await import('node:fs/promises').then(({ unlink }) => unlink(path))
})

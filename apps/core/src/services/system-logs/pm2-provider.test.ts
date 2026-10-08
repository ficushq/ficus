import { expect, test } from 'bun:test'
import { Pm2LogProvider, buildPm2LogsArgs } from './pm2-provider'

test('builds finite PM2 argv and reports actionable failure', async () => {
  expect(buildPm2LogsArgs('ficus-api', { tailLines: 25, follow: false })).toContain('--nostream')
  const errors: Error[] = []
  const provider = new Pm2LogProvider(
    { api: 'ficus-api', worker: 'ficus-worker' },
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
  expect(errors[0].message).toContain('PM2 availability')
})

test('default provider reads CLI-labelled PM2 process names', async () => {
  const originalEnv = { ...process.env }
  try {
    delete process.env.FICUS_PM2_API
    delete process.env.FICUS_PM2_WORKER
    process.env.FICUS_PM2_API_NAME = 'ficus-demo-api'
    process.env.FICUS_PM2_WORKER_NAME = 'ficus-demo-worker'
    const calls: string[][] = []
    const provider = new Pm2LogProvider(undefined, {
      spawn: (argv) => {
        calls.push([...argv])
        return { stdout: null, stderr: null, exited: Promise.resolve(0), kill() {} }
      },
    })
    await new Promise<void>((resolve, reject) => {
      provider.stream(['api', 'worker'], { follow: false, tailLines: 1 }, () => {}, reject, resolve)
    })
    expect(calls.map((argv) => argv[2])).toEqual(['ficus-demo-api', 'ficus-demo-worker'])
  } finally {
    process.env = originalEnv
  }
})

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultRunner } from './runner'
import { makeSupervisorContext } from './supervisor'
import { systemdUnit } from './systemd-user'

if (process.platform !== 'linux')
  console.info('Skipping systemd-analyze verification: systemd is Linux-only; portable unit rendering tests still run.')
test.skipIf(process.platform !== 'linux')('systemd-analyze accepts both rendered user units', async () => {
  expect(process.platform).toBe('linux')
  const root = mkdtempSync(join(tmpdir(), 'ficus-systemd-verify-'))
  try {
    const context = makeSupervisorContext({
      supervisor: 'systemd-user',
      root,
      label: 'verify',
      runner: defaultRunner,
      log: () => {},
      home: root,
      bunPath: process.execPath,
      platform: 'linux',
    })
    const units = (['worker', 'api'] as const).map((component) => {
      const path = join(root, `ficus-verify-${component}.service`)
      writeFileSync(path, systemdUnit(context, component))
      return path
    })
    const result = await defaultRunner(['systemd-analyze', 'verify', ...units])
    expect(result.code, result.stderr).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

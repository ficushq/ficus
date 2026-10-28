import { expect, test } from 'bun:test'
import { boxHostLockScript, boxLockWaitSeconds, boxProvisionLockArgs, withBoxHostLock } from './box-host-lock'

for (const [timeoutMs, seconds] of [
  [2_000, 0],
  [30_000, 7],
  [120_000, 30],
  [180_000, 45],
  [300_000, 75],
  [1_800_000, 180],
] as const) {
  test(`host wait is bounded within the unchanged ${timeoutMs}ms caller budget`, () => {
    expect(boxLockWaitSeconds(timeoutMs)).toBe(seconds)
    expect(seconds * 1_000).toBeLessThanOrEqual(timeoutMs / 4)
    expect(boxProvisionLockArgs(timeoutMs)).toBe(`--lock-wait-seconds ${seconds}`)
  })
}

for (const timeout of [0, -1, NaN, Infinity]) {
  test(`invalid caller deadline refuses before building remote work: ${timeout}`, () => {
    expect(() => boxProvisionLockArgs(timeout)).toThrow('Invalid box SSH timeout')
    expect(() => withBoxHostLock('box_aaaaaaaaaaaa', 'exit 0', timeout)).toThrow('Invalid box SSH timeout')
  })
}

test('standalone locking preserves the stable inode and refuses injected account names', () => {
  for (const user of ['../escape', 'box_x; id', 'bad\nname']) {
    expect(() => boxHostLockScript(user, 30_000)).toThrow('Invalid box unix user')
  }
  const command = withBoxHostLock('box_aaaaaaaaaaaa', 'systemctl restart fixture.service')
  expect(command).toContain('ficus-box-box_aaaaaaaaaaaa.lock')
  expect(command).toContain('exec 200<>')
  expect(command).toContain('FICUS_BOX_LOCK_TIMEOUT')
  expect(command.indexOf('flock -x -w 7 200')).toBeLessThan(command.indexOf('systemctl restart'))
  expect(command).not.toContain('rm ')
})

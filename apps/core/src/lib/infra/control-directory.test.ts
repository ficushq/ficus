import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { getHomeDir } from '../utils/home'
import { machineControlDirectory } from './control-directory'

test('uses the data home by default and admits an explicit short socket directory', () => {
  expect(machineControlDirectory({})).toBe(join(getHomeDir(), 'machines', 'ctl'))
  expect(machineControlDirectory({ FICUS_MACHINE_CONTROL_DIR: '/tmp/desktop-control' })).toBe('/tmp/desktop-control')
  expect(() => machineControlDirectory({ FICUS_MACHINE_CONTROL_DIR: 'relative' })).toThrow('absolute path')
})

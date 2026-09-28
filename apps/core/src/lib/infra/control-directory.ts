import { isAbsolute, join } from 'node:path'
import { getHomeDir } from '../utils/home'

/** Desktop may place transient Unix sockets outside a long user-selected data home. */
export function machineControlDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.FICUS_MACHINE_CONTROL_DIR
  if (value === undefined) return join(getHomeDir(), 'machines', 'ctl')
  if (!isAbsolute(value) || /[\0\r\n]/.test(value))
    throw new Error('FICUS_MACHINE_CONTROL_DIR must be an absolute path')
  return value
}

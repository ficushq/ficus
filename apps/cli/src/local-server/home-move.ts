import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { FICUS_HOME_DIR_NAME } from '@ficus/shared/node'

/** Canonical CLI home for all normal reads and writes. */
export function cliHome(opts?: { homedir?: string; exists?: (p: string) => boolean }): string {
  return join(opts?.homedir ?? osHomedir(), FICUS_HOME_DIR_NAME)
}

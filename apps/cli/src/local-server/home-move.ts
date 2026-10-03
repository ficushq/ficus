import { lstatSync, readlinkSync, unlinkSync, type Stats } from 'fs'
import { homedir as osHomedir } from 'os'
import { delimiter, join } from 'path'
import { FICUS_HOME_DIR_NAME } from '@ficus/shared/node'

/** Retained only until the Desktop/Apple home-link finalization step. */
export const LEGACY_CLI_HOME_LINK = '.tau' // ficus-p5-apple

/** Canonical CLI home for all normal reads and writes. */
export function cliHome(opts?: { homedir?: string; exists?: (p: string) => boolean }): string {
  return join(opts?.homedir ?? osHomedir(), FICUS_HOME_DIR_NAME)
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Removes only the exact old-home link after the canonical CLI bin is on PATH. */
export async function finalizeCliHome(opts: {
  homedir: string
  path: string
}): Promise<'removed' | 'kept-not-on-path' | 'absent'> {
  const legacy = join(opts.homedir, LEGACY_CLI_HOME_LINK) // ficus-p5-apple
  const legacyStat = lstatOrNull(legacy) // ficus-p5-apple
  if (!legacyStat) return 'absent'
  if (!legacyStat.isSymbolicLink() || readlinkSync(legacy) !== FICUS_HOME_DIR_NAME) {
    throw new Error(`${legacy} is not the link to ${FICUS_HOME_DIR_NAME} that a move leaves — not removing it`) // ficus-p5-apple
  }
  const bin = join(opts.homedir, FICUS_HOME_DIR_NAME, 'bin')
  const onPath = opts.path.split(delimiter).some((entry) => entry.replace(/\/+$/, '') === bin)
  if (!onPath) return 'kept-not-on-path'
  unlinkSync(legacy) // ficus-p5-apple
  return 'removed'
}

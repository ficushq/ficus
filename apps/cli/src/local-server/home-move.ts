import { lstatSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, type Stats } from 'fs'
import { homedir as osHomedir } from 'os'
import { delimiter, join } from 'path'
import { FICUS_HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, ficusOrLegacyDir } from '@ficus/shared/node'

/**
 * The name of the link `moveCliHome` leaves at `~/<legacy>`. Only `finalizeCliHome` uses it, and it
 * outlives the bridge sweep (which removes the shared `LEGACY_HOME_DIR_NAME`): it stays until the
 * Apple step, when finalize removes the link.
 */
export const LEGACY_CLI_HOME_LINK = '.tau' // ficus-p5-apple

/** Canonical CLI home for all normal reads and writes. */
export function cliHome(opts?: { homedir?: string; exists?: (p: string) => boolean }): string {
  return ficusOrLegacyDir(opts?.homedir ?? osHomedir())
}

/** Recovery-only locator for explicit rename/undo; never used by normal management. */
export function recoveryCliHome(home: string): string {
  const canonical = join(home, FICUS_HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  return lstatOrNull(canonical) || !lstatOrNull(legacy) ? canonical : legacy
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function resolvesTo(link: string, target: string): boolean {
  try {
    return realpathSync(link) === realpathSync(target)
  } catch {
    return false
  }
}

/**
 * Moves a real legacy home dir to ~/.ficus and leaves the relative symlink ~/<legacy> -> .ficus,
 * so every absolute path already written down (plists, `.env` files, shell profiles) keeps
 * working. Refuses (throws) when ~/.ficus exists, when the two are on different filesystems
 * (the move must be one rename), or when `running()` reports a live local server.
 *
 * 'already': the legacy home is that link, or there is no legacy home but ~/.ficus exists.
 * 'none': neither exists — nothing to move.
 *
 * `statDev` and `symlink` are injectable for tests (a cross-filesystem home, a failing link).
 */
export async function moveCliHome(opts: {
  homedir: string
  running: () => Promise<boolean>
  statDev?: (path: string) => number
  symlink?: (target: string, path: string) => void
}): Promise<'moved' | 'already' | 'none'> {
  const statDev = opts.statDev ?? ((path: string) => statSync(path).dev)
  const symlink = opts.symlink ?? ((target: string, path: string) => symlinkSync(target, path))
  const ficus = join(opts.homedir, FICUS_HOME_DIR_NAME)
  const legacy = join(opts.homedir, LEGACY_HOME_DIR_NAME)
  const ficusExists = () => lstatOrNull(ficus) !== null
  const legacyStat = lstatOrNull(legacy)
  if (!legacyStat) return ficusExists() ? 'already' : 'none'
  if (legacyStat.isSymbolicLink()) {
    if (resolvesTo(legacy, ficus)) return 'already'
    throw new Error(`${legacy} is a symlink that does not resolve to ${ficus} — move it by hand`)
  }
  if (!legacyStat.isDirectory()) throw new Error(`${legacy} is not a directory — move it by hand`)
  const refuseExisting = () => {
    if (ficusExists()) throw new Error(`refusing to move ${legacy}: ${ficus} already exists — merge the two by hand`)
  }
  refuseExisting()
  if (await opts.running()) {
    throw new Error(`refusing to move ${legacy} while the local server is running — stop it first`)
  }
  // Checked again: something may have created it while running() was answering.
  refuseExisting()
  if (statDev(legacy) !== statDev(opts.homedir)) {
    throw new Error(`refusing to move ${legacy}: it is on a different filesystem from ${opts.homedir}`)
  }
  renameSync(legacy, ficus)
  try {
    symlink(FICUS_HOME_DIR_NAME, legacy)
  } catch (error) {
    // Put the home back where everything still points rather than leave neither path working.
    try {
      renameSync(ficus, legacy)
    } catch (rollbackError) {
      throw new Error(
        `moved ${legacy} to ${ficus} but could not link ${legacy} -> ${FICUS_HOME_DIR_NAME} ` +
          `(${(error as Error).message}), and could not move it back (${(rollbackError as Error).message}): ` +
          `the data is in ${ficus}, and ${legacy} was recreated by another process — merge the two by hand`,
        { cause: error }
      )
    }
    throw error
  }
  return 'moved'
}

/**
 * The inverse of `moveCliHome`, for `ficus server rename-identity`'s undo: when ~/<legacy> is the
 * link the move left and ~/.ficus the directory, removes the link and renames the directory back.
 * Also finishes an inverse cut short between the two (no ~/<legacy>, ~/.ficus a directory).
 * 'none' when the home is already a real ~/<legacy> and there is no ~/.ficus. Throws, changing
 * nothing, on any other shape.
 */
export function unmoveCliHome(opts: { homedir: string }): 'moved-back' | 'none' {
  const ficus = join(opts.homedir, FICUS_HOME_DIR_NAME)
  const legacy = join(opts.homedir, LEGACY_HOME_DIR_NAME)
  const legacyStat = lstatOrNull(legacy)
  const ficusStat = lstatOrNull(ficus)
  const ficusIsDir = ficusStat !== null && !ficusStat.isSymbolicLink() && ficusStat.isDirectory()
  if (legacyStat?.isSymbolicLink() && readlinkSync(legacy) === FICUS_HOME_DIR_NAME && ficusIsDir) {
    unlinkSync(legacy)
    renameSync(ficus, legacy)
    return 'moved-back'
  }
  if (!legacyStat && ficusIsDir) {
    renameSync(ficus, legacy)
    return 'moved-back'
  }
  if (legacyStat?.isDirectory() && !legacyStat.isSymbolicLink() && !ficusStat) return 'none'
  throw new Error(`cannot move ${ficus} back to ${legacy}: neither is what the move left — move it by hand`)
}

/**
 * Apple-step finalize: removes ~/<legacy> only when it is exactly that symlink AND
 * <homedir>/.ficus/bin is on PATH (so nothing the operator types still depends on it).
 * Throws, removing nothing, when ~/<legacy> is anything but the link `moveCliHome` leaves.
 */
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

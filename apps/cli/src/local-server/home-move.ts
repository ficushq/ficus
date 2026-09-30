import { lstatSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, type Stats } from 'fs'
import { homedir as osHomedir } from 'os'
import { delimiter, join } from 'path'
import { FICUS_HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, ficusOrLegacyDir } from '@ficus/shared/node'

/**
 * The CLI home: ~/.ficus when it exists (dir or link) or when no legacy home exists; else the
 * legacy home (not yet moved). Holds `bin/`, `share/`, `cli/` (auth store, instance registry),
 * `logs/` and the default checkout. `scripts/install.sh` applies the same rule.
 */
export function cliHome(opts?: { homedir?: string; exists?: (p: string) => boolean }): string {
  return ficusOrLegacyDir(opts?.homedir ?? osHomedir(), opts?.exists)
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
 */
export async function moveCliHome(opts: {
  homedir: string
  running: () => Promise<boolean>
}): Promise<'moved' | 'already' | 'none'> {
  const ficus = join(opts.homedir, FICUS_HOME_DIR_NAME)
  const legacy = join(opts.homedir, LEGACY_HOME_DIR_NAME)
  const legacyStat = lstatOrNull(legacy)
  if (!legacyStat) return lstatOrNull(ficus) ? 'already' : 'none'
  if (legacyStat.isSymbolicLink()) {
    if (resolvesTo(legacy, ficus)) return 'already'
    throw new Error(`${legacy} is a symlink that does not resolve to ${ficus} — move it by hand`)
  }
  if (!legacyStat.isDirectory()) throw new Error(`${legacy} is not a directory — move it by hand`)
  if (lstatOrNull(ficus)) {
    throw new Error(`refusing to move ${legacy}: ${ficus} already exists — merge the two by hand`)
  }
  if (await opts.running()) {
    throw new Error(`refusing to move ${legacy} while the local server is running — stop it first`)
  }
  if (statSync(legacy).dev !== statSync(opts.homedir).dev) {
    throw new Error(`refusing to move ${legacy}: it is on a different filesystem from ${opts.homedir}`)
  }
  renameSync(legacy, ficus)
  try {
    symlinkSync(FICUS_HOME_DIR_NAME, legacy)
  } catch (error) {
    // Put the home back where everything still points rather than leave neither path working.
    renameSync(ficus, legacy)
    throw error
  }
  return 'moved'
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
  const legacy = join(opts.homedir, LEGACY_HOME_DIR_NAME) // ficus-p5-apple
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

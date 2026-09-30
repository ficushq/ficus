import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Ficus → tau bridge (Phase 5, U0): these are the fixed old-name pair every
 * dual-reader below falls back to. Marked so the phase-5 sweep can find and
 * delete them once every host has moved (see the phase-5 plan's "Bridge
 * marker" rule).
 */
export const LEGACY_UNITS = { api: 'tau-api', worker: 'tau-worker' } // ficus-p5-bridge
export const LEGACY_LAUNCHD_PREFIX = 'ai.hiretau' // ficus-p5-bridge
export const LEGACY_SANDBOX_PASSWORD = '/etc/tau/password' // ficus-p5-bridge
/**
 * The home directory name before the rename: the CLI home (`~/<legacy>`), Core's default
 * HOME_DIR, and the status dir in a checkout root. Used while it is a real directory.
 */
export const LEGACY_HOME_DIR_NAME = '.tau' // ficus-p5-bridge

const NEW_LAUNCHD_PREFIX = 'sh.ficus'
/** The home directory name after the rename (`~/.ficus`). */
export const FICUS_HOME_DIR_NAME = '.ficus'
const FICUS_SANDBOX_PASSWORD = '/etc/ficus/password'
const DEFAULT_UNIT_DIR = '/etc/systemd/system'

/**
 * systemd unit names for this host: `ficus-*` when `/etc/systemd/system/ficus-api.service`
 * exists, else the legacy pair. Reads the filesystem so a host that has already run the
 * phase-5 upgrade job (which enables the new units before removing the old ones) gets the
 * new names, and every other host keeps working unchanged.
 */
export function hostSystemdUnits(opts?: { unitDir?: string }): { api: string; worker: string } {
  const unitDir = opts?.unitDir ?? DEFAULT_UNIT_DIR
  return existsSync(join(unitDir, 'ficus-api.service'))
    ? { api: 'ficus-api', worker: 'ficus-worker' }
    : { ...LEGACY_UNITS }
}

/**
 * Maps a legacy local-instance process name (the shape `localProcessNames()` still
 * produces, see `LEGACY_UNITS` above for the default pair) to the name it becomes once
 * P5-T19 renames the default local instance from the legacy label to `ficus`: the same
 * string with its leading legacy prefix replaced by `ficus-`. Exists so `launchdLabel()`
 * below can compute a legacy/new pair from a single `localProcessNames()` result before
 * P5-T19 ships; P5-T19 must reuse this mapping (or supersede every caller with its own
 * renamed `localProcessNames()`) rather than re-deriving it separately.
 */
export function ficusProcessName(legacyName: string): string {
  return legacyName.replace(/^tau-/, 'ficus-') // ficus-p5-bridge
}

/**
 * launchd label for a local process, `sh.ficus.<new name>`. Falls back to the legacy
 * prefix (see `LEGACY_LAUNCHD_PREFIX` above) joined with the legacy name only when that
 * plist is the one actually installed — a host that has not yet re-registered its
 * LaunchAgents. Takes the legacy and new process names separately (see
 * `ficusProcessName()`): a launchd label is not a straight prefix swap on one shared name,
 * because the process name itself changes shape too, per era.
 */
export function launchdLabel(names: { legacy: string; new: string }, opts?: { launchAgentsDir?: string }): string {
  const launchAgentsDir = opts?.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents')
  const legacyLabel = `${LEGACY_LAUNCHD_PREFIX}.${names.legacy}` // ficus-p5-bridge
  return existsSync(join(launchAgentsDir, `${legacyLabel}.plist`)) ? legacyLabel : `${NEW_LAUNCHD_PREFIX}.${names.new}`
}

/**
 * Path of the in-sandbox password secret. Prefers `/etc/ficus/password` and falls back to
 * the legacy path (see `LEGACY_SANDBOX_PASSWORD` above) only when that's the one present.
 * Callers still `existsSync()` the result themselves; this only picks which path to check.
 */
export function sandboxPasswordPath(opts?: { exists?: (path: string) => boolean }): string {
  const exists = opts?.exists ?? existsSync
  return exists(FICUS_SANDBOX_PASSWORD) ? FICUS_SANDBOX_PASSWORD : LEGACY_SANDBOX_PASSWORD
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * `<parent>/.ficus` when it exists (a directory, or a link) or when no legacy directory
 * (see `LEGACY_HOME_DIR_NAME` above) exists; otherwise the legacy directory, which has not
 * been moved yet. The one rule for the CLI home (`parent` = the user's home), the sandbox
 * identity cache (the private root) and a checkout's update-status dir (the checkout root).
 */
export function ficusOrLegacyDir(parent: string, exists: (path: string) => boolean = existsNoFollow): string {
  const ficus = join(parent, FICUS_HOME_DIR_NAME)
  if (exists(ficus)) return ficus
  const legacy = join(parent, LEGACY_HOME_DIR_NAME)
  return exists(legacy) ? legacy : ficus
}

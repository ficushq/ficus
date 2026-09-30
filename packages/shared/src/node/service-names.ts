import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_INSTANCE_LABEL, normalizeLocalInstanceLabel } from '../local-instance'

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
 * Every consumer is bridge code (read-both resolution, the CLI home move) and goes with the
 * bridge sweep. The one consumer that outlives it — the CLI's Apple-step `finalizeCliHome` —
 * has its own `ficus-p5-apple` constant (`LEGACY_CLI_HOME_LINK`), so this line can go first.
 */
export const LEGACY_HOME_DIR_NAME = '.tau' // ficus-p5-bridge
/**
 * The local instance's name before the rename: the default instance's label, and the stem of
 * an installer-managed Postgres's names (container `postgres-<stem>[-<label>]`, volume
 * `<stem>[-<label>]_postgres-data`, database `<stem>`). Only the CLI's rename bridge reads it,
 * to find what it moves.
 */
export const LEGACY_LOCAL_INSTANCE = 'tau' // ficus-p5-bridge

/** The launchd label prefix of a local process (`sh.ficus.<process>`). */
export const FICUS_LAUNCHD_PREFIX = 'sh.ficus'
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
 * A local instance's process names before `ficus server rename-identity` moved it: the legacy
 * pair (see `LEGACY_UNITS` above) for the legacy default label (`LEGACY_LOCAL_INSTANCE`), and
 * `<legacy>-<label>-api`/`-worker` for any other label. The CLI derives the names of a registry
 * entry that lacks `identity: 2` from this; Core uses it to find a supervisor definition that
 * has not been re-registered yet.
 */
export function legacyLocalProcessNames(raw: string): { label: string; api: string; worker: string } {
  const label = normalizeLocalInstanceLabel(raw)
  return label === LEGACY_LOCAL_INSTANCE
    ? { label, ...LEGACY_UNITS }
    : { label, api: `${LEGACY_LOCAL_INSTANCE}-${label}-api`, worker: `${LEGACY_LOCAL_INSTANCE}-${label}-worker` }
}

/**
 * The label an instance has after `ficus server rename-identity`: the legacy default label
 * becomes the ficus default, every other label is kept.
 */
export function renamedLocalInstanceLabel(label: string): string {
  return label === LEGACY_LOCAL_INSTANCE ? DEFAULT_INSTANCE_LABEL : label
}

/**
 * launchd label for a local process, `sh.ficus.<new name>`. Falls back to the legacy
 * prefix (see `LEGACY_LAUNCHD_PREFIX` above) joined with the legacy name only when that
 * plist is the one actually installed — a host that has not yet re-registered its
 * LaunchAgents. Takes the legacy and new process names separately (see
 * `legacyLocalProcessNames()`): a launchd label is not a straight prefix swap on one shared
 * name, because the process name itself changes shape too, per era.
 */
export function launchdLabel(names: { legacy: string; new: string }, opts?: { launchAgentsDir?: string }): string {
  const launchAgentsDir = opts?.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents')
  const legacyLabel = `${LEGACY_LAUNCHD_PREFIX}.${names.legacy}` // ficus-p5-bridge
  return existsSync(join(launchAgentsDir, `${legacyLabel}.plist`))
    ? legacyLabel
    : `${FICUS_LAUNCHD_PREFIX}.${names.new}`
}

/**
 * systemd user unit for a local process, `<new name>.service`, unless only the legacy unit
 * file is installed in the user unit directory (`$XDG_CONFIG_HOME/systemd/user`, default
 * `~/.config/systemd/user`) — an install that has not run `ficus server rename-identity`.
 */
export function systemdUserUnit(names: { legacy: string; new: string }, opts?: { unitDir?: string }): string {
  const unitDir = opts?.unitDir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
  const legacyUnit = `${names.legacy}.service`
  return existsSync(join(unitDir, legacyUnit)) ? legacyUnit : `${names.new}.service`
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

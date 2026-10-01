import { join } from 'node:path'
import { DEFAULT_INSTANCE_LABEL, normalizeLocalInstanceLabel } from '../local-instance'

/** Retired names retained for explicit rename/undo tools and negative fixtures. */
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

/** Canonical systemd units after host-layout finalization. */
export function hostSystemdUnits(_opts?: { unitDir?: string }): { api: string; worker: string } {
  return { api: 'ficus-api', worker: 'ficus-worker' }
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

/** Canonical launchd label; installed legacy plists are not selected. */
export function launchdLabel(names: { legacy: string; new: string }, _opts?: { launchAgentsDir?: string }): string {
  return `${FICUS_LAUNCHD_PREFIX}.${names.new}`
}

/** Canonical user unit; installed legacy units are not selected. */
export function systemdUserUnit(names: { legacy: string; new: string }, _opts?: { unitDir?: string }): string {
  return `${names.new}.service`
}

/** Canonical in-sandbox secret path. Callers check whether it exists. */
export function sandboxPasswordPath(_opts?: { exists?: (path: string) => boolean }): string {
  return FICUS_SANDBOX_PASSWORD
}

/** Canonical data/status directory; retained name avoids needless caller churn. */
export function ficusOrLegacyDir(parent: string, _exists?: (path: string) => boolean): string {
  return join(parent, FICUS_HOME_DIR_NAME)
}

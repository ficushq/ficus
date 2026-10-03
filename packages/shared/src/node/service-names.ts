import { join } from 'node:path'

/** The launchd label prefix of a local process (`sh.ficus.<process>`). */
export const FICUS_LAUNCHD_PREFIX = 'sh.ficus'
/** The canonical home directory (`~/.ficus`). */
export const FICUS_HOME_DIR_NAME = '.ficus'
const FICUS_SANDBOX_PASSWORD = '/etc/ficus/password'

/** Canonical systemd units. */
export function hostSystemdUnits(_opts?: { unitDir?: string }): { api: string; worker: string } {
  return { api: 'ficus-api', worker: 'ficus-worker' }
}

/** Canonical launchd label; installed retired plists are not selected. */
export function launchdLabel(names: { legacy: string; new: string }, _opts?: { launchAgentsDir?: string }): string {
  return `${FICUS_LAUNCHD_PREFIX}.${names.new}`
}

/** Canonical user unit; installed retired units are not selected. */
export function systemdUserUnit(names: { legacy: string; new: string }, _opts?: { unitDir?: string }): string {
  return `${names.new}.service`
}

/** Canonical in-sandbox secret path. */
export function sandboxPasswordPath(_opts?: { exists?: (path: string) => boolean }): string {
  return FICUS_SANDBOX_PASSWORD
}

/** Canonical data/status directory; retained name avoids needless caller churn. */
export function ficusOrLegacyDir(parent: string, _exists?: (path: string) => boolean): string {
  return join(parent, FICUS_HOME_DIR_NAME)
}

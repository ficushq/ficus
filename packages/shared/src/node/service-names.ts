import { existsSync } from 'node:fs'
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

const NEW_LAUNCHD_PREFIX = 'sh.ficus'
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
  return existsSync(join(unitDir, 'ficus-api.service')) ? { api: 'ficus-api', worker: 'ficus-worker' } : LEGACY_UNITS
}

/**
 * launchd label for a local process, e.g. `sh.ficus.ficus-api`; falls back to the legacy
 * label (`ai.hiretau.<processName>`, ficus-p5-bridge) only when that plist is the one
 * actually installed — a host that has not yet re-registered its LaunchAgents.
 */
export function launchdLabel(processName: string, opts?: { launchAgentsDir?: string }): string {
  const launchAgentsDir = opts?.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents')
  const legacyLabel = `${LEGACY_LAUNCHD_PREFIX}.${processName}` // ficus-p5-bridge
  return existsSync(join(launchAgentsDir, `${legacyLabel}.plist`))
    ? legacyLabel
    : `${NEW_LAUNCHD_PREFIX}.${processName}`
}

/**
 * Path of the in-sandbox password secret: `/etc/ficus/password`, else the legacy path
 * (`/etc/tau/password`, ficus-p5-bridge) when only it exists. Callers still
 * `existsSync()` the result themselves; this only picks which path to check.
 */
export function sandboxPasswordPath(opts?: { exists?: (path: string) => boolean }): string {
  const exists = opts?.exists ?? existsSync
  return exists(FICUS_SANDBOX_PASSWORD) ? FICUS_SANDBOX_PASSWORD : LEGACY_SANDBOX_PASSWORD
}

import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'

import { expandTilde } from '@ficus/shared/node'

/** The default HOME_DIR, under the service user's home: `~/.ficus`. */
export const HOME_DIR_NAME = '.ficus'

/**
 * The default HOME_DIR before the host layout moved it (a layout-1 host, or an
 * install that has not moved yet). Read only while `~/.ficus` does not exist;
 * the finalize release deletes it.
 */
export const LEGACY_HOME_DIR_NAME = '.tau' // ficus-p5-bridge

export interface HomeDirDeps {
  env?: Record<string, string | undefined>
  homedir?: () => string
  exists?: (path: string) => boolean
}

/**
 * The Ficus home directory. An explicit `HOME_DIR` always wins (with a leading
 * `~` expanded). Otherwise it is `~/.ficus`, except on an install that has not
 * moved yet: when `~/.ficus` is absent and the legacy dir exists, the legacy dir
 * is the home. So the answer follows the host's layout, not the release:
 *
 * - a fresh install gets `~/.ficus` (created by whoever first needs it);
 * - a layout-1 host keeps its legacy dir until the host layout migration moves it;
 * - a migrated host has `~/.ficus` (the legacy path is its compat link), and a
 *   setup-host re-run that drops the explicit `HOME_DIR` still lands there.
 */
export function resolveHomeDir(deps: HomeDirDeps = {}): string {
  const env = deps.env ?? process.env
  const home = (deps.homedir ?? homedir)()
  if (env.HOME_DIR) return expandTilde(env.HOME_DIR, home)
  const exists = deps.exists ?? existsSync
  const ficus = join(home, HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  return !exists(ficus) && exists(legacy) ? legacy : ficus
}

/**
 * Resolve the Ficus home directory on every call (not cached at module load) so
 * that tests can override via `process.env.HOME_DIR` at runtime regardless of
 * module load order. Performance is negligible — this is not a hot path.
 */
export function getHomeDir(): string {
  return resolveHomeDir()
}

export function ensureHomeDir(): void {
  mkdirSync(getHomeDir(), { recursive: true })
}

import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

import { expandTilde } from '@ficus/shared/node'

/**
 * Resolve the tau home directory on every call (not cached at module load) so
 * that tests can override via `process.env.HOME_DIR` at runtime regardless of
 * module load order. Performance is negligible — this is not a hot path.
 */
export function getHomeDir(): string {
  return expandTilde(process.env.HOME_DIR || join(homedir(), '.tau'))
}

export function ensureHomeDir(): void {
  mkdirSync(getHomeDir(), { recursive: true })
}

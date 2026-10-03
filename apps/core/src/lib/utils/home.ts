import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

import { expandTilde } from '@ficus/shared/node'

/** The default HOME_DIR, under the service user's home: `~/.ficus`. */
export const HOME_DIR_NAME = '.ficus'

/**
 * What marks a directory as holding Core's data: the `sessions/` directory Core creates at every
 * boot (`ensureSessionDataDir`). A CLI-only home (`cli/`, `bin/`, `logs/`) does not have it.
 */
export const HOME_DATA_MARKER = 'sessions'

export interface HomeDirDeps {
  env?: Record<string, string | undefined>
  homedir?: () => string
  /** Is PATH a symlink (not following it)? */
  isSymlink?: (path: string) => boolean
  /** PATH with every symlink resolved, or null when it does not resolve. */
  realpath?: (path: string) => string | null
  /** Does the directory PATH hold Core's data (HOME_DATA_MARKER)? */
  hasData?: (path: string) => boolean
  warn?: (message: string) => void
}

/** The configured home, or the canonical default. No filesystem-dependent fallback. */
export function resolveHomeDir(deps: HomeDirDeps = {}): string {
  const env = deps.env ?? process.env
  const home = (deps.homedir ?? homedir)()
  return env.HOME_DIR ? expandTilde(env.HOME_DIR, home) : join(home, HOME_DIR_NAME)
}

/**
 * A getter that decides the default once and keeps it (keyed by the user's home). An explicit
 * `HOME_DIR` is read on every call — it is not a decision, and tests set it at runtime.
 */
export function createHomeDirGetter(deps: HomeDirDeps = {}): { get: () => string; reset: () => void } {
  let resolved: { home: string; dir: string } | null = null
  return {
    get() {
      const env = deps.env ?? process.env
      if (env.HOME_DIR) return resolveHomeDir(deps)
      const home = (deps.homedir ?? homedir)()
      if (resolved?.home !== home) resolved = { home, dir: resolveHomeDir(deps) }
      return resolved.dir
    },
    reset() {
      resolved = null
    },
  }
}

const processHomeDir = createHomeDirGetter()

/**
 * The Ficus home directory, decided ONCE per process: the directory Core uses must not change
 * under it mid-run (a CLI creating the legacy dir must not move a running Core).
 */
export function getHomeDir(): string {
  return processHomeDir.get()
}

export function ensureHomeDir(): void {
  mkdirSync(getHomeDir(), { recursive: true })
}

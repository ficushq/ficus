import { join } from 'path'
import { homedir } from 'os'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'fs'

import { expandTilde } from '@ficus/shared/node'

/** The default HOME_DIR, under the service user's home: `~/.ficus`. */
export const HOME_DIR_NAME = '.ficus'

/**
 * The default HOME_DIR before the host layout moved it (a layout-1 host, or an
 * install that has not moved yet). Used while it is a real directory; the
 * finalize release deletes it.
 */
export const LEGACY_HOME_DIR_NAME = '.tau' // ficus-p5-bridge

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

function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function hasDataAt(path: string): boolean {
  try {
    return statSync(join(path, HOME_DATA_MARKER)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The Ficus home directory. An explicit `HOME_DIR` always wins (with a leading
 * `~` expanded) — a toolkit host's `.env` names it. Otherwise it is decided by
 * where Core's DATA is (HOME_DATA_MARKER), never by which directories merely
 * exist — the CLI creates its own files under the legacy dir, and that must not move
 * Core's home:
 *
 * 1. the legacy dir (LEGACY_HOME_DIR_NAME) is a symlink to `~/.ficus` (a migrated host or
 *    install) → `~/.ficus`;
 * 2. `~/.ficus` holds data → `~/.ficus` (with a warning when the legacy dir
 *    holds data too);
 * 3. the legacy dir holds data (a host or install that has not moved) → it;
 * 4. neither (a fresh install) → `~/.ficus`.
 *
 * scripts/setup/lib.sh's home_dir_default makes the same decision for the
 * toolkit (setup-host.sh's HOME_DIR and backup, the host layout migration).
 */
export function resolveHomeDir(deps: HomeDirDeps = {}): string {
  const env = deps.env ?? process.env
  const home = (deps.homedir ?? homedir)()
  if (env.HOME_DIR) return expandTilde(env.HOME_DIR, home)
  const isSymlink = deps.isSymlink ?? isSymlinkAt
  const realpath = deps.realpath ?? realpathOrNull
  const hasData = deps.hasData ?? hasDataAt
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  const ficus = join(home, HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  if (isSymlink(legacy)) {
    const target = realpath(legacy)
    if (target !== null && target === realpath(ficus)) return ficus
  }
  if (hasData(ficus)) {
    if (hasData(legacy))
      warn(
        `HOME: both ${ficus} and ${legacy} hold Core data (${HOME_DATA_MARKER}/) — using ${ficus}; set HOME_DIR to choose`
      )
    return ficus
  }
  if (hasData(legacy)) return legacy
  return ficus
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

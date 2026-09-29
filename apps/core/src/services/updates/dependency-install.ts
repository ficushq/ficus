/**
 * The updater's dependency-install rule: which changed paths mean `bun install`
 * must run, and the exact command that runs it.
 *
 * This module must import NOTHING. `scripts/update-offline-bootstrap.ts` loads it
 * before any dependency install, while `node_modules` may still hold the previous
 * release's packages (after a package-scope change, only the old scope), so any import
 * here could fail to resolve. `update-offline-bootstrap.test.ts` enforces this.
 */

/** Paths whose change means the dependency tree changed. */
export const DEPENDENCY_PATHS: { readonly exact: readonly string[]; readonly prefixes: readonly string[] } = {
  exact: ['package.json', 'bun.lock'],
  prefixes: ['patches/'],
}

/** The one install command every update path runs. */
export const DEPENDENCY_INSTALL_COMMAND: readonly string[] = ['bun', 'install', '--frozen-lockfile']

/**
 * A changed path that implies a dependency change, for callers that must plan an
 * install without a real diff entry (the bootstrap found `node_modules` stale).
 */
export const DEPENDENCY_MARKER_PATH = 'bun.lock'

export function touchesDependencies(changedFiles: readonly string[]): boolean {
  return changedFiles.some(
    (path) =>
      DEPENDENCY_PATHS.exact.includes(path) || DEPENDENCY_PATHS.prefixes.some((prefix) => path.startsWith(prefix))
  )
}

/**
 * Flags the bootstrap passes to `scripts/update-offline.ts` (the real update) to say
 * what it already did: installed the dependencies, and whether it found them stale.
 */
export const BOOTSTRAP_INSTALLED_FLAG = '--dependencies-installed'
export const BOOTSTRAP_STALE_FLAG = '--dependencies-were-stale'

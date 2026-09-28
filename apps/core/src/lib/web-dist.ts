import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CORE_ROOT_PACKAGE_NAMES, type CoreRootPackageName } from '@ficus/shared/identity'
import { expandTilde } from '@ficus/shared/node'

function findRepoRoot(start: string): string | undefined {
  let dir = start

  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as {
          name?: string
          workspaces?: unknown
        }
        if (CORE_ROOT_PACKAGE_NAMES.includes(json.name as CoreRootPackageName) || Array.isArray(json.workspaces))
          return dir
      } catch {
        // Keep walking if this package.json is unreadable or invalid.
      }
    }

    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }

  return undefined
}

/**
 * Resolves the absolute path to the built web UI directory.
 *
 * Search order:
 *  1. `FICUS_WEB_DIST` env var, if set.
 *  2. Repo root discovered by walking up from `searchFrom`.
 *  3. `<cwd>/apps/web/dist`.
 *
 * Returns `undefined` if no candidate exists on disk.
 *
 * `searchFrom` is the walk-up origin and defaults to this module's directory,
 * which is what every caller wants. It is a parameter only so tests can start
 * the walk somewhere without a repo above it: otherwise step 2 finds the
 * developer's own checkout and its real `apps/web/dist` (present whenever the
 * web app or a core artifact has been built) answers first, masking step 3.
 */
export function resolveWebDist(searchFrom: string = import.meta.dir): string | undefined {
  const explicit = process.env.FICUS_WEB_DIST
  if (explicit) return resolve(expandTilde(explicit))

  const repoRoot = findRepoRoot(searchFrom)
  if (repoRoot) {
    const candidate = join(repoRoot, 'apps', 'web', 'dist')
    if (existsSync(candidate)) return candidate
  }

  const cwdCandidate = resolve(process.cwd(), 'apps', 'web', 'dist')
  if (existsSync(cwdCandidate)) return cwdCandidate

  return undefined
}

/** Embedded docs ship beside Core bundles in every release. */
export function resolveCoreDocsDist(searchFrom: string = import.meta.dir): string | undefined {
  const root = findRepoRoot(searchFrom)
  const candidate = join(root ?? process.cwd(), 'apps/core/docs-dist')
  return existsSync(candidate) ? candidate : undefined
}

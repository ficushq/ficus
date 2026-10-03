/**
 * Canonical per-workspace settings live under `.ficus`. During finalization,
 * retained migration helpers move old real directories without merging data,
 * and remove only the exact relative compatibility link. Foreign links and
 * conflicting directories remain untouched and block dependent writes.
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('workspace-dot-dir')

/** The settings dir name inside every work root. */
export const WORKSPACE_DOT_DIR = '.ficus'
/** The settings dir name before the rename; only the migration and the bridge link use it. */
export const LEGACY_WORKSPACE_DOT_DIR = '.tau' // ficus-p5-bridge

/** `<workspaceRoot>/.ficus/<segments>`. A pure path join; it touches no filesystem. */
export function workspaceDotPath(workspaceRoot: string, ...segments: string[]): string {
  return join(workspaceRoot, WORKSPACE_DOT_DIR, ...segments)
}

/** What one work root needed: `moved` when its legacy dir was renamed by this call. */
export type WorkspaceDotDirOutcome = { moved: boolean; conflict?: string }

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error)
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/**
 * Moves a remaining real directory without merging or recreating a bridge.
 * An exact relative bridge is removed only beside a real canonical directory.
 * Conflicts are reported without overwriting paths; racing callers re-read once.
 */
export function migrateWorkspaceDotDir(
  root: string,
  options: { retried?: boolean; rename?: (from: string, to: string) => void } = {}
): WorkspaceDotDirOutcome {
  const rename = options.rename ?? renameSync
  try {
    const rootStat = lstatOrNull(root)
    if (!rootStat) return { moved: false }
    if (rootStat.isSymbolicLink()) return { moved: false, conflict: 'the workspace is a symlink, not followed' }
    if (!rootStat.isDirectory()) return { moved: false }

    const target = join(root, WORKSPACE_DOT_DIR)
    const legacy = join(root, LEGACY_WORKSPACE_DOT_DIR)
    const current = lstatOrNull(target)
    const old = lstatOrNull(legacy)

    if (current && !current.isDirectory()) return { moved: false, conflict: `${WORKSPACE_DOT_DIR} is not a directory` }
    if (old?.isSymbolicLink()) {
      const pointsAt = readlinkSync(legacy)
      if (pointsAt === WORKSPACE_DOT_DIR) {
        if (!current) return { moved: false, conflict: `${WORKSPACE_DOT_DIR} is missing behind the compatibility link` }
        try {
          unlinkSync(legacy)
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error
        }
        return { moved: false }
      }
      return {
        moved: false,
        conflict: `${LEGACY_WORKSPACE_DOT_DIR} is a link to ${pointsAt}, not to ${WORKSPACE_DOT_DIR}`,
      }
    }
    if (old && !old.isDirectory()) return { moved: false, conflict: `${LEGACY_WORKSPACE_DOT_DIR} is not a directory` }
    if (old && current)
      return { moved: false, conflict: `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist` }

    if (current) return { moved: false }
    if (!old) return { moved: false }

    try {
      // rename(2) never replaces a non-empty directory, so a `.ficus` that appeared since the
      // lstat above makes this fail (EEXIST/ENOTEMPTY) instead of being merged or clobbered.
      rename(legacy, target)
    } catch (error) {
      const code = errorCode(error)
      // Another process may have moved and linked it between our lstat and the rename: re-read once.
      if (!options.retried) return migrateWorkspaceDotDir(root, { ...options, retried: true })
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR')
        return { moved: false, conflict: `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist` }
      return { moved: false, conflict: `could not move ${LEGACY_WORKSPACE_DOT_DIR}: ${code}` }
    }
    return { moved: true }
  } catch (error) {
    return { moved: false, conflict: `could not inspect: ${errorCode(error)}` }
  }
}

/** The kinds of state in which Core will not use a work root's `.ficus` (see {@link prepareWorkspaceDotDir}). */
export type WorkspaceDotDirConflictKind =
  | 'both-present'
  | 'legacy-link-elsewhere'
  | 'legacy-not-a-directory'
  | 'ficus-not-a-directory'
  | 'symlinked-workspace'
  | 'legacy-not-moved'
  | 'legacy-link-not-removed'
  | 'uninspectable'

/** What a person does to resolve each kind. Names only the dot dirs, never a path or a link target. */
function conflictAdvice(kind: WorkspaceDotDirConflictKind): string {
  const legacy = `${LEGACY_WORKSPACE_DOT_DIR}/`
  const next = `${WORKSPACE_DOT_DIR}/`
  switch (kind) {
    case 'both-present':
      return `it has both ${legacy} and ${next}. Merge anything still needed from ${legacy} into ${next}, then remove ${legacy}`
    case 'legacy-link-elsewhere':
      return `its ${LEGACY_WORKSPACE_DOT_DIR} is a link that does not point to ${WORKSPACE_DOT_DIR}. Copy anything still needed from the link's target into ${next}, then remove the link`
    case 'legacy-not-a-directory':
      return `its ${LEGACY_WORKSPACE_DOT_DIR} is a file, not a directory. Remove or rename it`
    case 'ficus-not-a-directory':
      return `its ${WORKSPACE_DOT_DIR} is not a real directory (a file or a symlink). Replace it with a directory`
    case 'symlinked-workspace':
      return `the workspace is a symlink and its target still holds ${legacy}. In the target, move ${legacy} to ${next}`
    case 'legacy-link-not-removed':
      return `its compatibility link could not be removed. Fix the workspace directory permissions and retry`
    case 'legacy-not-moved':
      return `its ${legacy} could not be moved to ${next}, usually because of permissions. Fix the permissions (or move it by hand) and retry`
    case 'uninspectable':
      return `its settings dir could not be inspected, usually because of permissions. Fix the permissions and retry`
  }
}

/**
 * A work root whose dot dir Core must not use until a person resolves it (see
 * {@link prepareWorkspaceDotDir}). `message` is safe to return from the API: it names the workspace
 * only by its last path segment (the squad or sandbox id) and says what to do. `root` and `detail`
 * are for the server log.
 */
export class WorkspaceDotDirConflictError extends Error {
  readonly code = 'workspace_dot_dir_conflict'

  constructor(
    readonly root: string,
    readonly kind: WorkspaceDotDirConflictKind,
    readonly detail: string = kind
  ) {
    super(`Workspace ${basename(root)} needs a manual fix to its settings dir: ${conflictAdvice(kind)}.`)
    this.name = 'WorkspaceDotDirConflictError'
  }
}

/**
 * Why `.ficus` in `root` cannot be used safely, or undefined when it can: the root is missing or a
 * real dir (or a symlink holding no legacy dir), `.ficus` is absent or a real dir, and the legacy
 * name is absent. Read-only.
 */
function unusableReason(root: string): { kind: WorkspaceDotDirConflictKind; detail: string } | undefined {
  const rootStat = lstatOrNull(root)
  if (!rootStat) return undefined
  const current = lstatOrNull(join(root, WORKSPACE_DOT_DIR))
  if (current && !current.isDirectory())
    return { kind: 'ficus-not-a-directory', detail: `${WORKSPACE_DOT_DIR} is not a directory` }
  const legacy = join(root, LEGACY_WORKSPACE_DOT_DIR)
  const old = lstatOrNull(legacy)
  if (!old) return undefined
  if (old.isSymbolicLink() && readlinkSync(legacy) === WORKSPACE_DOT_DIR) {
    return current
      ? { kind: 'legacy-link-not-removed', detail: 'the compatibility link remains after finalization' }
      : { kind: 'ficus-not-a-directory', detail: `${WORKSPACE_DOT_DIR} is missing` }
  }
  if (rootStat.isSymbolicLink())
    return {
      kind: 'symlinked-workspace',
      detail: `the workspace is a symlink and still holds ${LEGACY_WORKSPACE_DOT_DIR}`,
    }
  if (old.isSymbolicLink())
    return {
      kind: 'legacy-link-elsewhere',
      detail: `${LEGACY_WORKSPACE_DOT_DIR} is a link to ${readlinkSync(legacy)}`,
    }
  if (!old.isDirectory())
    return { kind: 'legacy-not-a-directory', detail: `${LEGACY_WORKSPACE_DOT_DIR} is not a directory` }
  return current
    ? { kind: 'both-present', detail: `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist` }
    : { kind: 'legacy-not-moved', detail: `${LEGACY_WORKSPACE_DOT_DIR} could not be moved` }
}

const warnedRoots = new Set<string>()

/**
 * {@link migrateWorkspaceDotDir} for a caller about to use `root`'s dot dir. Fails closed: when the
 * root is left in a state where using `.ficus` would split the settings (a legacy dir that could not
 * be moved, a legacy link elsewhere) or write through a non-directory `.ficus`, it throws
 * {@link WorkspaceDotDirConflictError} instead of letting the caller create `.ficus`, mint a new
 * identity key, or read an empty env. Cleanup failures are logged once per root per process;
 * the worker's start-up pass reports every conflict.
 */
export function prepareWorkspaceDotDir(root: string): void {
  const outcome = migrateWorkspaceDotDir(root)
  if (outcome.moved) log.info(`Moved ${join(root, LEGACY_WORKSPACE_DOT_DIR)} to ${WORKSPACE_DOT_DIR}`)
  if (outcome.conflict && !warnedRoots.has(root)) {
    warnedRoots.add(root)
    log.warn(`Workspace dot dir not migrated: ${root}: ${outcome.conflict}`)
  }
  let unusable: { kind: WorkspaceDotDirConflictKind; detail: string } | undefined
  try {
    unusable = unusableReason(root)
  } catch (error) {
    unusable = { kind: 'uninspectable', detail: `could not inspect: ${errorCode(error)}` }
  }
  if (unusable) throw new WorkspaceDotDirConflictError(root, unusable.kind, unusable.detail)
}

/** Moves a legacy dir if there is one, creates `<root>/.ficus` if needed and returns the dir. */
export function ensureWorkspaceDotDir(root: string): string {
  prepareWorkspaceDotDir(root)
  const dir = workspaceDotPath(root)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The exact summary line the F4 runbook checks in the worker log. */
export function workspaceDotDirsLogLine(result: { moved: number; conflicts: string[] }): string {
  return `migrateWorkspaceDotDirs moved=${result.moved} conflicts=${JSON.stringify(result.conflicts)}`
}

/**
 * The worker's one start-up pass. For each squad workspace under `<homeDir>/workspaces/squads/*` and
 * each agent private dir under `<homeDir>/private/*` (the identity key lives there), a legacy dot dir
 * that is a real dir while `.ficus` is absent is renamed to `.ficus`. Exact relative
 * compatibility links are removed. Both
 * present → untouched and reported. Idempotent. Never throws: every problem is a `conflicts` entry
 * (`<work root>: <reason>`), and the other roots still run.
 */
export async function migrateWorkspaceDotDirs(homeDir: string): Promise<{ moved: number; conflicts: string[] }> {
  let moved = 0
  const conflicts: string[] = []
  for (const base of [join(homeDir, 'workspaces', 'squads'), join(homeDir, 'private')]) {
    let names: string[]
    try {
      names = readdirSync(base).sort()
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') conflicts.push(`${base}: could not list: ${errorCode(error)}`)
      continue
    }
    for (const name of names) {
      const root = join(base, name)
      // migrateWorkspaceDotDir never throws and refuses a symlinked root itself; a plain file is skipped.
      const outcome = migrateWorkspaceDotDir(root)
      if (outcome.moved) moved++
      if (outcome.conflict) conflicts.push(`${root}: ${outcome.conflict}`)
    }
  }
  const result = { moved, conflicts }
  if (conflicts.length > 0) log.warn(workspaceDotDirsLogLine(result))
  else log.info(workspaceDotDirsLogLine(result))
  return result
}

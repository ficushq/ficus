/** Canonical per-workspace settings. Layout migration belongs to the bridge release. */
import { lstatSync, mkdirSync, type Stats } from 'node:fs'
import path, { basename, join } from 'node:path'

export const WORKSPACE_DOT_DIR = '.ficus'

/**
 * Does this single path segment name the workspace settings directory? Case
 * and trailing dots or spaces are ignored, since some filesystems ignore them.
 * services/squad/workspace-settings.ts keeps the workspace file APIs out of it.
 */
export function isWorkspaceSettingsDirName(name: string): boolean {
  return name.replace(/[. ]+$/, '').toLowerCase() === WORKSPACE_DOT_DIR
}

/**
 * Is `target` the settings directory at `root`, or anything inside it? Both
 * paths must be absolute and already resolved with the same path flavor
 * (`pathApi`); a target outside `root` is never a settings path.
 */
export function isWorkspaceSettingsPath(
  root: string,
  target: string,
  pathApi: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path
): boolean {
  const relative = pathApi.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return false
  }
  return isWorkspaceSettingsDirName(relative.split(pathApi.sep)[0])
}

export function workspaceDotPath(workspaceRoot: string, ...segments: string[]): string {
  return join(workspaceRoot, WORKSPACE_DOT_DIR, ...segments)
}

export type WorkspaceDotDirConflictKind = 'ficus-not-a-directory' | 'uninspectable'

export class WorkspaceDotDirConflictError extends Error {
  readonly code = 'workspace_dot_dir_conflict'
  constructor(
    readonly root: string,
    readonly kind: WorkspaceDotDirConflictKind,
    readonly detail: string = kind
  ) {
    const advice =
      kind === 'ficus-not-a-directory'
        ? 'its .ficus is not a real directory. Replace it with a directory'
        : 'its settings dir could not be inspected. Check the directory permissions'
    super(`Workspace ${basename(root)} needs a manual fix to its settings dir: ${advice}.`)
    this.name = 'WorkspaceDotDirConflictError'
  }
}

/** Refuse invalid canonical settings without following a settings symlink or moving other files. */
export function prepareWorkspaceDotDir(root: string): void {
  let current: Stats
  try {
    current = lstatSync(workspaceDotPath(root))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new WorkspaceDotDirConflictError(root, 'uninspectable')
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new WorkspaceDotDirConflictError(root, 'ficus-not-a-directory')
  }
}

export function ensureWorkspaceDotDir(root: string): string {
  prepareWorkspaceDotDir(root)
  const dir = workspaceDotPath(root)
  mkdirSync(dir, { recursive: true })
  return dir
}

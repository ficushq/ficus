/** Canonical per-workspace settings. Layout migration belongs to the bridge release. */
import { lstatSync, mkdirSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'

export const WORKSPACE_DOT_DIR = '.ficus'

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

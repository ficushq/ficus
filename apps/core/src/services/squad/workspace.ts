import path, { join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, type Dirent } from 'fs'
import { rm } from 'fs/promises'
import { getHomeDir } from '../../lib/utils/home'
import { isHostRuntime } from '../sandbox/runtime'
import { getHostWorkspaceOverride } from '../sandbox/host/workspace-overrides'
import { prepareWorkspaceDotDir } from '../workspace/dot-dir'

/** Directories to skip when searching */
const SKIP_DIRS = new Set(['node_modules', '.git', '.todo', 'dist', 'build', '.next', '__pycache__', '.cache'])

/** Cache for directory listings (path -> { entries, timestamp }) */
const dirCache = new Map<string, { entries: Dirent[]; timestamp: number }>()
const DIR_CACHE_TTL_MS = 60000 // 1 minute
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isCanonicalSquadId(squadId: string): boolean {
  return CANONICAL_UUID_PATTERN.test(squadId)
}

function assertCanonicalSquadId(squadId: string): void {
  if (!isCanonicalSquadId(squadId)) throw new Error('Squad ID must be a canonical UUID')
}

/**
 * Get the base path for all squad workspaces.
 */
export function getSquadsBasePath(): string {
  return join(getHomeDir(), 'workspaces', 'squads')
}

/**
 * Get the full filesystem path for a squad workspace.
 */
export function getSquadWorkspacePath(squadId: string): string {
  assertCanonicalSquadId(squadId)
  return join(getSquadsBasePath(), squadId)
}

/**
 * The squad workspace directory as seen from the CORE's filesystem. Identical
 * to the storage path on every runtime except host, where a configured
 * override (squads.host_workspace_path) is the real workspace. File browsing,
 * search and upload routes must use this; storage-lifecycle code (create,
 * remove) keeps using getSquadWorkspacePath so Ficus never deletes an override.
 */
export function resolveSquadWorkspaceHostPath(squadId: string): string {
  if (isHostRuntime()) {
    const override = getHostWorkspaceOverride(squadId)
    if (override) return override
  }
  return getSquadWorkspacePath(squadId)
}

/**
 * Is `target` the workspace root itself, or a path strictly inside it?
 *
 * The boundary check every workspace file route needs after `path.resolve`.
 * A bare `target.startsWith(root)` is NOT sufficient: with a root of
 * `/srv/repo`, `path.resolve('/srv/repo', '../repo-secrets/x')` yields
 * `/srv/repo-secrets/x`, which passes a prefix test while living entirely
 * outside the workspace. Requiring the separator (or exact equality) closes
 * that sibling-name escape. Both arguments must already be absolute and
 * resolved.
 */
export function isInsideWorkspaceRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Ensure a squad workspace directory exists. Returns the absolute path. A workspace still under the
 * legacy dot dir is moved to `.ficus` here, before any sandbox writes into it.
 */
export function ensureSquadWorkspace(squadId: string): string {
  const fullPath = getSquadWorkspacePath(squadId)
  mkdirSync(fullPath, { recursive: true })
  prepareWorkspaceDotDir(fullPath)
  return fullPath
}

/**
 * Remove a squad workspace directory.
 */
export async function removeSquadWorkspace(squadId: string): Promise<void> {
  const fullPath = getSquadWorkspacePath(squadId)
  if (existsSync(fullPath)) {
    await rm(fullPath, { recursive: true, force: true })
  }
}

export interface TreeNode {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: TreeNode[]
}

/**
 * Build a directory tree for a squad workspace.
 */
export function getWorkspaceTree(squadId: string, maxDepth = 5): TreeNode {
  const fullPath = resolveSquadWorkspaceHostPath(squadId)
  if (!existsSync(fullPath)) {
    throw new Error(`Workspace not found: ${squadId}`)
  }
  return buildTree(fullPath, fullPath.split('/').pop() || squadId, 0, maxDepth)
}

function buildTree(dirPath: string, name: string, depth: number, maxDepth: number): TreeNode {
  const stat = statSync(dirPath)

  if (!stat.isDirectory()) {
    return { name, type: 'file', size: stat.size }
  }

  if (depth >= maxDepth) {
    return { name, type: 'directory', children: [] }
  }

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return { name, type: 'directory', children: [] }
  }

  const children = entries
    .filter((f) => !f.startsWith('.git'))
    .map((f) => buildTree(join(dirPath, f), f, depth + 1, maxDepth))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return { name, type: 'directory', children }
}

/**
 * Read a file from a squad workspace.
 */
export function readWorkspaceFile(squadId: string, filePath: string): string {
  const fullPath = join(resolveSquadWorkspaceHostPath(squadId), filePath)
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  return readFileSync(fullPath, 'utf-8')
}

/**
 * Get cached directory entries or read from disk.
 */
function getCachedDirEntries(dirPath: string): Dirent[] | null {
  const cached = dirCache.get(dirPath)
  if (cached && Date.now() - cached.timestamp < DIR_CACHE_TTL_MS) {
    return cached.entries
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    dirCache.set(dirPath, { entries, timestamp: Date.now() })
    return entries
  } catch {
    return null
  }
}

/**
 * Clear the directory cache (useful for testing).
 */
export function clearDirCache(): void {
  dirCache.clear()
}

export interface SearchWorkspaceOptions {
  query?: string
  maxResults?: number
}

/**
 * Search for files in a squad workspace matching the query.
 * Uses cached directory listings to avoid repeated disk reads.
 */
export function searchWorkspaceFiles(squadId: string, options: SearchWorkspaceOptions = {}): string[] {
  const { query = '', maxResults = 20 } = options
  const workspacePath = resolveSquadWorkspaceHostPath(squadId)

  if (!existsSync(workspacePath)) {
    return []
  }

  const files: string[] = []
  const queryLower = query.toLowerCase()

  function searchDir(dirPath: string, relativePath: string = '') {
    if (files.length >= maxResults) return

    const entries = getCachedDirEntries(dirPath)
    if (!entries) return

    for (const entry of entries) {
      if (files.length >= maxResults) break
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue

      const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        searchDir(join(dirPath, entry.name), entryRelPath)
      } else if (entry.isFile()) {
        // Match if query is empty or file path contains query (case-insensitive)
        if (!queryLower || entryRelPath.toLowerCase().includes(queryLower)) {
          files.push(entryRelPath)
        }
      }
    }
  }

  searchDir(workspacePath)
  return files
}

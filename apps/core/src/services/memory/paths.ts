/**
 * Squad memory path service.
 *
 * Manages the filesystem path for squad-shared memory directories.
 * Memory is mounted read-only in sandbox at /memory.
 *
 * Also provides utilities for converting between /memory/ paths and filesystem paths.
 */

import { join, normalize } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { getHomeDir } from '../../lib/utils/home'

// --- Error Types ---

export const MemoryErrorCodes = {
  PATCH_NO_MATCH: 'PATCH_NO_MATCH',
  PATCH_AMBIGUOUS_MATCH: 'PATCH_AMBIGUOUS_MATCH',
  MEMORY_PATH_INVALID: 'MEMORY_PATH_INVALID',
  MEMORY_LOCK_TIMEOUT: 'MEMORY_LOCK_TIMEOUT',
  MEMORY_FORBIDDEN: 'MEMORY_FORBIDDEN',
  MEMORY_WRITE_FAILED: 'MEMORY_WRITE_FAILED',
} as const

export type MemoryErrorCode = (typeof MemoryErrorCodes)[keyof typeof MemoryErrorCodes]

export interface MemoryError {
  code: MemoryErrorCode
  message: string
  details?: Record<string, unknown>
}

export class MemoryWriteError extends Error {
  constructor(
    public code: MemoryErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'MemoryWriteError'
  }

  toError(): MemoryError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    }
  }
}

// --- Default Content ---

/**
 * Default map.md content - describes the vault structure.
 * Agents can edit this to customize their squad's organization.
 */
const DEFAULT_MAP_MD = `# Memory Map

This file describes the organization of this squad's memory vault.
Agents should follow these conventions when creating memories.

## Folders

- \`decisions/\` — Accepted architecture and product decisions with reusable rationale
- \`patterns/\` — Code conventions and proven approaches for this repo
- \`debugging/\` — Playbooks for common errors and fixes
- \`runbooks/\` — Operational checklists and procedures
- \`incidents/\` — Postmortems and failure analysis
- \`references/\` — API contracts, integration docs, external references

## Conventions

- Use \`[[wikilinks]]\` to connect related memories
- Add YAML frontmatter with at least \`kind:\` and \`title:\`
- Prefer atomic, focused documents over sprawling mega-files
- Update an existing note before creating another account of the same topic
- Keep canonical repository docs in the repo and index them rather than copying them here
- Keep task plans, work logs, PR summaries and progress in their work streams or repositories

## Custom Sections

<!-- Add squad-specific organizational notes here as needed -->
`

/**
 * Default context.md content - essential squad context.
 * This file is always injected into agent prompts when memory is enabled.
 */
const DEFAULT_CONTEXT_MD = `---
kind: context
title: Squad Context
---

# Squad Context

<!-- Essential context that should always be available to agents -->

## Overview

<!-- Brief description of what this squad does -->

## Key Systems

<!-- Important systems, services, or repos this squad works with -->

## Conventions

<!-- Squad-specific conventions and preferences -->
`

// --- Squad Memory Directory ---

/**
 * Get the base path for all squad memory directories.
 */
export function getSquadMemoryBasePath(): string {
  const basePath = join(getHomeDir(), 'memory')
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true })
  }
  try {
    chmodSync(basePath, 0o2775)
  } catch {
    // Best effort; callers will surface write/read errors with path context.
  }
  return basePath
}

/**
 * Get the full filesystem path for a squad's memory directory.
 */
export function getSquadMemoryPath(squadId: string): string {
  return join(getSquadMemoryBasePath(), squadId)
}

/**
 * Ensure a squad memory directory exists. Returns the absolute path.
 * Creates the directory and seeds default files (map.md, context.md) if missing.
 * Triggers a sync push if any files were created.
 */
export function ensureSquadMemoryPath(squadId: string): string {
  const fullPath = getSquadMemoryPath(squadId)

  // Ensure directory exists
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true })
  }
  try {
    chmodSync(fullPath, 0o2775)
  } catch {
    // Best effort; existing root-owned local k3d dirs may require one-time repair.
  }

  // Seed default files if they don't exist
  const mapPath = join(fullPath, 'map.md')
  const contextPath = join(fullPath, 'context.md')

  let filesCreated = false

  if (!existsSync(mapPath)) {
    writeFileSync(mapPath, DEFAULT_MAP_MD, { mode: 0o664 })
    filesCreated = true
  }
  if (!existsSync(contextPath)) {
    writeFileSync(contextPath, DEFAULT_CONTEXT_MD, { mode: 0o664 })
    filesCreated = true
  }

  // Schedule a sync push if we created any files
  if (filesCreated) {
    // Dynamic import to avoid circular dependencies, fire-and-forget
    import('./sync/SyncService').then(({ SyncService }) => {
      SyncService.instance().schedulePush(squadId)
    })
  }

  return fullPath
}

/**
 * Read a file from a squad's memory directory.
 * Returns undefined if the file doesn't exist.
 */
export function readSquadMemoryFile(squadId: string, filename: string): string | undefined {
  const memoryPath = getSquadMemoryPath(squadId)
  const filePath = join(memoryPath, filename)

  if (!existsSync(filePath)) {
    return undefined
  }

  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

// --- MemoryPaths Utility ---

/**
 * Convert a /memory/ path to the actual filesystem path for a squad.
 */
export function toFilesystemPath(squadId: string, memoryPath: string): string {
  const basePath = ensureSquadMemoryPath(squadId)
  const relativePath = memoryPath.slice('/memory/'.length)
  return join(basePath, relativePath)
}

/**
 * Convert a filesystem path to a /memory/ path for a squad.
 */
export function toMemoryPath(squadId: string, fsPath: string): string {
  const basePath = ensureSquadMemoryPath(squadId)
  const normalized = normalize(fsPath)
  if (!normalized.startsWith(basePath)) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path is not inside squad memory directory', {
      fsPath,
      basePath,
    })
  }
  const relativePath = normalized.slice(basePath.length)
  return '/memory' + (relativePath.startsWith('/') ? relativePath : '/' + relativePath)
}

/**
 * Validate that a path is safe for memory operations.
 * - Must start with /memory/
 * - No path traversal (..)
 * - No null bytes
 * - Non-markdown files only allowed in _system/
 */
function validateMemoryPathSafety(path: string): string {
  if (!path) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path cannot be empty')
  }

  // Check for null bytes
  if (path.includes('\x00')) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path contains null bytes')
  }

  // Must be /memory or start with /memory/
  if (path !== '/memory' && !path.startsWith('/memory/')) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path must start with /memory/ (or be /memory)')
  }

  // Normalize and check for traversal
  const normalized = normalize(path)
  if (normalized !== '/memory' && !normalized.startsWith('/memory/')) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path traversal detected', {
      path,
      normalized,
    })
  }

  // Check for explicit .. in path (even if normalize catches it)
  if (path.includes('..')) {
    throw new MemoryWriteError(MemoryErrorCodes.MEMORY_PATH_INVALID, 'Path traversal detected', { path })
  }

  return normalized
}

/**
 * Validate that a path is safe for listing memory directories.
 * - Must be /memory or start with /memory/
 * - No path traversal (..)
 * - No null bytes
 */
export function validateMemoryDirectoryPath(path: string): void {
  validateMemoryPathSafety(path)
}

export function validateMemoryPath(path: string): void {
  validateMemoryPathSafety(path)

  // Check file extension - only .md allowed outside _system/
  const relativePath = path.slice('/memory/'.length)
  const isSystemPath = relativePath.startsWith('_system/')

  if (!isSystemPath) {
    if (!path.endsWith('.md')) {
      throw new MemoryWriteError(
        MemoryErrorCodes.MEMORY_PATH_INVALID,
        'Only markdown files (.md) allowed outside _system/',
        { path }
      )
    }
  }
}

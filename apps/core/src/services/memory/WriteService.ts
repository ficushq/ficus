/**
 * Memory Write Service
 *
 * Provides concurrency-safe write operations for squad memory files.
 * Uses Postgres advisory locks to serialize writes to the same file.
 *
 * Operations:
 * - write: Overwrite entire file content
 * - patch: Replace exact single-match substring
 * - append: Append content to end of file
 * - read: Read file content
 *
 * All paths must be under /memory and are validated for security.
 */

import { dirname } from 'path'
import { mkdir, writeFile, readFile, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { db } from '../../db'
import {
  createPostgresConnection,
  DEDICATED_CONNECTION_SESSION,
  getConnectionString,
  withDedicatedConnectionSlot,
} from '../../db/connection'
import { and, eq, or } from 'drizzle-orm'
import { memoryDocuments } from '../../db/schema'
import { toFilesystemPath, validateMemoryPath, MemoryWriteError, MemoryErrorCodes } from './paths'
import type { MemoryError } from './paths'
import { ReindexScheduler } from './indexer/ReindexScheduler'
import { SyncService } from './sync/SyncService'
import { IndexingService } from './indexer/IndexingService'
import { expandReadScope } from './access/scope-expander'
import { recordMemoryAccess } from './access/audit'
import { canWriteToSquad, type WriteDenialReason } from './access/write-scope'
import { isAllowedBy, parseSensitivity, type SensitivityTier } from './access/sensitivity'

// Re-export error types and path utilities for backwards compatibility
export { MemoryErrorCodes, MemoryWriteError, validateMemoryPath } from './paths'
export type { MemoryErrorCode, MemoryError } from './paths'

export interface MemoryWriteResult {
  success: boolean
  path: string
  deleted?: boolean
  error?: MemoryError
}

export type MemoryReadResult =
  | { success: true; path: string; content: string; sourceSquadId: string }
  | { success: false; path: string; error: MemoryError }

/**
 * Generate a stable lock key from squad ID and path.
 * Uses two 32-bit integers for pg_advisory_xact_lock.
 */
function getLockKeys(squadId: string, path: string): [number, number] {
  const hash = (s: string): number => {
    let h = 0
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0
    }
    return h
  }

  const key1 = hash(squadId)
  const key2 = hash(path)
  return [key1, key2]
}

/**
 * Execute a function with an advisory lock on the given squad/path.
 *
 * The lock lives on a DEDICATED single connection (the withVmSetupLease
 * pattern), NOT a pooled transaction: `fn` performs filesystem work and — on
 * the delete path — pool queries while the lock is held. A pooled
 * transaction doing that is hold-and-wait, and enough concurrent memory
 * writes self-deadlock a 4-connection pool. Session-level lock + explicit
 * unlock preserves the exact same mutual exclusion.
 */
async function withAdvisoryLock<T>(squadId: string, path: string, fn: () => Promise<T>): Promise<T> {
  const [key1, key2] = getLockKeys(squadId, path)
  return withDedicatedConnectionSlot(async () => {
    const connection = createPostgresConnection(getConnectionString(), {
      max: 1,
      idle_timeout: 0,
      connection: DEDICATED_CONNECTION_SESSION,
    })
    try {
      const session = await connection.reserve()
      try {
        await session`select pg_advisory_lock(${key1}, ${key2})`
        try {
          return await fn()
        } finally {
          await session`select pg_advisory_unlock(${key1}, ${key2})`
        }
      } finally {
        session.release()
      }
    } finally {
      await connection.end({ timeout: 5 })
    }
  })
}

// --- WriteService Class ---

export class WriteService {
  private static _instance: WriteService | null = null

  static instance(): WriteService {
    if (!WriteService._instance) {
      WriteService._instance = new WriteService()
    }
    return WriteService._instance
  }

  static _reset(): void {
    WriteService._instance = null
  }

  private forbiddenResult(path: string, reason: WriteDenialReason): MemoryWriteResult {
    const messages: Record<WriteDenialReason, string> = {
      no_grant: 'No write grant from the target squad to your squad',
      no_write_policy: 'The grant from the target squad has no write policy',
      source_type_not_covered: 'The grant does not cover this source type',
      path_not_covered: 'The grant does not cover this path',
    }
    return {
      success: false,
      path,
      error: {
        code: MemoryErrorCodes.MEMORY_FORBIDDEN,
        message: messages[reason],
        details: { path, reason },
      },
    }
  }

  /**
   * Write (overwrite) a memory file with new content.
   * If content is null, deletes the file instead.
   */
  async write(squadId: string, path: string, content: string | null): Promise<MemoryWriteResult> {
    try {
      validateMemoryPath(path)
    } catch (e) {
      if (e instanceof MemoryWriteError) {
        return { success: false, path, error: e.toError() }
      }
      throw e
    }

    return withAdvisoryLock(squadId, path, async () => {
      try {
        const filePath = toFilesystemPath(squadId, path)

        // If content is null, delete the file
        if (content === null) {
          if (!existsSync(filePath)) {
            return {
              success: false,
              path,
              error: {
                code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
                message: 'File does not exist',
                details: { path },
              },
            }
          }

          await unlink(filePath)
          await IndexingService.instance().deleteDocument(squadId, path)

          ReindexScheduler.instance().schedule(squadId)
          SyncService.instance().schedulePush(squadId)

          return { success: true, path, deleted: true }
        }

        // Ensure parent directory exists
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })

        // Atomic write: write to temp file then rename
        const tempPath = `${filePath}.tmp.${Date.now()}`
        await writeFile(tempPath, content, 'utf-8')
        await rename(tempPath, filePath)

        ReindexScheduler.instance().schedule(squadId)
        SyncService.instance().schedulePush(squadId)

        return { success: true, path }
      } catch (e) {
        const error = e as Error
        return {
          success: false,
          path,
          error: {
            code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
            message: error.message,
            details: { path },
          },
        }
      }
    })
  }

  /**
   * Rewrite a memory file through `transform` under the same lock as every other write: read, transform,
   * and write back atomically only when the content changed. Returns whether it did.
   */
  async rewrite(squadId: string, path: string, transform: (content: string) => string): Promise<boolean> {
    validateMemoryPath(path)
    return withAdvisoryLock(squadId, path, async () => {
      const filePath = toFilesystemPath(squadId, path)
      if (!existsSync(filePath)) return false
      const content = await readFile(filePath, 'utf-8')
      const next = transform(content)
      if (next === content) return false
      const tempPath = `${filePath}.tmp.${Date.now()}`
      await writeFile(tempPath, next, 'utf-8')
      await rename(tempPath, filePath)
      ReindexScheduler.instance().schedule(squadId)
      SyncService.instance().schedulePush(squadId)
      return true
    })
  }

  async writeAs(
    callerSquadId: string,
    targetSquadId: string,
    path: string,
    content: string | null
  ): Promise<MemoryWriteResult> {
    const check = await canWriteToSquad(callerSquadId, targetSquadId, { path, sourceType: 'memory_file' })
    if (!check.allowed) return this.forbiddenResult(path, check.reason!)

    const result = await this.write(targetSquadId, path, content)
    if (result.success && callerSquadId !== targetSquadId) {
      await recordMemoryAccess({
        callerSquadId,
        action: 'write',
        sourceSquadIds: [targetSquadId],
        resourcePath: path,
      })
    }
    return result
  }

  /**
   * Patch a memory file by replacing an exact match with new content.
   * The match must appear exactly once (case-sensitive, byte-for-byte).
   */
  async patch(squadId: string, path: string, match: string, replacement: string): Promise<MemoryWriteResult> {
    try {
      validateMemoryPath(path)
    } catch (e) {
      if (e instanceof MemoryWriteError) {
        return { success: false, path, error: e.toError() }
      }
      throw e
    }

    // Reject empty match
    if (!match) {
      return {
        success: false,
        path,
        error: {
          code: MemoryErrorCodes.MEMORY_PATH_INVALID,
          message: 'Match string cannot be empty',
          details: { path },
        },
      }
    }

    return withAdvisoryLock(squadId, path, async () => {
      try {
        const filePath = toFilesystemPath(squadId, path)

        if (!existsSync(filePath)) {
          return {
            success: false,
            path,
            error: {
              code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
              message: 'File does not exist',
              details: { path },
            },
          }
        }

        const content = await readFile(filePath, 'utf-8')

        // Count occurrences
        let count = 0
        let idx = 0
        while ((idx = content.indexOf(match, idx)) !== -1) {
          count++
          idx += match.length
        }

        if (count === 0) {
          return {
            success: false,
            path,
            error: {
              code: MemoryErrorCodes.PATCH_NO_MATCH,
              message: 'Match string not found in file',
              details: { path, match },
            },
          }
        }

        if (count > 1) {
          return {
            success: false,
            path,
            error: {
              code: MemoryErrorCodes.PATCH_AMBIGUOUS_MATCH,
              message: `Match string appears ${count} times`,
              details: { path, matchCount: count },
            },
          }
        }

        // Exactly one match - apply replacement
        const newContent = content.replace(match, replacement)

        // Atomic write
        const tempPath = `${filePath}.tmp.${Date.now()}`
        await writeFile(tempPath, newContent, 'utf-8')
        await rename(tempPath, filePath)

        ReindexScheduler.instance().schedule(squadId)
        SyncService.instance().schedulePush(squadId)

        return { success: true, path }
      } catch (e) {
        const error = e as Error
        return {
          success: false,
          path,
          error: {
            code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
            message: error.message,
            details: { path },
          },
        }
      }
    })
  }

  async patchAs(
    callerSquadId: string,
    targetSquadId: string,
    path: string,
    match: string,
    replacement: string
  ): Promise<MemoryWriteResult> {
    const check = await canWriteToSquad(callerSquadId, targetSquadId, { path, sourceType: 'memory_file' })
    if (!check.allowed) return this.forbiddenResult(path, check.reason!)

    const result = await this.patch(targetSquadId, path, match, replacement)
    if (result.success && callerSquadId !== targetSquadId) {
      await recordMemoryAccess({
        callerSquadId,
        action: 'write',
        sourceSquadIds: [targetSquadId],
        resourcePath: path,
      })
    }
    return result
  }

  /**
   * Append content to a memory file.
   * Creates the file if it doesn't exist.
   */
  async append(
    squadId: string,
    path: string,
    content: string,
    options?: { ensureNewline?: boolean }
  ): Promise<MemoryWriteResult> {
    try {
      validateMemoryPath(path)
    } catch (e) {
      if (e instanceof MemoryWriteError) {
        return { success: false, path, error: e.toError() }
      }
      throw e
    }

    return withAdvisoryLock(squadId, path, async () => {
      try {
        const filePath = toFilesystemPath(squadId, path)
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })

        let existingContent = ''
        if (existsSync(filePath)) {
          existingContent = await readFile(filePath, 'utf-8')
        }

        let newContent: string
        if (options?.ensureNewline && existingContent && !existingContent.endsWith('\n')) {
          newContent = existingContent + '\n' + content
        } else {
          newContent = existingContent + content
        }

        // Atomic write
        const tempPath = `${filePath}.tmp.${Date.now()}`
        await writeFile(tempPath, newContent, 'utf-8')
        await rename(tempPath, filePath)

        ReindexScheduler.instance().schedule(squadId)
        SyncService.instance().schedulePush(squadId)

        return { success: true, path }
      } catch (e) {
        const error = e as Error
        return {
          success: false,
          path,
          error: {
            code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
            message: error.message,
            details: { path },
          },
        }
      }
    })
  }

  async appendAs(
    callerSquadId: string,
    targetSquadId: string,
    path: string,
    content: string,
    options?: { ensureNewline?: boolean }
  ): Promise<MemoryWriteResult> {
    const check = await canWriteToSquad(callerSquadId, targetSquadId, { path, sourceType: 'memory_file' })
    if (!check.allowed) return this.forbiddenResult(path, check.reason!)

    const result = await this.append(targetSquadId, path, content, options)
    if (result.success && callerSquadId !== targetSquadId) {
      await recordMemoryAccess({
        callerSquadId,
        action: 'write',
        sourceSquadIds: [targetSquadId],
        resourcePath: path,
      })
    }
    return result
  }

  /**
   * Read a memory file's content.
   */
  async read(callerSquadId: string, path: string): Promise<MemoryReadResult> {
    try {
      validateMemoryPath(path)
    } catch (e) {
      if (e instanceof MemoryWriteError) {
        return { success: false, path, error: e.toError() }
      }
      throw e
    }

    const scopes = await expandReadScope(callerSquadId, { paths: [path], sourceTypes: ['memory_file'] })
    let lastError: MemoryError | undefined

    for (const scope of scopes) {
      if (!scope.isOwn) {
        const sensitivityAllowed = await this.isCrossSquadReadSensitivityAllowed(
          scope.squadId,
          path,
          scope.filters.sensitivityCeiling
        )
        if (!sensitivityAllowed) {
          lastError = {
            code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
            message: 'File does not exist',
            details: { path },
          }
          continue
        }
      }

      const result = await this.readFromSquad(scope.squadId, path)
      if (!result.success) {
        lastError = result.error
        continue
      }

      if (!scope.isOwn) {
        await recordMemoryAccess({
          callerSquadId,
          sourceSquadIds: [scope.squadId],
          action: 'read',
          resourcePath: path,
        })
      }

      return { ...result, sourceSquadId: scope.squadId }
    }

    return {
      success: false,
      path,
      error: lastError ?? {
        code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
        message: 'File does not exist',
        details: { path },
      },
    }
  }

  private async isCrossSquadReadSensitivityAllowed(
    sourceSquadId: string,
    path: string,
    sensitivityCeiling: SensitivityTier | undefined
  ): Promise<boolean> {
    const [document] = await db
      .select({ sensitivity: memoryDocuments.sensitivity })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, sourceSquadId),
          eq(memoryDocuments.sourceType, 'memory_file'),
          or(eq(memoryDocuments.sourceId, path), eq(memoryDocuments.path, path))
        )
      )
      .limit(1)

    if (!document) return false
    return isAllowedBy(parseSensitivity(document.sensitivity), sensitivityCeiling)
  }

  private async readFromSquad(squadId: string, path: string): Promise<MemoryReadResult> {
    try {
      const filePath = toFilesystemPath(squadId, path)

      if (!existsSync(filePath)) {
        return {
          success: false,
          path,
          error: {
            code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
            message: 'File does not exist',
            details: { path },
          },
        }
      }

      const content = await readFile(filePath, 'utf-8')
      return { success: true, path, content, sourceSquadId: squadId }
    } catch (e) {
      const error = e as Error
      return {
        success: false,
        path,
        error: {
          code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
          message: error.message,
          details: { path },
        },
      }
    }
  }
}

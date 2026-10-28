import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import {
  ensureSquadMemoryPath,
  toFilesystemPath,
  validateMemoryDirectoryPath,
  MemoryWriteError,
  MemoryErrorCodes,
} from './paths'
import type { MemoryError } from './paths'

export interface MemoryListEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

export type MemoryListResult =
  { success: true; path: string; entries: MemoryListEntry[] } | { success: false; path: string; error: MemoryError }

export class ListService {
  private static _instance: ListService | null = null

  static instance(): ListService {
    if (!ListService._instance) {
      ListService._instance = new ListService()
    }
    return ListService._instance
  }

  static _reset(): void {
    ListService._instance = null
  }

  async list(squadId: string, path = '/memory'): Promise<MemoryListResult> {
    try {
      validateMemoryDirectoryPath(path)
    } catch (e) {
      if (e instanceof MemoryWriteError) {
        return { success: false, path, error: e.toError() }
      }
      throw e
    }

    try {
      const normalizedPath = path.endsWith('/') && path !== '/memory/' ? path.slice(0, -1) : path
      const dirPath =
        normalizedPath === '/memory' || normalizedPath === '/memory/'
          ? ensureSquadMemoryPath(squadId)
          : toFilesystemPath(squadId, normalizedPath)
      const entries = await readdir(dirPath, { withFileTypes: true })
      const memoryRoot = ensureSquadMemoryPath(squadId)

      return {
        success: true,
        path,
        entries: entries
          .filter((entry) => entry.isFile() || entry.isDirectory())
          .map((entry): MemoryListEntry => {
            const fullPath = join(dirPath, entry.name)
            return {
              name: entry.name,
              path: `/memory/${relative(memoryRoot, fullPath)}`,
              type: entry.isDirectory() ? 'directory' : 'file',
            }
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          }),
      }
    } catch (e) {
      const error = e as NodeJS.ErrnoException
      return {
        success: false,
        path,
        error: {
          code: MemoryErrorCodes.MEMORY_WRITE_FAILED,
          message: error.code === 'ENOENT' ? 'Directory does not exist' : error.message,
          details: { path },
        },
      }
    }
  }
}

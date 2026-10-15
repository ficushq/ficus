/**
 * File operations confined to one root directory, without following symbolic
 * links anywhere below that root.
 *
 * Used where a human browses or uploads into a directory that an untrusted
 * party (an agent) can also write: an agent's private area. A path-prefix check
 * is not enough there, because the agent can plant `notes -> /etc` or swap a
 * directory for a symlink between a check and the open. So instead:
 *
 * - The relative path is split into components; `..`, NUL bytes, backslashes
 *   and absolute paths are rejected outright.
 * - On Linux, every component is opened relative to its parent's descriptor
 *   (through `/proc/self/fd/<fd>/<name>`) with `O_NOFOLLOW`, so a symlink at any
 *   level fails with `symlink` and a concurrent swap cannot redirect the walk.
 *   The root itself is opened with `O_NOFOLLOW` too; its ancestors are trusted
 *   platform paths.
 * - Elsewhere (macOS hosts running the host runtime for development) the same
 *   walk runs on joined paths. Every component is still opened with
 *   `O_NOFOLLOW`, but a concurrent swap of an already-checked directory is not
 *   ruled out; the host runtime has no isolation between agents anyway.
 * - Files are opened with `O_NOFOLLOW | O_NONBLOCK` and must be regular files,
 *   so a FIFO or device cannot hang or leak.
 * - Overwrites go through a temporary file and `rename`, which replaces the
 *   directory entry rather than writing through it, so a hard link to a file
 *   outside the root is never modified.
 */

import { randomBytes } from 'node:crypto'
import { constants as C } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

export type ConfinedFsErrorCode = 'invalid-path' | 'not-found' | 'not-a-directory' | 'not-a-file' | 'symlink'

const MESSAGES: Record<ConfinedFsErrorCode, string> = {
  'invalid-path': 'Invalid path',
  'not-found': 'Path not found',
  'not-a-directory': 'Path is not a directory',
  'not-a-file': 'Path is not a regular file',
  symlink: 'Symbolic links are not followed',
}

export class ConfinedFsError extends Error {
  constructor(readonly code: ConfinedFsErrorCode) {
    super(MESSAGES[code])
    this.name = 'ConfinedFsError'
  }
}

export function isConfinedFsErrorCode(value: unknown): value is ConfinedFsErrorCode {
  return typeof value === 'string' && value in MESSAGES
}

export interface ConfinedEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: number
}

export interface ConfinedReadResult {
  content: Buffer
  size: number
  truncated: boolean
}

export type ConfinedWriteStatus = 'created' | 'overwritten' | 'skipped'

const MAX_COMPONENT_LENGTH = 255
const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW

/**
 * Split a root-relative path into components, rejecting anything that could
 * name a location outside the root. Empty and `.` components are dropped, so
 * `''` and `'.'` mean the root itself.
 */
export function splitConfinedPath(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.startsWith('/') ||
    relativePath.includes('\0') ||
    relativePath.includes('\\')
  ) {
    throw new ConfinedFsError('invalid-path')
  }
  const parts = relativePath.split('/').filter((part) => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..' || part.length > MAX_COMPONENT_LENGTH) throw new ConfinedFsError('invalid-path')
  }
  return parts
}

interface DirHandle {
  handle: FileHandle
  /** Real path, used only where procfs is unavailable. */
  path: string
}

/** Descriptor-relative on Linux; joined paths elsewhere (see module doc). */
function useProcfs(): boolean {
  return process.platform === 'linux'
}

function childPath(dir: DirHandle, name: string): string {
  return useProcfs() ? `/proc/self/fd/${dir.handle.fd}/${name}` : join(dir.path, name)
}

function dirPath(dir: DirHandle): string {
  return useProcfs() ? `/proc/self/fd/${dir.handle.fd}` : dir.path
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** Classify a failed `O_NOFOLLOW` open: symlink, wrong type, or missing. */
async function classifyOpenFailure(path: string, error: unknown, expect: 'directory' | 'file'): Promise<never> {
  const code = errnoOf(error)
  if (code === 'ENOENT') throw new ConfinedFsError('not-found')
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK' || code === 'EFTYPE') {
    const stats = await fs.lstat(path).catch(() => null)
    if (!stats) throw new ConfinedFsError('not-found')
    if (stats.isSymbolicLink()) throw new ConfinedFsError('symlink')
    throw new ConfinedFsError(expect === 'directory' ? 'not-a-directory' : 'not-a-file')
  }
  throw error
}

async function openDir(path: string): Promise<FileHandle> {
  try {
    return await fs.open(path, DIR_FLAGS)
  } catch (error) {
    return classifyOpenFailure(path, error, 'directory')
  }
}

/**
 * Open the directory `parts` below `root`, creating missing components (mode
 * 0700) when `create` is set. The caller must close the returned handle.
 */
async function openConfinedDir(root: string, parts: string[], create: boolean): Promise<DirHandle> {
  let current: DirHandle = { handle: await openDir(root), path: root }
  try {
    for (const part of parts) {
      const next = childPath(current, part)
      if (create) {
        try {
          await fs.mkdir(next, { mode: 0o700 })
        } catch (error) {
          if (errnoOf(error) !== 'EEXIST') throw error
        }
      }
      const handle = await openDir(next)
      await current.handle.close()
      current = { handle, path: join(current.path, part) }
    }
    return current
  } catch (error) {
    await current.handle.close().catch(() => {})
    throw error
  }
}

async function withConfinedDir<T>(
  root: string,
  parts: string[],
  create: boolean,
  fn: (dir: DirHandle) => Promise<T>
): Promise<T> {
  const dir = await openConfinedDir(root, parts, create)
  try {
    return await fn(dir)
  } finally {
    await dir.handle.close().catch(() => {})
  }
}

function splitFilePath(relativePath: string): { parent: string[]; name: string } {
  const parts = splitConfinedPath(relativePath)
  const name = parts.pop()
  if (!name) throw new ConfinedFsError('invalid-path')
  return { parent: parts, name }
}

/** List the direct children of a directory below `root`. Symlinks are reported, never followed. */
export async function listConfinedDir(root: string, relativePath: string): Promise<ConfinedEntry[]> {
  const parts = splitConfinedPath(relativePath)
  return withConfinedDir(root, parts, false, async (dir) => {
    const names = await fs.readdir(dirPath(dir))
    const entries: ConfinedEntry[] = []
    for (const name of names) {
      const stats = await fs.lstat(childPath(dir, name)).catch(() => null)
      if (!stats) continue
      entries.push({
        name,
        type: stats.isSymbolicLink()
          ? 'symlink'
          : stats.isDirectory()
            ? 'directory'
            : stats.isFile()
              ? 'file'
              : 'other',
        size: stats.isFile() ? Number(stats.size) : 0,
        modifiedAt: Math.floor(stats.mtimeMs / 1000),
      })
    }
    return entries
  })
}

/** Read up to `maxBytes` of a regular file below `root`. */
export async function readConfinedFile(
  root: string,
  relativePath: string,
  options: { maxBytes: number }
): Promise<ConfinedReadResult> {
  const { parent, name } = splitFilePath(relativePath)
  return withConfinedDir(root, parent, false, async (dir) => {
    const path = childPath(dir, name)
    let file: FileHandle
    try {
      file = await fs.open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK)
    } catch (error) {
      return classifyOpenFailure(path, error, 'file')
    }
    try {
      const stats = await file.stat()
      if (!stats.isFile()) throw new ConfinedFsError('not-a-file')
      const size = Number(stats.size)
      const length = Math.max(0, Math.min(size, options.maxBytes))
      const buffer = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return { content: buffer.subarray(0, offset), size, truncated: size > offset }
    } finally {
      await file.close().catch(() => {})
    }
  })
}

async function writeNewFile(path: string, content: Uint8Array, mode: number): Promise<void> {
  const file = await fs.open(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode)
  try {
    await file.writeFile(content)
    await file.sync()
  } catch (error) {
    await file.close().catch(() => {})
    await fs.rm(path, { force: true }).catch(() => {})
    throw error
  }
  await file.close()
}

/**
 * Write a regular file below `root`. Without `overwrite`, an existing entry of
 * any kind is left alone (`skipped`). With it, an existing regular file is
 * atomically replaced; a symlink or directory in the way is refused.
 */
export async function writeConfinedFile(
  root: string,
  relativePath: string,
  content: Uint8Array,
  options: { overwrite?: boolean; createDirs?: boolean; mode?: number } = {}
): Promise<ConfinedWriteStatus> {
  const { parent, name } = splitFilePath(relativePath)
  const mode = options.mode ?? 0o600
  return withConfinedDir(root, parent, options.createDirs === true, async (dir) => {
    const target = childPath(dir, name)
    const existing = await fs.lstat(target).catch((error) => {
      if (errnoOf(error) === 'ENOENT') return null
      throw error
    })
    if (existing && !options.overwrite) return 'skipped'
    if (!existing) {
      try {
        await writeNewFile(target, content, mode)
        return 'created'
      } catch (error) {
        // Lost a race with a concurrent creator: same answer as "already there".
        if (errnoOf(error) === 'EEXIST' && !options.overwrite) return 'skipped'
        if (errnoOf(error) !== 'EEXIST') throw error
      }
    }
    const current = await fs.lstat(target)
    if (current.isSymbolicLink()) throw new ConfinedFsError('symlink')
    if (!current.isFile()) throw new ConfinedFsError('not-a-file')
    const temp = childPath(dir, `.ficus-upload-${randomBytes(8).toString('hex')}`)
    await writeNewFile(temp, content, mode)
    try {
      await fs.rename(temp, target)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      if (errnoOf(error) === 'EISDIR' || errnoOf(error) === 'ENOTDIR') throw new ConfinedFsError('not-a-file')
      throw error
    }
    return 'overwritten'
  })
}

import { randomUUID } from 'node:crypto'
import { constants as C } from 'node:fs'
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { z } from 'zod'

const DIRECTORY_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK
const FILE_FLAGS = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK
const fileName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
type Options = { uid?: number; maxBytes?: number }

/** Descriptor-relative, no-follow walk. Host runtime is Linux-only. Root/ancestors must be
 * operator-owned and not writable by another user (root-owned sticky /tmp supports fixtures).
 */
async function openPrivateDirectory(path: string, uid: number, privateLeaf = true): Promise<FileHandle> {
  if (process.platform !== 'linux' || !isAbsolute(path) || resolve(path) !== path || path === '/') throw new Error()
  let directory = await open('/', DIRECTORY_FLAGS)
  try {
    for (const component of path.slice(1).split('/')) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, DIRECTORY_FLAGS)
      await directory.close()
      directory = next
      const info = await directory.stat()
      const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0
      if ((info.uid !== 0 && info.uid !== uid) || ((info.mode & 0o022) !== 0 && !stickyRoot)) throw new Error()
    }
    const leaf = await directory.stat()
    if (leaf.uid !== uid || (leaf.mode & (privateLeaf ? 0o077 : 0o022)) !== 0) throw new Error()
    return directory
  } catch (error) {
    await directory.close().catch(() => {})
    throw error
  }
}
function checkedName(name: string): void {
  if (!fileName.test(name) || name === '.' || name === '..') throw new Error()
}
function checkedBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16384) throw new Error()
}

export async function readPrivateJson<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T>,
  options: Options = {}
): Promise<T> {
  return readOwnedJson(directory, name, schema, options, true)
}

/** Nonsecret root-written JSON; shares the full descriptor-relative nofollow walk, but
 * requires mode0644 and an owner-writable-only directory. No private auth-file fallback.
 */
export async function readPublicJson<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T>,
  options: Options = {}
): Promise<T> {
  return readOwnedJson(directory, name, schema, options, false)
}
async function readOwnedJson<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T>,
  options: Options,
  privateFile: boolean
): Promise<T> {
  let dir: FileHandle | undefined
  let file: FileHandle | undefined
  try {
    checkedName(name)
    const uid = options.uid ?? 0
    const maxBytes = options.maxBytes ?? 16384
    checkedBudget(maxBytes)
    dir = await openPrivateDirectory(directory, uid, privateFile)
    file = await open(`/proc/self/fd/${dir.fd}/${name}`, FILE_FLAGS)
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== uid ||
      (info.mode & 0o777) !== (privateFile ? 0o600 : 0o644) ||
      info.size > maxBytes
    )
      throw new Error()
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
    return schema.parse(JSON.parse(text))
  } catch {
    throw new Error('storage_unavailable')
  } finally {
    await file?.close().catch(() => {})
    await dir?.close().catch(() => {})
  }
}

/** Atomic fsynced replacement beneath the held private directory descriptor. Never follows
 * symlinks or edits an existing inode (which could otherwise be a hard link outside the store).
 */
export async function writePrivateJson<T>(
  directory: string,
  name: string,
  value: unknown,
  schema: z.ZodType<T>,
  options: Options = {}
): Promise<void> {
  let dir: FileHandle | undefined
  let file: FileHandle | undefined
  let temp: string | undefined
  try {
    checkedName(name)
    const uid = options.uid ?? 0
    const maxBytes = options.maxBytes ?? 16384
    checkedBudget(maxBytes)
    const bytes = Buffer.from(JSON.stringify(schema.parse(value)) + '\n')
    if (bytes.byteLength > maxBytes) throw new Error()
    dir = await openPrivateDirectory(directory, uid)
    const target = `/proc/self/fd/${dir.fd}/${name}`
    const existing = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      existing &&
      (!existing.isFile() || existing.nlink !== 1 || existing.uid !== uid || (existing.mode & 0o777) !== 0o600)
    )
      throw new Error()
    temp = `/proc/self/fd/${dir.fd}/.${randomUUID()}.tmp`
    file = await open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    const info = await file.stat()
    if (info.uid !== uid) throw new Error()
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temp, target)
    temp = undefined
    await dir.sync()
  } catch {
    throw new Error('storage_unavailable')
  } finally {
    await file?.close().catch(() => {})
    if (temp) await unlink(temp).catch(() => {})
    await dir?.close().catch(() => {})
  }
}

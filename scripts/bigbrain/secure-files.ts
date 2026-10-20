import { randomUUID } from 'node:crypto'
import { constants as C } from 'node:fs'
import { lstat, open, rename, unlink, mkdir, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve, dirname, basename } from 'node:path'
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
function checkedAssetName(name: string): void {
  if (!/^[a-zA-Z0-9_@][a-zA-Z0-9_.@\\-]{0,254}$/.test(name) || name === '.' || name === '..') throw new Error()
}
function checkedBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16384) throw new Error()
}

/** Create one direct child beneath a held, fully checked parent. Existing directories
 * must already match; never repair/chmod a foreign path or recurse through symlinks.
 */
export async function ensureOwnedDirectory(
  path: string,
  mode: 0o700 | 0o711 | 0o750 | 0o755,
  options: Pick<Options, 'uid'> = {}
): Promise<void> {
  let parent: FileHandle | undefined
  let child: FileHandle | undefined
  try {
    if (![0o700, 0o711, 0o750, 0o755].includes(mode) || !isAbsolute(path) || resolve(path) !== path) throw new Error()
    const uid = options.uid ?? 0
    const name = basename(path)
    checkedName(name)
    parent = await openPrivateDirectory(dirname(path), uid, false)
    const target = `/proc/self/fd/${parent.fd}/${name}`
    let created = false
    try {
      await mkdir(target, { mode: 0o700 })
      created = true
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
    }
    child = await open(target, DIRECTORY_FLAGS)
    const info = await child.stat()
    if (info.uid !== uid || (!created && (info.mode & 0o777) !== mode)) throw new Error()
    if (created) {
      await child.chmod(mode)
      await child.sync()
      await parent.sync()
    }
  } catch {
    throw new Error('storage_unavailable')
  } finally {
    await child?.close().catch(() => {})
    await parent?.close().catch(() => {})
  }
}

/** Pins a large root-private image without loading it; caller MUST close and bound reads.
 * All ancestors and final type/owner/mode/link count are checked before returning the FD.
 */
export async function openPrivateFile(
  directory: string,
  name: string,
  options: Pick<Options, 'uid'> = {}
): Promise<FileHandle> {
  return openOwnedFile(directory, name, options.uid ?? 0, true)
}
async function openOwnedFile(
  directory: string,
  name: string,
  uid: number,
  privateFile: boolean,
  assetName = false
): Promise<FileHandle> {
  let dir: FileHandle | undefined
  let file: FileHandle | undefined
  try {
    if (assetName) checkedAssetName(name)
    else checkedName(name)
    dir = await openPrivateDirectory(directory, uid, privateFile)
    file = await open(`/proc/self/fd/${dir.fd}/${name}`, FILE_FLAGS)
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== (privateFile ? 0o600 : 0o644))
      throw new Error()
    return file
  } catch {
    await file?.close().catch(() => {})
    throw new Error('storage_unavailable')
  } finally {
    await dir?.close().catch(() => {})
  }
}

export async function readPrivateJson<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: Options = {}
): Promise<T> {
  return readOwnedJson(directory, name, schema, options, false)
}
async function readOwnedJson<T>(
  directory: string,
  name: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: Options,
  privateFile: boolean
): Promise<T> {
  let file: FileHandle | undefined
  try {
    const maxBytes = options.maxBytes ?? 16384
    checkedBudget(maxBytes)
    file = await openOwnedFile(directory, name, options.uid ?? 0, privateFile)
    return schema.parse(JSON.parse(await boundedText(file, maxBytes)))
  } catch {
    throw new Error('storage_unavailable')
  } finally {
    await file?.close().catch(() => {})
  }
}

async function boundedText(file: FileHandle, maxBytes: number): Promise<string> {
  checkedBudget(maxBytes)
  if ((await file.stat()).size > maxBytes) throw new Error()
  const buffer = Buffer.alloc(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > maxBytes) throw new Error()
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
}
export async function readPublicText(directory: string, name: string, options: Options = {}): Promise<string> {
  let file: FileHandle | undefined
  try {
    file = await openOwnedFile(directory, name, options.uid ?? 0, false, true)
    return await boundedText(file, options.maxBytes ?? 16384)
  } catch {
    throw new Error('storage_unavailable')
  } finally {
    await file?.close().catch(() => {})
  }
}

/** Atomic fsynced replacement beneath the held private directory descriptor. Never follows
 * symlinks or edits an existing inode (which could otherwise be a hard link outside the store).
 */
export async function writePrivateJson<T>(
  directory: string,
  name: string,
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: Options = {}
): Promise<void> {
  try {
    checkedName(name)
    await writeOwnedBytes(directory, name, Buffer.from(JSON.stringify(schema.parse(value)) + '\n'), 0o600, options)
  } catch {
    throw new Error('storage_unavailable')
  }
}

/** Credential-free public manifests. Keep schema validation at this boundary. */
export async function writePublicJson<T>(
  directory: string,
  name: string,
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: Options = {}
): Promise<void> {
  try {
    checkedName(name)
    await writeOwnedBytes(directory, name, Buffer.from(JSON.stringify(schema.parse(value)) + '\n'), 0o644, options)
  } catch {
    throw new Error('storage_unavailable')
  }
}
/** Generated nonsecret systemd/Caddy text only. Linux backslashes are literal filename
 * bytes (needed for systemd-escaped mount units), never directory separators.
 */
export async function writePublicText(
  directory: string,
  name: string,
  text: string,
  options: Options = {}
): Promise<void> {
  try {
    checkedAssetName(name)
    await writeOwnedBytes(directory, name, Buffer.from(text), 0o644, options)
  } catch {
    throw new Error('storage_unavailable')
  }
}

/** The fixed root-only helper launcher: operator-owned 0750, never group/other-writable. */
export async function writeOwnerExecutable(
  directory: string,
  name: string,
  text: string,
  options: Options = {}
): Promise<void> {
  try {
    checkedName(name)
    await writeOwnedBytes(directory, name, Buffer.from(text), 0o750, options)
  } catch {
    throw new Error('storage_unavailable')
  }
}

async function writeOwnedBytes(
  directory: string,
  name: string,
  bytes: Buffer,
  mode: 0o600 | 0o644 | 0o750,
  options: Options
): Promise<void> {
  let dir: FileHandle | undefined
  let file: FileHandle | undefined
  let temp: string | undefined
  try {
    const uid = options.uid ?? 0
    const maxBytes = options.maxBytes ?? 16384
    checkedBudget(maxBytes)
    if (bytes.byteLength > maxBytes) throw new Error()
    dir = await openPrivateDirectory(directory, uid, mode === 0o600)
    const target = `/proc/self/fd/${dir.fd}/${name}`
    const existing = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      existing &&
      (!existing.isFile() || existing.nlink !== 1 || existing.uid !== uid || (existing.mode & 0o777) !== mode)
    )
      throw new Error()
    temp = `/proc/self/fd/${dir.fd}/.${randomUUID()}.tmp`
    file = await open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    const info = await file.stat()
    if (info.uid !== uid) throw new Error()
    await file.writeFile(bytes)
    // Explicit FD chmod: caller's restrictive0077 umask must not make a public
    // replacement unreadable after rename; never chmod an existing target inode.
    await file.chmod(mode)
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

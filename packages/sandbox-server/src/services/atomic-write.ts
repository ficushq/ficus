import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

export type FileIdentity = { bytes: number; sha256: string }
export type AtomicWriteRequest = {
  path: string
  allowedRoots: string[]
  content: Uint8Array
  mode?: number
  expectedOriginal?: FileIdentity
  expectedResult?: FileIdentity
}
export type AtomicWriteResult = { bytesWritten: number; sha256: string }
export type AtomicWriteFailureCode = 'edit-conflict' | 'pre-publication' | 'post-publication' | 'rename-outcome-unknown'
export type StageHandle = {
  writeAll(bytes: Uint8Array): Promise<void>
  readAt(offset: number, length: number): Promise<Buffer>
  chmod(mode: number): Promise<void>
  sync(): Promise<void>
  stat(): Promise<{ dev: number | bigint; ino: number | bigint; mode: number }>
  close(): Promise<void>
}
export type DestinationState = { identity: FileIdentity; mode: number }
export type AtomicWriteOperations = {
  resolveDestination(path: string, allowedRoots: string[]): Promise<string>
  withPathMutationQueue<T>(key: string, work: () => Promise<T>): Promise<T>
  readDestination(path: string): Promise<DestinationState | undefined>
  openStage(path: string, flags: 'wx+', mode: 0o600): Promise<StageHandle>
  statPath(path: string): Promise<{ dev: number | bigint; ino: number | bigint; mode: number }>
  readPath(path: string): Promise<Buffer>
  rename(from: string, to: string): Promise<void>
  removeOwnedStage(path: string): Promise<void>
  capturedUmask: number
}

const queues = new Map<string, Promise<void>>()
const PAGE_BYTES = 1024 * 1024
const MAX_ERROR_BYTES = 512

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const identity = (value: Uint8Array): FileIdentity => ({ bytes: value.byteLength, sha256: sha256(value) })
const sameIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.bytes === right.bytes && left.sha256 === right.sha256

export type AtomicFilesystemClass = 'permission-denied' | 'read-only-filesystem' | 'no-space'

class PublicAtomicWriteError extends Error {
  constructor(
    message: string,
    readonly failureCode: AtomicWriteFailureCode,
    readonly errno?: 'EACCES' | 'EROFS' | 'ENOSPC',
    readonly filesystemClass?: AtomicFilesystemClass
  ) {
    super(message)
  }
}

function primaryError(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error
  return error.errors.length > 0 ? primaryError(error.errors[0]) : undefined
}

export function getAtomicWriteFailureCode(error: unknown): AtomicWriteFailureCode | undefined {
  const primary = primaryError(error)
  if (!(primary instanceof PublicAtomicWriteError)) return undefined
  return primary.failureCode
}

export function getAtomicWriteFailureDetails(error: unknown): {
  errno?: 'EACCES' | 'EROFS' | 'ENOSPC'
  filesystemClass?: AtomicFilesystemClass
} {
  const primary = primaryError(error)
  return primary instanceof PublicAtomicWriteError
    ? { errno: primary.errno, filesystemClass: primary.filesystemClass }
    : {}
}

function boundUtf8(message: string): string {
  if (Buffer.byteLength(message) <= MAX_ERROR_BYTES) return message
  const codePoints: string[] = []
  let bytes = 0
  for (const codePoint of message) {
    const nextBytes = Buffer.byteLength(codePoint)
    if (bytes + nextBytes > MAX_ERROR_BYTES) break
    codePoints.push(codePoint)
    bytes += nextBytes
  }
  return codePoints.join('')
}

function filesystemDetails(error: unknown): {
  errno?: 'EACCES' | 'EROFS' | 'ENOSPC'
  filesystemClass?: AtomicFilesystemClass
} {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code === 'EACCES') return { errno: code, filesystemClass: 'permission-denied' }
  if (code === 'EROFS') return { errno: code, filesystemClass: 'read-only-filesystem' }
  if (code === 'ENOSPC') return { errno: code, filesystemClass: 'no-space' }
  return {}
}

function sanitizeError(error: unknown, fallback: PublicAtomicWriteError): Error {
  if (error instanceof PublicAtomicWriteError) {
    return new PublicAtomicWriteError(boundUtf8(error.message), error.failureCode, error.errno, error.filesystemClass)
  }
  const details = filesystemDetails(error)
  const suffix = details.errno ? `; filesystem error ${details.errno} (${details.filesystemClass})` : ''
  return new PublicAtomicWriteError(
    boundUtf8(`${fallback.message}${suffix}`),
    fallback.failureCode,
    details.errno,
    details.filesystemClass
  )
}

function errorComponents(error: Error): Error[] {
  return error instanceof AggregateError
    ? error.errors.flatMap((component) =>
        errorComponents(component instanceof Error ? component : new Error('Atomic write failed'))
      )
    : [error]
}

function aggregateErrors(primary: Error, secondary: Error): AggregateError {
  const errors = [...errorComponents(primary), ...errorComponents(secondary)]
  return new AggregateError(errors, errors[0].message, { cause: errors[0] })
}

function prePublicationError(
  category: string,
  failureCode: 'edit-conflict' | 'pre-publication' = 'pre-publication'
): PublicAtomicWriteError {
  return new PublicAtomicWriteError(`${category}; candidate was not published by this writer`, failureCode)
}

function publishedError(category: string): PublicAtomicWriteError {
  return new PublicAtomicWriteError(
    `${category}; candidate may have been published; success was not reported`,
    'post-publication'
  )
}

function renameOutcomeError(): PublicAtomicWriteError {
  return new PublicAtomicWriteError(
    'Atomic write rename failed; publication outcome follows filesystem rename semantics; success was not reported',
    'rename-outcome-unknown'
  )
}

function withinRoot(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

export async function resolveAtomicWriteDestination(path: string, allowedRoots: string[]): Promise<string> {
  const roots = await Promise.all(allowedRoots.map((root) => fs.realpath(resolve(root))))
  let link: Awaited<ReturnType<typeof fs.lstat>> | undefined
  try {
    link = await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  let destination: string
  if (!link) {
    destination = join(await fs.realpath(dirname(path)), basename(path))
  } else if (link.isSymbolicLink()) {
    try {
      destination = await fs.realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw prePublicationError('Atomic write rejected dangling destination symlink')
      }
      throw error
    }
    if (!(await fs.stat(destination)).isFile()) {
      throw prePublicationError('Atomic write rejected non-regular destination')
    }
  } else {
    if (!link.isFile()) throw prePublicationError('Atomic write rejected unsupported destination type')
    destination = join(await fs.realpath(dirname(path)), basename(path))
  }

  if (!roots.some((root) => withinRoot(destination, root))) {
    throw prePublicationError('Atomic write destination is outside allowed roots')
  }
  return destination
}

export async function withPathMutationQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue
  })
  queues.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}

function nodeStageHandle(file: FileHandle): StageHandle {
  return {
    writeAll: (bytes) => file.writeFile(bytes),
    readAt: async (offset, length) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    },
    chmod: (mode) => file.chmod(mode),
    sync: () => file.sync(),
    stat: async () => {
      const value = await file.stat()
      return { dev: value.dev, ino: value.ino, mode: value.mode & 0o777 }
    },
    close: () => file.close(),
  }
}

export function createNodeAtomicWriteOperations(): AtomicWriteOperations {
  return {
    resolveDestination: resolveAtomicWriteDestination,
    withPathMutationQueue,
    readDestination: async (path) => {
      try {
        const stats = await fs.stat(path)
        if (!stats.isFile()) throw prePublicationError('Atomic write rejected non-regular destination')
        const bytes = await fs.readFile(path)
        return { identity: identity(bytes), mode: stats.mode & 0o777 }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    openStage: async (path, flags, mode) => nodeStageHandle(await fs.open(path, flags, mode)),
    statPath: async (path) => {
      const value = await fs.stat(path)
      return { dev: value.dev, ino: value.ino, mode: value.mode & 0o777 }
    },
    readPath: async (path) => Buffer.from(await fs.readFile(path)),
    rename: (from, to) => fs.rename(from, to),
    removeOwnedStage: (path) => fs.rm(path, { force: true }),
    capturedUmask: process.umask(),
  }
}

async function readHandleIdentity(
  handle: StageHandle,
  expectedBytes: number,
  published: boolean
): Promise<FileIdentity> {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < expectedBytes) {
    const chunk = await handle.readAt(offset, Math.min(PAGE_BYTES, expectedBytes - offset))
    if (chunk.byteLength === 0) {
      const category = 'Atomic write handle readback made no progress'
      throw published ? publishedError(category) : prePublicationError(category)
    }
    chunks.push(chunk)
    offset += chunk.byteLength
  }
  if ((await handle.readAt(offset, 1)).byteLength !== 0) {
    const category = 'Atomic write handle readback exceeded expected bytes'
    throw published ? publishedError(category) : prePublicationError(category)
  }
  return identity(Buffer.concat(chunks, offset))
}

export async function atomicVerifiedWrite(
  request: AtomicWriteRequest,
  operations: AtomicWriteOperations = createNodeAtomicWriteOperations()
): Promise<AtomicWriteResult> {
  let destination: string
  try {
    destination = await operations.resolveDestination(request.path, request.allowedRoots)
  } catch (error) {
    throw sanitizeError(error, prePublicationError('Atomic write destination resolution failed'))
  }
  return operations.withPathMutationQueue(destination, async () => {
    const content = Buffer.from(request.content)
    const resultIdentity = identity(content)
    if (request.expectedResult && !sameIdentity(resultIdentity, request.expectedResult)) {
      throw prePublicationError('Atomic write request identity mismatch')
    }

    let initial: DestinationState | undefined
    try {
      initial = await operations.readDestination(destination)
    } catch (error) {
      throw sanitizeError(error, prePublicationError('Atomic write destination observation failed'))
    }
    if (request.expectedOriginal && (!initial || !sameIdentity(initial.identity, request.expectedOriginal))) {
      throw prePublicationError('Edit conflict: destination no longer matched the snapshot', 'edit-conflict')
    }
    const finalMode = request.mode ?? initial?.mode ?? 0o666 & ~operations.capturedUmask
    const stagePath = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: StageHandle | undefined
    let ownsStage = false
    let primary: Error | undefined
    let result: AtomicWriteResult | undefined
    let published = false

    try {
      handle = await operations.openStage(stagePath, 'wx+', 0o600)
      ownsStage = true
      await handle.writeAll(content)
      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, false), resultIdentity)) {
        throw prePublicationError('Atomic write staged byte identity mismatch')
      }
      await handle.chmod(finalMode)
      await handle.sync()

      if (request.expectedOriginal) {
        const observed = await operations.readDestination(destination)
        if (!observed || !sameIdentity(observed.identity, request.expectedOriginal)) {
          throw prePublicationError('Edit conflict: destination no longer matched the snapshot', 'edit-conflict')
        }
      }

      try {
        await operations.rename(stagePath, destination)
        published = true
      } catch (error) {
        throw sanitizeError(error, renameOutcomeError())
      }

      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, true), resultIdentity)) {
        throw publishedError('Atomic write publication verification failed after atomic rename')
      }
      const handleStat = await handle.stat()
      const pathStat = await operations.statPath(destination)
      if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
        throw publishedError('Atomic write published inode verification failed')
      }
      if ((finalMode & 0o444) !== 0) {
        if (!sameIdentity(identity(await operations.readPath(destination)), resultIdentity)) {
          throw publishedError('Atomic write published pathname readback failed')
        }
      }
      result = { bytesWritten: resultIdentity.bytes, sha256: resultIdentity.sha256 }
    } catch (error) {
      primary = sanitizeError(
        error,
        published
          ? publishedError('Atomic write publication operation failed')
          : prePublicationError('Atomic write pre-publication operation failed')
      )
    }

    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        const closeError = sanitizeError(
          error,
          published
            ? publishedError('Atomic write candidate handle close failed')
            : prePublicationError('Atomic write stage handle close failed')
        )
        primary = primary ? aggregateErrors(primary, closeError) : closeError
      }
    }

    let cleanupError: Error | undefined
    if (ownsStage) {
      try {
        await operations.removeOwnedStage(stagePath)
      } catch (error) {
        cleanupError = sanitizeError(
          error,
          published
            ? publishedError('Atomic write owned-stage cleanup failed')
            : prePublicationError('Atomic write owned-stage cleanup failed')
        )
      }
    }
    if (primary && cleanupError) throw aggregateErrors(primary, cleanupError)
    if (primary) throw primary
    if (cleanupError) throw cleanupError
    return result!
  })
}

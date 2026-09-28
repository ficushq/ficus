import { dlopen, FFIType, ptr, toArrayBuffer, type Library, type Pointer } from 'bun:ffi'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { sanitizeAgentAttachmentName } from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('attachment-materialization')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EINTR = 4
const ENOENT = 2
const EEXIST = 17

type NativeAtSymbols = {
  openat(directoryFd: number, path: Pointer, flags: number): number
  mkdirat(directoryFd: number, path: Pointer, mode: number): number
  unlinkat(directoryFd: number, path: Pointer, flags: number): number
  linkat(oldDirectoryFd: number, oldPath: Pointer, newDirectoryFd: number, newPath: Pointer, flags: number): number
  mkstemp(template: Pointer): number
  errno(): Pointer
  atRemovedir: number
  directoryNotEmpty: number
}

let libc: Library<any> | undefined
let nativeSymbols: NativeAtSymbols | undefined

function readErrno(pointer: Pointer): number {
  return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true)
}

function loadNativeAt(): NativeAtSymbols {
  if (nativeSymbols) return nativeSymbols
  const target =
    process.platform === 'darwin'
      ? {
          libraries: ['libSystem.B.dylib'],
          errnoSymbol: '__error' as const,
          atRemovedir: 0x80,
          directoryNotEmpty: 66,
        }
      : process.platform === 'linux'
        ? {
            libraries: ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`, 'libc.so'],
            errnoSymbol: '__errno_location' as const,
            atRemovedir: 0x200,
            directoryNotEmpty: 39,
          }
        : null
  if (!target || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Unsupported attachment materialization platform: ${process.platform}/${process.arch}`)
  }
  // openat is deliberately declared with its non-creating three-argument ABI.
  // Creation uses fixed-arity mkstemp(3) + linkat(2), never openat's variadic mode.
  const signature = {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    mkstemp: { args: [FFIType.ptr], returns: FFIType.i32 },
    [target.errnoSymbol]: { args: [], returns: FFIType.ptr },
  } as const
  const failures: string[] = []
  for (const candidate of target.libraries) {
    try {
      libc = dlopen(candidate, signature)
      break
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!libc) throw new Error(`Attachment materialization syscalls unavailable (${failures.join('; ')})`)
  const symbols = libc.symbols as unknown as Record<string, (...args: any[]) => number | Pointer>
  nativeSymbols = {
    openat: symbols.openat as NativeAtSymbols['openat'],
    mkdirat: symbols.mkdirat as NativeAtSymbols['mkdirat'],
    unlinkat: symbols.unlinkat as NativeAtSymbols['unlinkat'],
    linkat: symbols.linkat as NativeAtSymbols['linkat'],
    mkstemp: symbols.mkstemp as NativeAtSymbols['mkstemp'],
    errno: symbols[target.errnoSymbol] as () => Pointer,
    atRemovedir: target.atRemovedir,
    directoryNotEmpty: target.directoryNotEmpty,
  }
  return nativeSymbols
}

function cPath(value: string, allowSlash = false): { buffer: Buffer; pointer: Pointer } {
  if ((!allowSlash && value.includes('/')) || value.includes('\0')) throw new Error('Invalid attachment component')
  const buffer = Buffer.from(`${value}\0`)
  return { buffer, pointer: ptr(buffer) }
}

class NativeAtError extends Error {
  constructor(
    readonly operation: string,
    readonly errno: number
  ) {
    super(`${operation} failed with errno ${errno}`)
    this.name = 'NativeAtError'
  }
}

function callNative(operation: string, call: () => number): { result: number; errno: number | null } {
  const native = loadNativeAt()
  while (true) {
    const result = call()
    if (result >= 0) return { result, errno: null }
    const errno = readErrno(native.errno())
    if (errno === EINTR) continue
    return { result, errno }
  }
}

function mkdirAt(directoryFd: number, component: string): void {
  const native = loadNativeAt()
  const path = cPath(component)
  const result = callNative('mkdirat(2)', () => native.mkdirat(directoryFd, path.pointer, 0o700))
  if (result.errno !== null && result.errno !== EEXIST) throw new NativeAtError('mkdirat(2)', result.errno)
}

function openAt(directoryFd: number, component: string, flags: number): number {
  const native = loadNativeAt()
  const path = cPath(component)
  const result = callNative('openat(2)', () => native.openat(directoryFd, path.pointer, flags))
  if (result.errno !== null) throw new NativeAtError('openat(2)', result.errno)
  return result.result
}

function unlinkAt(directoryFd: number, component: string, flags = 0): void {
  const native = loadNativeAt()
  const path = cPath(component)
  const result = callNative('unlinkat(2)', () => native.unlinkat(directoryFd, path.pointer, flags))
  if (result.errno !== null) throw new NativeAtError('unlinkat(2)', result.errno)
}

function unlinkStagingAt(directoryFd: number, component: string): void {
  try {
    unlinkAt(directoryFd, component)
  } catch (error) {
    if (!(error instanceof NativeAtError) || error.errno !== ENOENT) throw error
  }
}

interface TemporaryFile {
  fd: number
  path: string
  basename: string
}

export function materializationStagingRoot(privateRoot: string): string {
  return privateRoot
}

function createTemporaryFile(privateRoot: string): TemporaryFile {
  const native = loadNativeAt()
  const stagingRoot = materializationStagingRoot(privateRoot)
  const template = cPath(join(stagingRoot, '.tau-agent-attachment-XXXXXX'), true)
  const result = callNative('mkstemp(3)', () => native.mkstemp(template.pointer))
  if (result.errno !== null) throw new NativeAtError('mkstemp(3)', result.errno)
  const terminator = template.buffer.indexOf(0)
  const path = template.buffer.subarray(0, terminator).toString()
  return { fd: result.result, path, basename: path.slice(stagingRoot.length + 1) }
}

function linkTemporaryFile(
  file: TemporaryFile,
  sourceDirectoryFd: number,
  targetDirectoryFd: number,
  storedName: string
): boolean {
  const native = loadNativeAt()
  const source = cPath(file.basename)
  const target = cPath(storedName)
  const result = callNative('linkat(2)', () =>
    native.linkat(sourceDirectoryFd, source.pointer, targetDirectoryFd, target.pointer, 0)
  )
  if (result.errno === EEXIST) return false
  if (result.errno !== null) throw new NativeAtError('linkat(2)', result.errno)
  return true
}

interface PathIdentity {
  dev: bigint
  ino: bigint
}

function pathIdentity(path: string): PathIdentity {
  const named = lstatSync(path, { bigint: true })
  return { dev: named.dev, ino: named.ino }
}

function heldIdentity(fd: number): PathIdentity {
  const held = fstatSync(fd, { bigint: true })
  return { dev: held.dev, ino: held.ino }
}

function assertHeldIdentity(fd: number, expected: PathIdentity): void {
  const held = heldIdentity(fd)
  if (expected.dev !== held.dev || expected.ino !== held.ino) {
    throw new Error('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
  }
}

function assertHeldPath(fd: number, path: string): void {
  assertHeldIdentity(fd, pathIdentity(path))
}

function openHeldDirectory(
  parentFd: number,
  parentPath: string,
  component: string,
  expected = pathIdentity(join(parentPath, component))
): number {
  const fd = openAt(parentFd, component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    assertHeldIdentity(fd, expected)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function assertSafeRegularFile(fd: number, expectedSize: number): void {
  const stats = fstatSync(fd)
  if (!stats.isFile() || stats.size !== expectedSize) throw new Error('ATTACHMENT_MATERIALIZATION_CONFLICT')
}

function closeMaterializationDescriptors(fds: number[], published: boolean): void {
  const errors: unknown[] = []
  for (const fd of fds) {
    if (fd < 0) continue
    try {
      closeSync(fd)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 0) return
  const failure = new AggregateError(errors, 'Failed to close attachment materialization descriptors')
  if (published) log.warn('Ignoring descriptor close failure after attachment commit:', failure)
  else throw failure
}

/**
 * All untrusted/generated descendants are resolved by openat(2)/mkdirat(2)
 * relative to held directory descriptors. Fixed-arity mkstemp(3) creates a
 * candidate at the trusted private mount root, descriptor-anchors it before
 * writing, and linkat(2) publishes it within that filesystem without openat's
 * variadic ABI.
 */
export async function deleteMaterializedAttachment(
  privateRoot: string,
  attachmentId: string,
  storedName: string
): Promise<void> {
  if (!UUID_RE.test(attachmentId) || sanitizeAgentAttachmentName(storedName) !== storedName) {
    throw new Error('Invalid attachment components')
  }
  const native = loadNativeAt()
  const normalizedId = attachmentId.toLowerCase()
  const root = openSync(privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    assertHeldPath(root, privateRoot)
    const attachments = openHeldDirectory(root, privateRoot, 'chat-attachments')
    try {
      const directory = openHeldDirectory(attachments, join(privateRoot, 'chat-attachments'), normalizedId)
      try {
        try {
          unlinkAt(directory, storedName)
        } catch (error) {
          if (!(error instanceof NativeAtError) || error.errno !== ENOENT) throw error
        }
      } finally {
        closeSync(directory)
      }
      try {
        unlinkAt(attachments, normalizedId, native.atRemovedir)
      } catch (error) {
        if (
          !(error instanceof NativeAtError) ||
          (error.errno !== ENOENT && error.errno !== native.directoryNotEmpty && error.errno !== EEXIST)
        ) {
          throw error
        }
      }
    } finally {
      closeSync(attachments)
    }
  } finally {
    closeSync(root)
  }
}

export const descriptorRelativeFs = {
  mkdirAt,
  openAt,
  unlinkAt,
  unlinkStagingAt,
  createTemporaryFile,
  linkTemporaryFile,
  pathIdentity,
  heldIdentity,
  assertHeldIdentity,
  assertHeldPath,
  openHeldDirectory,
  assertSafeRegularFile,
  closeMaterializationDescriptors,
}

export interface MaterializationTestHooks {
  /** Test-only seams used to deterministically replace a generated directory. */
  afterAttachmentDirectoryCreated?: () => Promise<void>
  afterAttachmentDirectoryOpened?: () => Promise<void>
  beforePublish?: (stagingBasename: string) => Promise<void>
  afterPrePublishValidation?: (stagingBasename: string) => Promise<void>
  afterPublish?: () => Promise<void>
}

export async function materializeAttachmentBytes(
  privateRoot: string,
  attachmentId: string,
  storedName: string,
  bytes: Uint8Array,
  testHooks: MaterializationTestHooks = {}
): Promise<string> {
  if (!UUID_RE.test(attachmentId)) throw new Error('Invalid attachment id')
  if (sanitizeAgentAttachmentName(storedName) !== storedName) throw new Error('Invalid stored name')
  const normalizedId = attachmentId.toLowerCase()
  const attachmentsPath = join(privateRoot, 'chat-attachments')
  const directoryPath = join(attachmentsPath, normalizedId)
  const filePath = join(directoryPath, storedName)
  let published = false
  const root = openSync(privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    assertHeldPath(root, privateRoot)
    mkdirAt(root, 'chat-attachments')
    assertHeldPath(root, privateRoot)
    const attachmentsIdentity = pathIdentity(attachmentsPath)
    const attachments = openHeldDirectory(root, privateRoot, 'chat-attachments', attachmentsIdentity)
    try {
      mkdirAt(attachments, normalizedId)
      assertHeldPath(attachments, attachmentsPath)
      const directoryIdentity = pathIdentity(directoryPath)
      await testHooks.afterAttachmentDirectoryCreated?.()
      const directory = openHeldDirectory(attachments, attachmentsPath, normalizedId, directoryIdentity)
      try {
        await testHooks.afterAttachmentDirectoryOpened?.()
        assertHeldPath(directory, directoryPath)
        const temporary = createTemporaryFile(privateRoot)
        let stagingAnchored = false
        let stagingRemoved = false
        let finalCreated = false
        let finalFd = -1
        try {
          // Cleanup ownership begins immediately after mkstemp returns.
          fchmodSync(temporary.fd, 0o600)
          const temporaryIdentity = heldIdentity(temporary.fd)
          const stagingFd = openAt(
            root,
            temporary.basename,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          try {
            assertHeldIdentity(stagingFd, temporaryIdentity)
            assertHeldPath(stagingFd, temporary.path)
            stagingAnchored = true
          } finally {
            closeSync(stagingFd)
          }
          writeFileSync(temporary.fd, bytes)
          fsyncSync(temporary.fd)
          await testHooks.beforePublish?.(temporary.basename)
          // Revalidate every held component immediately before the commit syscall.
          assertHeldPath(root, privateRoot)
          assertHeldPath(attachments, attachmentsPath)
          assertHeldPath(directory, directoryPath)
          assertHeldPath(temporary.fd, temporary.path)
          const reanchoredStaging = openAt(
            root,
            temporary.basename,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          try {
            assertHeldIdentity(reanchoredStaging, temporaryIdentity)
          } finally {
            closeSync(reanchoredStaging)
          }
          if (testHooks.afterPrePublishValidation) {
            await testHooks.afterPrePublishValidation(temporary.basename)
          }
          finalCreated = linkTemporaryFile(temporary, root, directory, storedName)
          finalFd = openAt(directory, storedName, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
          assertSafeRegularFile(finalFd, bytes.byteLength)
          if (finalCreated) {
            // The final link is committed only after proving it is our staged inode.
            assertHeldIdentity(finalFd, temporaryIdentity)
            published = true
            try {
              unlinkStagingAt(root, temporary.basename)
              stagingRemoved = true
            } catch (error) {
              log.warn('Published attachment but could not remove staging link:', error)
            }
            try {
              await testHooks.afterPublish?.()
            } catch (error) {
              log.warn('Ignoring post-commit materialization hook failure:', error)
            }
            return filePath
          }
          unlinkStagingAt(root, temporary.basename)
          stagingRemoved = true
          if (!Buffer.from(readFileSync(finalFd)).equals(Buffer.from(bytes))) {
            throw new Error('ATTACHMENT_MATERIALIZATION_CONFLICT')
          }
          assertHeldPath(directory, directoryPath)
          assertHeldPath(finalFd, filePath)
        } catch (error) {
          let cleanupError: unknown
          if (!stagingRemoved) {
            try {
              if (stagingAnchored) unlinkStagingAt(root, temporary.basename)
              else unlinkSync(temporary.path)
            } catch (failure) {
              cleanupError = failure
            }
          }
          if (finalCreated && !published) {
            try {
              unlinkAt(directory, storedName)
            } catch (failure) {
              cleanupError = cleanupError ? new AggregateError([cleanupError, failure]) : failure
            }
          }
          if (cleanupError) throw new AggregateError([error, cleanupError], 'Attachment materialization cleanup failed')
          throw error
        } finally {
          closeMaterializationDescriptors([finalFd, temporary.fd], published)
        }
      } finally {
        closeMaterializationDescriptors([directory], published)
      }
    } finally {
      closeMaterializationDescriptors([attachments], published)
    }
  } finally {
    closeMaterializationDescriptors([root], published)
  }
  return filePath
}

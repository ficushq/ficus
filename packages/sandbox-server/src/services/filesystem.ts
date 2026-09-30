/**
 * Filesystem operations service.
 *
 * Provides Read, Write, List, Stat, and Mkdir endpoints for file operations
 * inside the sandbox. All paths are validated against allowed prefixes.
 */

import * as fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { resolvePath, resolvePathPolicy } from '../paths'
import {
  atomicVerifiedWrite,
  getAtomicWriteFailureCode,
  getAtomicWriteFailureDetails,
  type FileIdentity,
} from './atomic-write'

// --- Read ---

interface ReadRequest {
  path: string
  offset?: number
  limit?: number
}

export async function handleRead(req: ReadRequest): Promise<Response> {
  try {
    const absPath = resolvePath(req.path)
    const stats = await fs.stat(absPath)

    const readLimit = req.limit || 50 * 1024 // 50KB default
    const offset = req.offset || 0

    const fd = await fs.open(absPath, 'r')
    const buffer = Buffer.alloc(readLimit)
    const { bytesRead } = await fd.read(buffer, 0, readLimit, offset)
    await fd.close()

    const content = buffer.subarray(0, bytesRead)

    return Response.json({
      content: content.toString('base64'),
      totalSize: Number(stats.size),
      isBinary: detectBinary(content),
    })
  } catch (err: any) {
    const status = err.code === 'ENOENT' ? 404 : 500
    return Response.json({ error: err.message }, { status })
  }
}

// --- Write ---

interface WriteRequest {
  path: string
  content: string // canonical base64
  createDirs?: boolean
  /** Optional octal permission string (e.g. "0600"). */
  mode?: string
}

export interface VerifiedWriteRequest {
  path: string
  content: string
  expectedOriginal: FileIdentity
  expectedResult: FileIdentity
}

export interface VerifiedWriteResponse {
  bytesWritten: number
  sha256: string
}

const MODE_PATTERN = /^0[0-7]{3}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function invalidWriteRequest(): Response {
  return Response.json(
    { error: 'Invalid write request; candidate was not published', code: 'invalid-request', phase: 'pre-publication' },
    { status: 400 }
  )
}

function decodeCanonicalBase64(value: unknown): Buffer | undefined {
  // Canonicality is enforced ONLY by the decode→re-encode roundtrip. It is
  // exact: the re-encoding emits nothing but canonical base64, so equality
  // means the input was canonical (whitespace, wrong padding, non-alphabet
  // chars, and nonzero discarded bits all re-encode differently). Never guard
  // this with a whole-subject regex — Bun's regex engine (JSC/Yarr) silently
  // returns FALSE (no throw) when a repeat quantifier runs on a subject past
  // ~5.6M chars, which rejected every valid write above ~4MB of source bytes.
  if (typeof value !== 'string' || value.length % 4 !== 0) return undefined
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : undefined
}

function parseIdentity(value: unknown): FileIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) return undefined
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) return undefined
  if (Object.keys(record).some((key) => key !== 'bytes' && key !== 'sha256')) return undefined
  return { bytes: record.bytes as number, sha256: record.sha256 }
}

function contentIdentity(content: Buffer): FileIdentity {
  return {
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function atomicFailureResponse(error: unknown): Response {
  const code = getAtomicWriteFailureCode(error)
  const details = getAtomicWriteFailureDetails(error)
  const phase =
    code === 'post-publication'
      ? 'post-publication'
      : code === 'rename-outcome-unknown'
        ? 'rename-outcome-unknown'
        : 'pre-publication'
  const status = code === 'edit-conflict' ? 409 : 500
  const message =
    error instanceof Error && code
      ? error.message
      : 'Atomic write failed safely; candidate publication was not confirmed'
  return Response.json({ error: message, code: code ?? 'atomic-write-failed', phase, ...details }, { status })
}

export async function handleVerifiedWrite(req: unknown): Promise<Response> {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return invalidWriteRequest()
  const record = req as Record<string, unknown>
  const fields = new Set(['path', 'content', 'expectedOriginal', 'expectedResult'])
  if (typeof record.path !== 'string' || Object.keys(record).some((key) => !fields.has(key))) {
    return invalidWriteRequest()
  }
  const content = decodeCanonicalBase64(record.content)
  const expectedOriginal = parseIdentity(record.expectedOriginal)
  const expectedResult = parseIdentity(record.expectedResult)
  if (!content || !expectedOriginal || !expectedResult) return invalidWriteRequest()

  let policy: ReturnType<typeof resolvePathPolicy>
  try {
    policy = resolvePathPolicy(record.path)
  } catch {
    return invalidWriteRequest()
  }

  try {
    const result = await atomicVerifiedWrite({
      path: policy.path,
      allowedRoots: [policy.allowedRoot],
      content,
      expectedOriginal,
      expectedResult,
    })
    return Response.json(result satisfies VerifiedWriteResponse)
  } catch (error) {
    return atomicFailureResponse(error)
  }
}

export async function handleWrite(req: WriteRequest): Promise<Response> {
  if (!req || typeof req !== 'object' || typeof req.path !== 'string') return invalidWriteRequest()
  if (req.createDirs !== undefined && typeof req.createDirs !== 'boolean') return invalidWriteRequest()
  let mode: number | undefined
  if (req.mode !== undefined) {
    if (typeof req.mode !== 'string' || !MODE_PATTERN.test(req.mode)) return invalidWriteRequest()
    mode = parseInt(req.mode, 8)
  }
  const content = decodeCanonicalBase64(req.content)
  if (!content) return invalidWriteRequest()

  let policy: ReturnType<typeof resolvePathPolicy>
  try {
    policy = resolvePathPolicy(req.path)
  } catch {
    return Response.json(
      { error: 'Legacy write path was rejected; candidate was not published', phase: 'pre-publication' },
      { status: 500 }
    )
  }
  if (req.createDirs) {
    try {
      await fs.mkdir(path.dirname(policy.path), { recursive: true })
    } catch {
      return Response.json(
        { error: 'Legacy write directory creation failed; candidate was not published', phase: 'pre-publication' },
        { status: 500 }
      )
    }
  }

  try {
    const result = await atomicVerifiedWrite({
      path: policy.path,
      allowedRoots: [policy.allowedRoot],
      content,
      mode,
      expectedResult: contentIdentity(content),
    })
    return Response.json(result)
  } catch (error) {
    return atomicFailureResponse(error)
  }
}

// --- Upload (raw bytes, no base64/JSON envelope) ---

/**
 * Raw-body upload: `POST /upload?path=<uriencoded>[&createDirs=true][&mode=0644]`
 * with the file bytes as the request body (application/octet-stream).
 *
 * This is the large-file transport: the JSON `/write` path base64-encodes the
 * content (+33% on the wire, a multi-megabyte string materialized on both
 * sides) and is bounded by the server's JSON body cap. Here the bytes arrive
 * untranscoded and go through the same path policy + atomic publication as
 * `/write` (staged candidate, verified rename — a partial upload is never
 * visible at the destination path).
 */
export async function handleUpload(url: URL, req: Request): Promise<Response> {
  const filePath = url.searchParams.get('path')
  if (!filePath) return invalidWriteRequest()
  const modeParam = url.searchParams.get('mode') ?? undefined
  let mode: number | undefined
  if (modeParam !== undefined) {
    if (!MODE_PATTERN.test(modeParam)) return invalidWriteRequest()
    mode = parseInt(modeParam, 8)
  }

  let policy: ReturnType<typeof resolvePathPolicy>
  try {
    policy = resolvePathPolicy(filePath)
  } catch {
    return invalidWriteRequest()
  }

  let content: Buffer
  try {
    content = Buffer.from(await req.arrayBuffer())
  } catch {
    return Response.json(
      { error: 'Failed to read upload body; candidate was not published', phase: 'pre-publication' },
      { status: 400 }
    )
  }

  if (url.searchParams.get('createDirs') === 'true') {
    try {
      await fs.mkdir(path.dirname(policy.path), { recursive: true })
    } catch {
      return Response.json(
        { error: 'Upload directory creation failed; candidate was not published', phase: 'pre-publication' },
        { status: 500 }
      )
    }
  }

  try {
    const result = await atomicVerifiedWrite({
      path: policy.path,
      allowedRoots: [policy.allowedRoot],
      content,
      mode,
      expectedResult: contentIdentity(content),
    })
    return Response.json(result)
  } catch (error) {
    return atomicFailureResponse(error)
  }
}

// --- Mkdir ---

interface MkdirRequest {
  path: string
}

/**
 * Structured directory creation. The path arrives as a JSON field and goes
 * straight to `fs.mkdir` — never through a shell — so callers (e.g. the coding
 * tools' pre-write `ops.mkdir`) can create directories for agent-controlled
 * paths without any shell-metacharacter injection surface. The same
 * `resolvePath` allow-prefix guard as every other fs endpoint bounds the path.
 */
export async function handleMkdir(req: MkdirRequest): Promise<Response> {
  try {
    const absPath = resolvePath(req.path)
    await fs.mkdir(absPath, { recursive: true })
    return Response.json({ ok: true })
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// --- List ---

interface ListRequest {
  path: string
  recursive?: boolean
  maxDepth?: number
}

interface FileInfo {
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

export async function handleList(req: ListRequest): Promise<Response> {
  try {
    const absPath = resolvePath(req.path)
    const maxDepth = req.maxDepth || (req.recursive ? 10 : 1)

    const files: FileInfo[] = []
    await listDir(absPath, absPath, files, 0, maxDepth)

    return Response.json({ files })
  } catch (err: any) {
    const status = err.code === 'ENOENT' ? 404 : 500
    return Response.json({ error: err.message }, { status })
  }
}

async function listDir(
  basePath: string,
  dirPath: string,
  results: FileInfo[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth >= maxDepth) return

  const entries = await fs.readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    const relativePath = path.relative(basePath, fullPath)

    try {
      const stats = await fs.stat(fullPath)
      results.push({
        path: relativePath,
        isDirectory: entry.isDirectory(),
        size: Number(stats.size),
        modifiedAt: Math.floor(stats.mtimeMs / 1000),
      })

      if (entry.isDirectory()) {
        await listDir(basePath, fullPath, results, depth + 1, maxDepth)
      }
    } catch {
      // Skip files we can't stat (permissions, broken symlinks)
    }
  }
}

// --- Stat ---

interface StatRequest {
  path: string
}

export async function handleStat(req: StatRequest): Promise<Response> {
  try {
    const absPath = resolvePath(req.path)

    const stats = await fs.stat(absPath)
    const isReadable = await fs
      .access(absPath, fsConstants.R_OK)
      .then(() => true)
      .catch(() => false)
    const isWritable = await fs
      .access(absPath, fsConstants.W_OK)
      .then(() => true)
      .catch(() => false)

    return Response.json({
      exists: true,
      isDirectory: stats.isDirectory(),
      isReadable,
      isWritable,
      size: Number(stats.size),
    })
  } catch {
    return Response.json({
      exists: false,
      isDirectory: false,
      isReadable: false,
      isWritable: false,
      size: 0,
    })
  }
}

// --- Helpers ---

function detectBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

interface MaterializeAttachmentRequest {
  privateRoot: string
  attachmentId: string
  storedName: string
  content: string
}

const ATTACHMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ATTACHMENT_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/

/**
 * The k8s sandbox executor is shipped only in Linux sandbox images. Its procfs
 * descriptor walk is intentionally Linux-specific and must fail closed if the
 * package is ever started directly on another host OS.
 */
export function assertLinuxAttachmentFilesystemPlatform(platform = process.platform): void {
  if (platform !== 'linux') throw new Error(`Attachment filesystem requires Linux procfs; received ${platform}`)
}

async function mkdirAt(directoryFd: number, component: string): Promise<void> {
  try {
    await fs.mkdir(`/proc/self/fd/${directoryFd}/${component}`, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Descriptor-relative attachment materialization; ordinary writes retain their existing behavior. */
export async function handleMaterializeAttachment(req: MaterializeAttachmentRequest): Promise<Response> {
  assertLinuxAttachmentFilesystemPlatform()
  if (
    !ATTACHMENT_UUID_RE.test(req.attachmentId) ||
    !ATTACHMENT_NAME_RE.test(req.storedName) ||
    req.storedName.endsWith('.')
  ) {
    return Response.json({ error: 'invalid attachment components' }, { status: 400 })
  }
  try {
    const privateRoot = resolvePath(req.privateRoot)
    const id = req.attachmentId.toLowerCase()
    const root = await fs.open(privateRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    try {
      await mkdirAt(root.fd, 'chat-attachments')
      const attachments = await fs.open(
        `/proc/self/fd/${root.fd}/chat-attachments`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      )
      try {
        await mkdirAt(attachments.fd, id)
        const directory = await fs.open(
          `/proc/self/fd/${attachments.fd}/${id}`,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
        )
        try {
          const filePath = `/proc/self/fd/${directory.fd}/${req.storedName}`
          const content = Buffer.from(req.content, 'base64')
          try {
            const file = await fs.open(
              filePath,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
              0o600
            )
            try {
              await file.writeFile(content)
              await file.sync()
            } catch (error) {
              await file.close().catch(() => {})
              await fs.rm(filePath, { force: true }).catch(() => {})
              throw error
            } finally {
              await file.close().catch(() => {})
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            const existing = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
            try {
              if (!Buffer.from(await existing.readFile()).equals(content))
                throw new Error('ATTACHMENT_MATERIALIZATION_CONFLICT')
            } finally {
              await existing.close()
            }
          }
          return Response.json({ bytesWritten: content.length })
        } finally {
          await directory.close()
        }
      } finally {
        await attachments.close()
      }
    } finally {
      await root.close()
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'materialization failed' }, { status: 500 })
  }
}

export async function handleDeleteMaterializedAttachment(
  req: Omit<MaterializeAttachmentRequest, 'content'>
): Promise<Response> {
  assertLinuxAttachmentFilesystemPlatform()
  if (!ATTACHMENT_UUID_RE.test(req.attachmentId) || !ATTACHMENT_NAME_RE.test(req.storedName)) {
    return Response.json({ error: 'invalid attachment components' }, { status: 400 })
  }
  try {
    const root = await fs.open(
      resolvePath(req.privateRoot),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    )
    try {
      const attachments = await fs.open(
        `/proc/self/fd/${root.fd}/chat-attachments`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      )
      try {
        const directory = await fs.open(
          `/proc/self/fd/${attachments.fd}/${req.attachmentId.toLowerCase()}`,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
        )
        try {
          await fs.rm(`/proc/self/fd/${directory.fd}/${req.storedName}`, { force: true })
        } finally {
          await directory.close()
        }
      } finally {
        await attachments.close()
      }
    } finally {
      await root.close()
    }
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'delete failed' }, { status: 500 })
  }
}

/**
 * File download utilities for workspace routes.
 *
 * Remote runtimes (vm, k8s) stream through the sandbox server's raw
 * `GET /download` route: Core forwards the box's body stream as-is, so neither
 * side materializes the file and memory stays flat for any size. See
 * docs/wiki/k8s/sandbox.md ("GET /download") for the transport and the
 * outdated-bundle fallback rule.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { TarArchive, ZipArchive } from 'archiver'
import { downloadDisposition } from '../../services/attachments/http'
import {
  SandboxDownloadRouteMissingError,
  SandboxHttpError,
  type SandboxDownloadResponse,
} from '../../services/sandbox/client/http-client'

export interface SandboxFileClient {
  stat(request: { path: string }): Promise<{ exists?: boolean; size: number; isDirectory: boolean }>
  read(request: { path: string; limit?: number }): Promise<{ content: string; totalSize: number }>
  download(request: { path: string; range?: string; signal?: AbortSignal }): Promise<SandboxDownloadResponse>
  downloadArchive(request: { path: string; signal?: AbortSignal }): Promise<SandboxDownloadResponse>
}

/**
 * Largest file still served through the legacy base64 `/read` envelope when
 * the box bundle predates `GET /download`. `/read` allocates the whole file on
 * the box and again in Core (+33% base64); 256 MiB files failed with `Out of
 * memory` in production, so anything above this answers 503 instead.
 */
export const SANDBOX_READ_FALLBACK_MAX_BYTES = 64 * 1024 * 1024

/** Error code of the 503 answered when an outdated box bundle cannot serve a download. */
export const SANDBOX_BUNDLE_OUTDATED_CODE = 'SANDBOX_BUNDLE_OUTDATED'

/**
 * The exact body length of a download response. Bun.serve re-frames every
 * streamed body as chunked and drops a handler-set Content-Length
 * (oven-sh/bun#10507), so clients that verify completeness (the CLI) read
 * this header when Content-Length is absent.
 */
export const DOWNLOAD_LENGTH_HEADER = 'X-Ficus-Content-Length'

/** Set on directory downloads to name the archive format (`tar.gz` or `zip`). */
export const DOWNLOAD_ARCHIVE_HEADER = 'X-Ficus-Archive'

export type DownloadArchiveFormat = 'tar.gz' | 'zip'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
}

/**
 * Get MIME type for a file extension.
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parse a `Range` header against a file of `size` bytes — the same single-range
 * rules as the sandbox server's `/download`: `null` when absent, an inclusive
 * `{ start, end }`, or `'unsatisfiable'` (malformed, multi-range, past EOF).
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ParsedRange {
  if (header === null || header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'unsatisfiable'
  const [, rawStart, rawEnd] = match
  if ((rawStart === '' && rawEnd === '') || size === 0) return 'unsatisfiable'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable'
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

function rangeNotSatisfiable(size: number): Response {
  return Response.json(
    { error: 'Requested range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' },
    { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` } }
  )
}

function archiveName(targetPath: string, defaultName: string, format: DownloadArchiveFormat): string {
  return `${path.basename(targetPath) || defaultName}.${format}`
}

/**
 * Create a streaming zip Response for a directory.
 * Streams chunks as they're compressed - doesn't buffer the entire archive in memory.
 */
export function createZipResponse(targetPath: string, defaultName = 'download'): Response {
  return createLocalArchiveResponse(targetPath, defaultName, 'zip')
}

/** Stream a local directory as a zip (default) or tar.gz archive. */
export function createLocalArchiveResponse(
  targetPath: string,
  defaultName: string,
  format: DownloadArchiveFormat
): Response {
  const archive =
    format === 'zip'
      ? new ZipArchive({ zlib: { level: 5 } })
      : new TarArchive({ gzip: true, gzipOptions: { level: 5 } })
  const rootName = path.basename(targetPath) || defaultName

  // zip keeps its historical flat layout; tar.gz is rooted at the directory
  // name, matching `tar -czf - -C <parent> <name>` on sandbox runtimes.
  archive.directory(targetPath, format === 'zip' ? false : rootName)
  archive.finalize()

  // Convert Node.js stream to Web ReadableStream with proper backpressure
  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    headers: {
      'Content-Type': format === 'zip' ? 'application/zip' : 'application/gzip',
      'Content-Disposition': downloadDisposition(archiveName(targetPath, defaultName, format)),
      [DOWNLOAD_ARCHIVE_HEADER]: format,
      'Cache-Control': 'no-store',
    },
  })
}

export interface SandboxFileResponseOptions {
  /** The client's `Range` header, forwarded to the box. */
  range?: string | null
  /** Aborts the box request (e.g. the client disconnected). */
  signal?: AbortSignal
}

function outdatedBundleResponse(detail: string): Response {
  return Response.json(
    {
      error:
        `The sandbox server bundle is outdated and cannot stream ${detail}. ` +
        "Restart the agent's sandbox from the agent page, or recreate the squad sandbox, then retry. " +
        `Outdated sandboxes can only serve files up to ${SANDBOX_READ_FALLBACK_MAX_BYTES / (1024 * 1024)} MiB.`,
      code: SANDBOX_BUNDLE_OUTDATED_CODE,
    },
    { status: 503 }
  )
}

/**
 * Create a download Response for a sandbox file or directory.
 *
 * Streams the box's `GET /download` body straight through: a regular file
 * keeps the box's status (206 for a satisfied `Range`), length and
 * `Content-Range`; a directory streams as `<name>.tar.gz`. Nothing is
 * buffered in Core.
 *
 * Mid-rollout fallback: when the box bundle predates the route, files up to
 * {@link SANDBOX_READ_FALLBACK_MAX_BYTES} are still served (whole, ignoring
 * `Range`) through the legacy base64 `/read`; anything larger, and every
 * directory, answers 503 naming the fix. The base64 path is never attempted
 * for a file that could exhaust memory.
 *
 * Known misses answer JSON 404/416 Responses; unexpected failures throw.
 */
export async function createSandboxFileResponse(
  client: SandboxFileClient,
  filePath: string,
  filename = path.basename(filePath),
  options: SandboxFileResponseOptions = {}
): Promise<Response> {
  const stat = await client.stat({ path: filePath })
  if (stat.exists === false) return Response.json({ error: 'File not found' }, { status: 404 })

  if (stat.isDirectory) {
    let archive: SandboxDownloadResponse
    try {
      archive = await client.downloadArchive({ path: filePath, signal: options.signal })
    } catch (error) {
      if (error instanceof SandboxDownloadRouteMissingError) return outdatedBundleResponse('directory archives')
      if (error instanceof SandboxHttpError && error.status === 404) {
        return Response.json({ error: 'File not found' }, { status: 404 })
      }
      throw error
    }
    return new Response(archive.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': downloadDisposition(archiveName(filePath, 'download', 'tar.gz')),
        [DOWNLOAD_ARCHIVE_HEADER]: 'tar.gz',
        'Cache-Control': 'no-store',
      },
    })
  }

  const contentType = getMimeType(filename)
  let download: SandboxDownloadResponse
  try {
    download = await client.download({ path: filePath, range: options.range ?? undefined, signal: options.signal })
  } catch (error) {
    if (error instanceof SandboxDownloadRouteMissingError) {
      if (stat.size > SANDBOX_READ_FALLBACK_MAX_BYTES) return outdatedBundleResponse('files of this size')
      return legacyReadResponse(client, filePath, filename, contentType, stat.size)
    }
    if (error instanceof SandboxHttpError && error.status === 416) return rangeNotSatisfiable(stat.size)
    if (error instanceof SandboxHttpError && error.status === 404) {
      return Response.json({ error: 'File not found' }, { status: 404 })
    }
    throw error
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': downloadDisposition(filename),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  const length = download.headers.get('content-length')
  if (length !== null) {
    headers.set('Content-Length', length)
    headers.set(DOWNLOAD_LENGTH_HEADER, length)
  }
  for (const name of ['content-range', 'last-modified']) {
    const value = download.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(download.body, { status: download.status, headers })
}

/** The pre-`/download` transport: one base64 `/read` of the whole (bounded) file. */
async function legacyReadResponse(
  client: SandboxFileClient,
  filePath: string,
  filename: string,
  contentType: string,
  size: number
): Promise<Response> {
  const result = await client.read({ path: filePath, limit: size })
  const buffer = Buffer.from(result.content, 'base64')
  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': downloadDisposition(filename),
      'Content-Length': String(buffer.length),
      [DOWNLOAD_LENGTH_HEADER]: String(buffer.length),
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Create a download Response for a local file, streamed from disk (never
 * read into memory). Honors a single-range `Range` header like the sandbox
 * route: 206 with `Content-Range`, or 416.
 */
export function createFileResponse(targetPath: string, options: { range?: string | null } = {}): Response {
  const size = fs.statSync(targetPath).size
  const fileName = path.basename(targetPath)
  const contentType = getMimeType(targetPath)
  const range = parseRangeHeader(options.range, size)
  if (range === 'unsatisfiable') return rangeNotSatisfiable(size)

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': downloadDisposition(fileName),
    'Content-Length': String(length),
    [DOWNLOAD_LENGTH_HEADER]: String(length),
    'Accept-Ranges': 'bytes',
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body = length === 0 ? new Uint8Array(0) : Bun.file(targetPath).slice(start, end + 1)
  return new Response(body, { status: range ? 206 : 200, headers })
}

export interface DownloadResponseOptions {
  range?: string | null
  /** Directory archive format; zip unless the caller asked for tar.gz. */
  archive?: DownloadArchiveFormat
}

/**
 * Create a download Response for a file or directory.
 * Directories are streamed as zip archives (or tar.gz on request).
 */
export function createDownloadResponse(
  targetPath: string,
  defaultName = 'download',
  options: DownloadResponseOptions = {}
): Response {
  const stat = fs.statSync(targetPath)

  if (stat.isDirectory()) {
    return createLocalArchiveResponse(targetPath, defaultName, options.archive ?? 'zip')
  }

  return createFileResponse(targetPath, { range: options.range })
}

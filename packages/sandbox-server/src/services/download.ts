/**
 * Raw streaming download: `GET /download?path=<abs path>[&archive=tar.gz]`.
 *
 * The mirror image of `POST /upload`. `/read` base64-encodes the requested
 * window into a JSON envelope after `Buffer.alloc(limit)`, so asking it for a
 * whole multi-hundred-megabyte file allocates the file (plus a third) on the
 * box and again in Core — 256 MiB files failed with `Out of memory`. Here the
 * bytes are streamed from disk untranscoded and never materialized:
 *
 * - regular file → `application/octet-stream` with `Content-Length`,
 *   `Accept-Ranges: bytes` and `Last-Modified`; one `Range: bytes=…` range is
 *   honored (206 + `Content-Range`), an unsatisfiable, malformed or multi-range
 *   request is 416 with an unsatisfied-range `Content-Range` carrying the size;
 * - directory → 400 unless `archive=tar.gz`, which streams the stdout of
 *   `tar -czf - -C <parent> -- <basename>` as chunked `application/gzip`. A
 *   non-zero tar exit after the headers went out ERRORS the stream, so the
 *   client sees a truncated chunked body instead of a silent partial success.
 *   Each `exclude=<name>` leaves that direct child of the directory out of the
 *   archive, and the response lists the honored names in
 *   `X-Ficus-Archive-Excluded` so Core can tell this bundle from one that
 *   predates the parameter.
 *
 * The path goes through the same {@link resolvePath} policy as `/read` and
 * `/stat`; nothing here widens what a caller can reach. Every error body is
 * JSON `{ error, code }` — Core relies on the `code` to tell this route's
 * answers apart from an old bundle's plain-text `Not found` / `Method not
 * allowed` (see the Core client's `download()`).
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { resolvePath } from '../paths'

export type DownloadErrorCode =
  | 'invalid-request'
  | 'path-rejected'
  | 'not-found'
  | 'is-directory'
  | 'not-regular-file'
  | 'unsupported-archive'
  | 'range-not-satisfiable'
  | 'download-failed'

export interface DownloadHooks {
  /** Diagnostic logger (archive failures). Defaults to console.error. */
  log?: (message: string) => void
  /** tar executable; injectable for tests. */
  tarCommand?: string
}

export const SUPPORTED_ARCHIVE_FORMAT = 'tar.gz'

/** Response header naming the direct children a directory archive left out. */
export const ARCHIVE_EXCLUDED_HEADER = 'X-Ficus-Archive-Excluded'

/** An excluded child is one plain directory entry name: no separators, no `.`/`..`, no list delimiter. */
function isExcludableChildName(name: string): boolean {
  // eslint-disable-next-line no-control-regex -- control bytes are what this rejects
  return name !== '' && name !== '.' && name !== '..' && !/[/\\,\u0000-\u001f]/.test(name)
}

function errorResponse(status: number, code: DownloadErrorCode, error: string, headers?: HeadersInit): Response {
  return Response.json({ error, code }, { status, headers })
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parse a `Range` header against a file of `size` bytes. Returns `null` when
 * there is no header (serve the whole file), an inclusive `{ start, end }`
 * for one satisfiable range, or `'unsatisfiable'` for anything else
 * (malformed, non-`bytes` unit, multiple ranges, start past EOF, empty file).
 */
export function parseRangeHeader(header: string | null, size: number): ParsedRange {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'unsatisfiable'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'
  if (size === 0) return 'unsatisfiable'
  if (rawStart === '') {
    // Suffix range: the last N bytes.
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

export async function handleDownload(url: URL, req: Request, hooks: DownloadHooks = {}): Promise<Response> {
  const requested = url.searchParams.get('path')
  if (!requested) return errorResponse(400, 'invalid-request', 'path query parameter is required')

  let absPath: string
  try {
    absPath = resolvePath(requested)
  } catch (error) {
    return errorResponse(400, 'path-rejected', error instanceof Error ? error.message : 'Path rejected')
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(absPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return errorResponse(404, 'not-found', `Path not found: ${requested}`)
    return errorResponse(500, 'download-failed', error instanceof Error ? error.message : 'stat failed')
  }

  const archive = url.searchParams.get('archive')
  if (archive !== null && archive !== SUPPORTED_ARCHIVE_FORMAT) {
    return errorResponse(400, 'unsupported-archive', `Unsupported archive format: ${archive} (supported: tar.gz)`)
  }

  const exclude = url.searchParams.getAll('exclude')
  if (!exclude.every(isExcludableChildName)) {
    return errorResponse(400, 'invalid-request', 'exclude must name a direct child of the directory')
  }

  if (stats.isDirectory()) {
    if (archive !== SUPPORTED_ARCHIVE_FORMAT) {
      return errorResponse(400, 'is-directory', 'Path is a directory; request archive=tar.gz to download it')
    }
    return streamTarGz(absPath, req, hooks, exclude)
  }

  if (!stats.isFile()) return errorResponse(400, 'not-regular-file', 'Path is not a regular file')

  const size = Number(stats.size)
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': stats.mtime.toUTCString(),
  }
  const range = parseRangeHeader(req.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return errorResponse(416, 'range-not-satisfiable', 'Requested range not satisfiable', {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${size}`,
    })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(length) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (length === 0) return new Response(new Uint8Array(0), { status: 200, headers })

  // A native file body: Bun streams it from disk (sendfile where it can) and
  // keeps the Content-Length on the wire — a JS ReadableStream body would be
  // re-framed as chunked. The slice bounds the read even if the file grows
  // after the stat; a file that shrinks yields a short body, which the
  // client detects against Content-Length.
  return new Response(Bun.file(absPath).slice(start, end + 1), { status: range ? 206 : 200, headers })
}

function streamTarGz(absPath: string, req: Request, hooks: DownloadHooks, exclude: string[] = []): Response {
  const log = hooks.log ?? ((message: string) => console.error(`[sandbox] ${message}`))
  const parent = path.dirname(absPath)
  const base = path.basename(absPath)
  // `-f -` pins stdout (a build's default archive may be a tape device);
  // `--` keeps a basename that starts with `-` from parsing as an option.
  // `--anchored --no-wildcards` make each exclusion match exactly the member
  // `<base>/<name>` (and therefore everything below it), never a same-named
  // entry deeper in the tree or a name read as a glob.
  const exclusions = exclude.length
    ? ['--anchored', '--no-wildcards', ...exclude.map((name) => `--exclude=${base}/${name}`)]
    : []
  const proc = Bun.spawn([hooks.tarCommand ?? 'tar', '-czf', '-', ...exclusions, '-C', parent, '--', base], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(proc.stderr).text().catch(() => '')
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const stop = () => {
    if (!exited) proc.kill()
  }
  // The consumer went away before EOF: stop tar instead of letting it run on.
  req.signal?.addEventListener('abort', stop, { once: true })

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  // Pull-based with the default one-chunk high-water mark, so tar is
  // backpressured by the consumer through the pipe.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (!done) {
          controller.enqueue(value)
          return
        }
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          const detail = (await stderr).trim().slice(0, 500)
          log(`download archive failed: tar exited ${exitCode} for ${absPath}${detail ? `: ${detail}` : ''}`)
          // Erroring (not closing) aborts the chunked response without its
          // terminating chunk, so the client sees a truncated transfer.
          controller.error(new Error(`tar exited ${exitCode}`))
          return
        }
        controller.close()
      } catch (error) {
        stop()
        controller.error(error)
      }
    },
    async cancel(reason) {
      stop()
      await reader.cancel(reason).catch(() => {})
    },
  })
  const headers: Record<string, string> = { 'Content-Type': 'application/gzip' }
  if (exclude.length) headers[ARCHIVE_EXCLUDED_HEADER] = exclude.join(',')
  return new Response(body, { status: 200, headers })
}

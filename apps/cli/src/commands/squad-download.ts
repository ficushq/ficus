/**
 * `ficus squad download <squadId> <path>` — stream a squad workspace file (or
 * a directory as tar.gz) to disk.
 *
 * The body is written chunk by chunk as it arrives; nothing is buffered, so
 * multi-GiB files download with flat memory. `--resume` continues a partial
 * file with `Range: bytes=<existing size>-`. A transfer whose byte count does
 * not match the announced length fails (non-zero exit) and, unless resuming,
 * deletes the partial file.
 */
import { createWriteStream, existsSync, statSync, unlinkSync, type WriteStream } from 'fs'
import { basename, join, posix, resolve } from 'path'
import { apiFetch } from '../client'
import { ApiRequestError, formatApiErrorPayload } from '../client-errors'

/** Length header Core sets because Bun re-frames streamed bodies as chunked. */
const LENGTH_HEADER = 'x-ficus-content-length'
/** Present (tar.gz | zip) when Core answered with a directory archive. */
const ARCHIVE_HEADER = 'x-ficus-archive'

export interface SquadDownloadOptions {
  output?: string
  archive?: boolean
  resume?: boolean
}

export interface SquadDownloadResult {
  /** Absolute local path written. */
  path: string
  /** Size of the local file after the download. */
  bytes: number
  /** HTTP status of the transfer (200, 206, or 416 when a resume found nothing left). */
  status: number
}

export interface SquadDownloadDeps {
  request?: (path: string, init: RequestInit) => Promise<Response>
  cwd?: string
  /** Progress sink; progress is drawn only when it is a TTY. */
  progress?: { isTTY?: boolean; write(text: string): unknown }
  now?: () => number
}

function remoteBasename(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '')
  const name = posix.basename(trimmed)
  return name && name !== '.' && name !== '..' ? name : 'workspace'
}

/** `-o` may name a file or an existing directory; default is the remote basename in cwd. */
export function resolveDownloadTarget(
  remotePath: string,
  options: Pick<SquadDownloadOptions, 'output' | 'archive'>,
  cwd: string
): string {
  const name = remoteBasename(remotePath) + (options.archive ? '.tar.gz' : '')
  if (!options.output) return resolve(cwd, name)
  const output = resolve(cwd, options.output)
  if (options.output.endsWith('/') || (existsSync(output) && statSync(output).isDirectory())) return join(output, name)
  return output
}

function parseLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`
}

async function apiError(response: Response): Promise<ApiRequestError> {
  const payload = await response.json().catch(() => undefined)
  const code =
    payload && typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : undefined
  return new ApiRequestError(
    formatApiErrorPayload(payload, `Request failed: ${response.status}`),
    response.status,
    code
  )
}

function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()))
  })
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    stream.end((error?: Error | null) => (error ? rejectClose(error) : resolveClose()))
  })
}

export async function downloadSquadFile(
  squadId: string,
  remotePath: string,
  options: SquadDownloadOptions = {},
  deps: SquadDownloadDeps = {}
): Promise<SquadDownloadResult> {
  if (options.resume && options.archive) {
    throw new Error('--resume cannot be combined with --archive: archives are generated on the fly')
  }
  const request = deps.request ?? apiFetch
  const progress = deps.progress ?? process.stderr
  const now = deps.now ?? Date.now
  const target = resolveDownloadTarget(remotePath, options, deps.cwd ?? process.cwd())
  const existing = options.resume && existsSync(target) ? statSync(target).size : 0

  const query = new URLSearchParams({ path: remotePath })
  if (options.archive) query.set('archive', 'tar.gz')
  // Identity encoding: byte counts and ranges are over the file's own bytes,
  // never a proxy's compressed representation.
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  if (existing > 0) headers.range = `bytes=${existing}-`
  const response = await request(`/api/squads/${encodeURIComponent(squadId)}/workspace/download?${query}`, {
    headers,
  })

  if (response.status === 416 && existing > 0) {
    // Nothing left to fetch when the remote size equals what we already have.
    const total = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
    await response.body?.cancel().catch(() => {})
    if (total !== undefined && Number(total) === existing) return { path: target, bytes: existing, status: 416 }
    throw new Error(
      `Cannot resume: local file is ${existing} bytes but the remote file is ${total ?? 'unknown'} bytes. ` +
        'Delete the local file or download without --resume.'
    )
  }
  if (!response.ok) throw await apiError(response)

  const archiveFormat = response.headers.get(ARCHIVE_HEADER)
  if (archiveFormat && !options.archive) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${remotePath} is a directory; re-run with --archive to download it as a tar.gz`)
  }
  if (options.archive && archiveFormat !== 'tar.gz') {
    await response.body?.cancel().catch(() => {})
    throw new Error(
      archiveFormat
        ? `Expected a tar.gz archive but the server sent ${archiveFormat}`
        : `${remotePath} is not a directory; download it without --archive`
    )
  }

  let append = false
  if (response.status === 206) {
    const start = /^bytes (\d+)-\d+\/\d+$/.exec(response.headers.get('content-range') ?? '')?.[1]
    if (start === undefined || Number(start) !== existing) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Server resumed at an unexpected offset (${response.headers.get('content-range')})`)
    }
    append = true
  }
  // A 200 to a resume request means the server sent the whole file: restart.

  // Core's length header is the identity length; Content-Length is only
  // trusted when no content-coding was applied in between.
  const expected =
    parseLength(response.headers.get(LENGTH_HEADER)) ??
    (response.headers.get('content-encoding') ? undefined : parseLength(response.headers.get('content-length')))
  const totalSize = expected === undefined ? undefined : (append ? existing : 0) + expected
  const keepPartial = Boolean(options.resume)
  const out = createWriteStream(target, { flags: append ? 'a' : 'w' })
  const showProgress = Boolean(progress.isTTY)
  let received = 0
  let lastDraw = 0
  const draw = (final = false) => {
    if (!showProgress) return
    const at = now()
    if (!final && at - lastDraw < 200) return
    lastDraw = at
    const done = (append ? existing : 0) + received
    const pct = totalSize ? ` (${Math.floor((done / totalSize) * 100)}%)` : ''
    progress.write(
      `\r${basename(target)}: ${formatBytes(done)}${totalSize ? ` / ${formatBytes(totalSize)}` : ''}${pct}`
    )
    if (final) progress.write('\n')
  }

  const fail = async (error: Error): Promise<never> => {
    await closeStream(out).catch(() => {})
    if (!keepPartial && existsSync(target)) unlinkSync(target)
    if (showProgress) progress.write('\n')
    throw error
  }

  try {
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await writeChunk(out, chunk)
        received += chunk.byteLength
        draw()
      }
    }
  } catch (error) {
    return fail(
      new Error(
        `Download interrupted after ${received} bytes: ${error instanceof Error ? error.message : String(error)}` +
          (keepPartial ? ' (partial file kept; re-run with --resume)' : '')
      )
    )
  }
  if (expected !== undefined && received !== expected) {
    return fail(
      new Error(
        `Size mismatch: received ${received} of ${expected} bytes` +
          (keepPartial ? ' (partial file kept; re-run with --resume)' : '; partial file deleted')
      )
    )
  }
  await closeStream(out)
  draw(true)
  return { path: target, bytes: statSync(target).size, status: response.status }
}

export function describeDownload(result: SquadDownloadResult): string {
  if (result.status === 416) return `${result.path} is already complete (${formatBytes(result.bytes)})`
  return `Downloaded ${result.path} (${formatBytes(result.bytes)})`
}

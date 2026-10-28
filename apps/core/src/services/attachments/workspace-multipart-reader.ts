import { MIMEType } from 'node:util'

// Workspace envelope resource budgets. File-content bytes are deliberately excluded.
export const WORKSPACE_MULTIPART_METADATA_BYTES = 4 * 1024 ** 2
export const WORKSPACE_MULTIPART_FILES = 1000
export const WORKSPACE_MULTIPART_PATH_FIELDS = 1000
export const WORKSPACE_MULTIPART_OTHER_FIELDS = 256
const HEADER_LINES = 4096

export class InvalidWorkspaceMultipartError extends Error {
  constructor(
    message = 'Invalid or interrupted multipart upload',
    readonly status: 400 | 413 = 400
  ) {
    super(message)
  }
}
export function collectionOverflow(): never {
  throw new InvalidWorkspaceMultipartError('Multipart collection limit exceeded')
}

/** Amortized-linear, bounded collection even for a source delivering one byte per chunk. */
export class MultipartBytes {
  private buffer = Buffer.alloc(0)
  private size = 0
  append(bytes: Uint8Array) {
    const size = this.size + bytes.byteLength
    if (size > WORKSPACE_MULTIPART_METADATA_BYTES)
      throw new InvalidWorkspaceMultipartError('Workspace multipart metadata too large', 413)
    if (size > this.buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(WORKSPACE_MULTIPART_METADATA_BYTES, Math.max(size, this.buffer.length * 2, 4096))
      )
      this.buffer.copy(next, 0, 0, this.size)
      this.buffer = next
    }
    this.buffer.set(bytes, this.size)
    this.size = size
  }
  bytes(): Buffer {
    return this.buffer.subarray(0, this.size)
  }
}

/** A bounded lookbehind, not a whole-body buffer. Only valid delimiter suffixes end a part. */
class MultipartInput {
  // A virtual leading CRLF makes initial and subsequent line-anchored delimiters identical.
  private pending: Buffer = Buffer.from('\r\n')
  private ended = false
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private abort = () => {
    void this.reader.cancel().catch(() => {})
  }
  constructor(private request: Request) {
    if (!request.body) throw new InvalidWorkspaceMultipartError()
    this.reader = request.body.getReader()
    request.signal.addEventListener('abort', this.abort, { once: true })
  }
  private async fill() {
    this.request.signal.throwIfAborted()
    const { done, value } = await this.reader.read()
    this.request.signal.throwIfAborted()
    this.ended = Boolean(done)
    if (value?.byteLength) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes
    }
  }
  async take(size: number): Promise<Buffer> {
    while (this.pending.length < size && !this.ended) await this.fill()
    if (this.pending.length < size) throw new InvalidWorkspaceMultipartError()
    return this.consume(size)
  }
  private consume(size: number): Buffer {
    const value = this.pending.subarray(0, size)
    this.pending = this.pending.subarray(size)
    return value
  }
  /** A close is -- followed by EOF or CRLF, not just a -- prefix inside file bytes. */
  private delimiterState(offset: number): 'more' | 'valid' | 'invalid' {
    const remaining = this.pending.length - offset
    if (remaining < 2) return this.ended ? 'invalid' : 'more'
    if (this.pending[offset] === 13 && this.pending[offset + 1] === 10) return 'valid'
    if (this.pending[offset] !== 45 || this.pending[offset + 1] !== 45) return 'invalid'
    if (remaining === 2 && this.ended) return 'valid'
    if (remaining < 4) return this.ended ? 'invalid' : 'more'
    return this.pending[offset + 2] === 13 && this.pending[offset + 3] === 10 ? 'valid' : 'invalid'
  }
  async until(marker: Buffer, emit: (bytes: Buffer) => void | Promise<void>, boundary = false): Promise<void> {
    for (;;) {
      const index = this.pending.indexOf(marker)
      if (index >= 0) {
        const state = boundary ? this.delimiterState(index + marker.length) : 'valid'
        if (state === 'more') {
          if (index) await emit(this.consume(index))
          await this.fill()
          continue
        }
        if (state === 'invalid') {
          // Preserve the candidate verbatim while continuing to seek a genuine delimiter.
          await emit(this.consume(index + marker.length))
          continue
        }
        if (index) await emit(this.consume(index))
        this.consume(marker.length)
        return
      }
      if (this.ended) throw new InvalidWorkspaceMultipartError()
      const safe = this.pending.length - marker.length - 1
      if (safe > 0) await emit(this.consume(safe))
      await this.fill()
    }
  }
  async rest(emit: (bytes: Buffer) => void) {
    for (;;) {
      if (this.pending.length) emit(this.consume(this.pending.length))
      if (this.ended) return
      await this.fill()
    }
  }
  async close(complete: boolean) {
    this.request.signal.removeEventListener('abort', this.abort)
    try {
      if (!complete) await this.reader.cancel().catch(() => {})
    } finally {
      this.reader.releaseLock()
    }
  }
}

export interface WorkspacePart {
  fieldName: string
  filename?: string
  contentType: string
  readBody(emit: (bytes: Buffer) => void | Promise<void>): Promise<void>
  fieldValue(bytes: Buffer): Promise<string>
}

/**
 * Frame parts incrementally; use Bun's former reader ONLY for bounded headers/field data.
 * This preserves native filename/header semantics without hidden parser truncation limits.
 * Each callback must consume its part before the next starts (one active file descriptor).
 */
export async function readWorkspaceMultipart(request: Request, consume: (part: WorkspacePart) => Promise<void>) {
  let metadata = -2 // Exclude the virtual leading CRLF from the envelope budget.
  const account = (bytes: number | Uint8Array) => {
    metadata += typeof bytes === 'number' ? bytes : bytes.byteLength
    if (metadata > WORKSPACE_MULTIPART_METADATA_BYTES)
      throw new InvalidWorkspaceMultipartError('Workspace multipart metadata too large', 413)
  }
  const mime = new MIMEType(request.headers.get('content-type') ?? '')
  const boundary = mime.params.get('boundary')
  if (mime.essence !== 'multipart/form-data' || !boundary || /[\r\n]/.test(boundary))
    throw new InvalidWorkspaceMultipartError()
  account(Buffer.byteLength(boundary))
  const initial = Buffer.from('--' + boundary)
  const delimiter = Buffer.from('\r\n--' + boundary)
  const endHeaders = Buffer.from('\r\n\r\n')
  const input = new MultipartInput(request)
  let complete = false
  try {
    await input.until(delimiter, account, true)
    account(delimiter)
    for (;;) {
      const suffix = await input.take(2)
      account(suffix)
      if (suffix.equals(Buffer.from('--'))) {
        await input.rest(account)
        complete = true
        return
      }
      if (!suffix.equals(Buffer.from('\r\n'))) throw new InvalidWorkspaceMultipartError()
      const header = new MultipartBytes()
      await input.until(endHeaders, (bytes) => {
        account(bytes)
        header.append(bytes)
      })
      account(endHeaders)
      const headers = header.bytes()
      let lineCount = 0
      for (let start = 0; start < headers.length; ) {
        if (++lineCount > HEADER_LINES) collectionOverflow()
        const crlf = headers.indexOf('\r\n', start)
        const end = crlf < 0 ? headers.length : crlf
        const line = headers.toString('latin1', start, end)
        if (
          /[\r\n]/.test(line) ||
          (!/^[\t ]/.test(line) && !/^[!#$%&'*+.^_`|~\w-]+:/.test(line)) ||
          (lineCount === 1 && /^[\t ]/.test(line))
        )
          throw new InvalidWorkspaceMultipartError()
        start = end + 2
      }
      const parse = async (bytes: Buffer) => {
        const form = await new Response(
          Buffer.concat([initial, Buffer.from('\r\n'), headers, endHeaders, bytes, delimiter, Buffer.from('--\r\n')]),
          { headers: { 'content-type': mime.toString() } }
        ).formData()
        const entries = [...form.entries()]
        if (entries.length !== 1) throw new InvalidWorkspaceMultipartError()
        // Bun returns File entries too; its FormData declaration narrows these to string.
        return entries[0]! as [string, string | File]
      }
      const [fieldName, value] = await parse(Buffer.alloc(0))
      const filename = typeof value === 'string' ? undefined : value.name
      account(Buffer.byteLength(fieldName) + Buffer.byteLength(filename ?? ''))
      let consumed = false
      let fieldBytes = 0
      await consume({
        fieldName,
        filename,
        contentType: typeof value === 'string' ? 'text/plain' : value.type,
        async readBody(emit) {
          if (consumed) throw new InvalidWorkspaceMultipartError()
          consumed = true
          // Count decoded UTF-8 incrementally, including split characters and BOM handling.
          // File bytes never enter either this decoder or the metadata budget.
          const decoder = filename === undefined ? new TextDecoder() : undefined
          const decoded = (text: string) => {
            const bytes = Buffer.byteLength(text)
            account(bytes)
            fieldBytes += bytes
          }
          await input.until(
            delimiter,
            async (bytes) => {
              if (decoder) decoded(decoder.decode(bytes, { stream: true }))
              await emit(bytes)
            },
            true
          )
          if (decoder) decoded(decoder.decode())
          account(delimiter)
        },
        async fieldValue(bytes) {
          const [name, field] = await parse(bytes)
          if (name !== fieldName || typeof field !== 'string') throw new InvalidWorkspaceMultipartError()
          account(Buffer.byteLength(field) - fieldBytes)
          return field
        },
      })
      if (!consumed) throw new InvalidWorkspaceMultipartError()
    }
  } finally {
    await input.close(complete)
  }
}

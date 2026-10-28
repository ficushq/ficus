import Busboy from '@fastify/busboy'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface StagedWorkspaceFile {
  fieldName: string
  filename: string
  contentType: string
  tempPath: string
  bytes: number
  sha256: string
}
export interface StagedWorkspaceUpload {
  files: StagedWorkspaceFile[]
  fields: Map<string, string>
  cleanup(): Promise<void>
}
export class InvalidWorkspaceMultipartError extends Error {
  constructor() {
    super('Invalid or interrupted multipart upload')
  }
}

/** Disk-backed multipart, including late path fields. No file byte cap or whole-body reads. */
export async function stageWorkspaceMultipart(request: Request): Promise<StagedWorkspaceUpload> {
  const directory = await mkdtemp(join(tmpdir(), 'ficus-workspace-upload-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  const files: StagedWorkspaceFile[] = []
  const fields = new Map<string, string>()
  const writes: Promise<void>[] = []
  const failure = new AbortController()
  const signal = AbortSignal.any([failure.signal, request.signal])
  try {
    if (!request.body) throw new InvalidWorkspaceMultipartError()
    const parser = new Busboy({ headers: Object.fromEntries(request.headers), preservePath: true })
    parser.on('field', (name, value, nameTruncated, valueTruncated) => {
      if (nameTruncated || valueTruncated) {
        failure.abort()
        return
      }
      if (!fields.has(name)) fields.set(name, value)
    })
    parser.on('file', (fieldName, source, filename, _encoding, contentType) => {
      const file: StagedWorkspaceFile = {
        fieldName,
        filename,
        contentType,
        tempPath: join(directory, randomUUID()),
        bytes: 0,
        sha256: '',
      }
      files.push(file)
      const hash = createHash('sha256')
      const count = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          file.bytes += chunk.byteLength
          if (!Number.isSafeInteger(file.bytes)) return done(new InvalidWorkspaceMultipartError())
          hash.update(chunk)
          done(null, chunk)
        },
      })
      const writing = pipeline(source, count, createWriteStream(file.tempPath, { flags: 'wx', mode: 0o600 }), {
        signal,
      }).then(() => {
        if (source.truncated) throw new InvalidWorkspaceMultipartError()
        file.sha256 = hash.digest('hex')
      })
      // Register rejection immediately: a disk failure must also stop the parser/source.
      writes.push(
        writing.catch((error) => {
          failure.abort()
          throw error
        })
      )
      void writes.at(-1)!.catch(() => {})
    })
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), parser, { signal })
    await Promise.all(writes)
    signal.throwIfAborted()
    return { files, fields, cleanup }
  } catch {
    failure.abort()
    await Promise.allSettled(writes)
    await cleanup()
    throw new InvalidWorkspaceMultipartError()
  }
}

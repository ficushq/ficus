import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  readWorkspaceMultipart,
  MultipartBytes,
  InvalidWorkspaceMultipartError,
  collectionOverflow,
  WORKSPACE_MULTIPART_FILES,
  WORKSPACE_MULTIPART_PATH_FIELDS,
  WORKSPACE_MULTIPART_OTHER_FIELDS,
} from './workspace-multipart-reader'
export { InvalidWorkspaceMultipartError } from './workspace-multipart-reader'

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

/** Stage every part before publishing anything. File contents have no byte limit. */
export async function stageWorkspaceMultipart(request: Request): Promise<StagedWorkspaceUpload> {
  const directory = await mkdtemp(join(tmpdir(), 'ficus-workspace-upload-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  const files: StagedWorkspaceFile[] = []
  const fields = new Map<string, string>()
  const pathFields = new Map<string, number>()
  let pathEntries = 0
  let otherEntries = 0
  try {
    await readWorkspaceMultipart(request, async (part) => {
      if (part.filename !== undefined) {
        if (files.length === WORKSPACE_MULTIPART_FILES) collectionOverflow()
        const file: StagedWorkspaceFile = {
          fieldName: part.fieldName,
          filename: part.filename,
          contentType: part.contentType,
          tempPath: join(directory, randomUUID()),
          bytes: 0,
          sha256: '',
        }
        files.push(file)
        const hash = createHash('sha256')
        const handle = await open(file.tempPath, 'wx', 0o600)
        try {
          await part.readBody(async (chunk) => {
            request.signal.throwIfAborted()
            file.bytes += chunk.byteLength
            if (!Number.isSafeInteger(file.bytes)) throw new InvalidWorkspaceMultipartError()
            hash.update(chunk)
            await handle.writeFile(chunk)
          })
          file.sha256 = hash.digest('hex')
        } finally {
          await handle.close()
        }
      } else {
        if (part.fieldName.startsWith('path_')) {
          if (++pathEntries > WORKSPACE_MULTIPART_PATH_FIELDS) collectionOverflow()
          pathFields.set(part.fieldName, (pathFields.get(part.fieldName) ?? 0) + 1)
        } else if (++otherEntries > WORKSPACE_MULTIPART_OTHER_FIELDS) collectionOverflow()
        const value = new MultipartBytes()
        await part.readBody((bytes) => value.append(bytes))
        const field = await part.fieldValue(value.bytes())
        if (!fields.has(part.fieldName)) fields.set(part.fieldName, field)
      }
    })
    // Late path fields are manifest rows only when they correspond to a real file.
    // Unmatched path-looking fields cannot bypass the ordinary metadata-map budget.
    const fileFields = new Set(files.map((file) => `path_${file.fieldName}`))
    for (const [name, count] of pathFields) if (!fileFields.has(name)) otherEntries += count
    if (otherEntries > WORKSPACE_MULTIPART_OTHER_FIELDS) collectionOverflow()
    request.signal.throwIfAborted()
    return { files, fields, cleanup }
  } catch (error) {
    await cleanup()
    if (error instanceof InvalidWorkspaceMultipartError) throw error
    throw new InvalidWorkspaceMultipartError()
  }
}

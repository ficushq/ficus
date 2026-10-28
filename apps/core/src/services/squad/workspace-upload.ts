import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicVerifiedWrite } from '@ficus/sandbox-server/atomic-write'
import type { StagedWorkspaceUpload } from '../attachments/workspace-multipart'
import { isInsideWorkspaceRoot, resolveSandboxWorkspacePath } from './workspace'
import { SandboxHttpError } from '../sandbox/client/http-client'
import { publicErrorMessage } from '../../db/errors'

type UploadIdentity = { bytesWritten: number; sha256?: string }
interface UploadClient {
  stat(request: { path: string }): Promise<{ exists: boolean }>
  upload(request: {
    path: string
    content: ReadableStream<Uint8Array>
    createDirs: boolean
    signal?: AbortSignal
  }): Promise<UploadIdentity>
  write(request: { path: string; content: string; createDirs: boolean }): Promise<UploadIdentity>
}
export type WorkspaceUploadResult = {
  path: string
  status: 'created' | 'overwritten' | 'skipped' | 'error'
  error?: string
}
const upgradeMessage = 'Sandbox upgrade required for large workspace uploads'

/** Exact legacy JSON envelope budget, checked before allocating base64. */
export function legacyUploadFits(path: string, bytes: number): boolean {
  return (
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    Buffer.byteLength(JSON.stringify({ path, content: '', createDirs: true })) + 4 * Math.ceil(bytes / 3) <=
      100 * 1024 ** 2
  )
}

/** Publish only complete staged files; stages remain owned by the caller until all transfers settle. */
export async function publishWorkspaceUpload(options: {
  staged: StagedWorkspaceUpload
  workspacePath: string
  targetDir: string
  overwrite: boolean
  client?: UploadClient | null
  signal?: AbortSignal
}): Promise<WorkspaceUploadResult[]> {
  const { staged, workspacePath, targetDir, overwrite, client, signal } = options
  const results: WorkspaceUploadResult[] = []
  for (const file of staged.files) {
    const relativePath = staged.fields.get(`path_${file.fieldName}`) || file.filename
    const fullRelativePath = targetDir ? `${targetDir}/${relativePath}` : relativePath
    const targetPath = client
      ? resolveSandboxWorkspacePath(workspacePath, fullRelativePath)
      : resolve(workspacePath, fullRelativePath)
    if (!targetPath || (!client && !isInsideWorkspaceRoot(workspacePath, targetPath))) {
      results.push({ path: fullRelativePath, status: 'error', error: 'Invalid path' })
      continue
    }
    try {
      signal?.throwIfAborted()
      let exists = false
      if (client) {
        // Keep the legacy stat failure behavior; the upload still enforces path policy.
        try {
          exists = (await client.stat({ path: targetPath })).exists
        } catch {
          /* upload reports definitive failure */
        }
      } else {
        try {
          await stat(targetPath)
          exists = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (exists && !overwrite) {
        results.push({ path: fullRelativePath, status: 'skipped' })
        continue
      }
      const identity = { bytes: file.bytes, sha256: file.sha256 }
      if (client) {
        let response: UploadIdentity
        try {
          response = await client.upload({
            path: targetPath,
            content: Bun.file(file.tempPath).stream(),
            createDirs: true,
            signal,
          })
        } catch (error) {
          if (error instanceof SandboxHttpError && error.status === 413) throw new Error(upgradeMessage)
          if (!(error instanceof SandboxHttpError && error.status === 404)) throw error
          if (!legacyUploadFits(targetPath, file.bytes)) throw new Error(upgradeMessage)
          signal?.throwIfAborted()
          const bytes = await Bun.file(file.tempPath).arrayBuffer()
          response = await client.write({
            path: targetPath,
            content: Buffer.from(bytes).toString('base64'),
            createDirs: true,
          })
        }
        if (response.bytesWritten !== file.bytes || (response.sha256 !== undefined && response.sha256 !== file.sha256))
          throw new Error('Upload identity verification failed; success was not reported')
      } else {
        await mkdir(dirname(targetPath), { recursive: true })
        await atomicVerifiedWrite({
          path: targetPath,
          allowedRoots: [workspacePath],
          content: Bun.file(file.tempPath).stream(),
          expectedResult: identity,
          signal,
        })
      }
      results.push({ path: fullRelativePath, status: client ? 'created' : exists ? 'overwritten' : 'created' })
    } catch (error) {
      results.push({ path: fullRelativePath, status: 'error', error: publicErrorMessage(error) })
    }
  }
  return results
}

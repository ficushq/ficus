import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicVerifiedWrite } from '@ficus/sandbox-server/atomic-write'
import type { StagedWorkspaceUpload } from '../attachments/workspace-multipart'
import {
  resolveLocalWorkspaceWriteTarget,
  resolveSandboxWorkspaceTargets,
  type SandboxPathClient,
  type WorkspaceTargetResolution,
} from './workspace-settings'
import { SandboxHttpError } from '../sandbox/client/http-client'
import { publicErrorMessage } from '../../db/errors'

type UploadIdentity = { bytesWritten: number; sha256?: string }
interface UploadClient extends SandboxPathClient {
  stat(request: { path: string }): Promise<{ exists: boolean }>
  upload(request: {
    path: string
    content: ReadableStream<Uint8Array>
    createDirs: boolean
    signal?: AbortSignal
  }): Promise<UploadIdentity>
  write(request: { path: string; content: string; createDirs: boolean }, signal?: AbortSignal): Promise<UploadIdentity>
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
  const relativePaths = staged.files.map((file) => {
    const relativePath = staged.fields.get(`path_${file.fieldName}`) || file.filename
    return targetDir ? `${targetDir}/${relativePath}` : relativePath
  })
  // Sandbox targets are all resolved in the box before anything is written,
  // in as few round trips as the batch bounds allow.
  const sandboxChecks = client ? await resolveSandboxWorkspaceTargets(client, workspacePath, relativePaths, signal) : []
  for (const [index, file] of staged.files.entries()) {
    const fullRelativePath = relativePaths[index]!
    try {
      signal?.throwIfAborted()
      // The target must stay inside the workspace and outside its settings
      // directory, both as written and after symlinks resolve (in the box for
      // sandbox runtimes); either refusal answers the same 'Invalid path'.
      let target: WorkspaceTargetResolution
      if (client) {
        const check = sandboxChecks[index]!
        if ('error' in check) throw check.error
        target = check.resolution
      } else {
        target = resolveLocalWorkspaceWriteTarget(workspacePath, fullRelativePath)
      }
      if (!target.ok) {
        results.push({ path: fullRelativePath, status: 'error', error: 'Invalid path' })
        continue
      }
      const targetPath = target.path
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
          if (error instanceof SandboxHttpError && error.status === 413)
            throw new Error(upgradeMessage, { cause: error })
          if (!(error instanceof SandboxHttpError && error.status === 404)) throw error
          if (!legacyUploadFits(targetPath, file.bytes)) throw new Error(upgradeMessage, { cause: error })
          signal?.throwIfAborted()
          const bytes = await Bun.file(file.tempPath).arrayBuffer()
          response = await client.write(
            {
              path: targetPath,
              content: Buffer.from(bytes).toString('base64'),
              createDirs: true,
            },
            signal
          )
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

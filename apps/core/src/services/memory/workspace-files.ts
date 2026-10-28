/**
 * Workspace-file memory ingest.
 *
 * Single shared ingest path for workspace-watch events, used by both the
 * sandbox-callback HTTP route (container/VM watcher posting over its
 * authenticated callback) and the host runtime's in-process watcher sink —
 * both must produce identical ingest results.
 */

import { Squad } from '../../entities/Squad'
import { WorkspaceFileSource } from './sources/WorkspaceFileSource'
import { ReindexScheduler } from './indexer/ReindexScheduler'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'

export interface WorkspaceFilesIngestInput {
  files: Array<{ path: string; content?: string | null; event: 'change' | 'delete' }>
  reconcile?: boolean
  skipped?: Array<{ path: string; reason: string; detail?: string; count?: number }>
}

export interface WorkspaceFilesIngestResult {
  squadFound: boolean
  indexed: number
  deleted: number
  skipped: number
  errors: number
  removed: number
}

/**
 * Ingest workspace-file changes into squad memory.
 *
 * `path` values are workspace-relative (`docs/a.md`); they are prefixed with
 * the runtime-correct workspace mount (`resolveWorkspaceLayout` — container
 * `/workspace/<squadId>/…`, host the absolute host workspace) before indexing,
 * so document `sourceId`s are stable per runtime exactly as the watcher
 * reported them.
 */
export async function ingestWorkspaceFiles(
  squadId: string,
  input: WorkspaceFilesIngestInput
): Promise<WorkspaceFilesIngestResult> {
  const { files, reconcile, skipped: skippedFiles } = input

  const squad = await Squad.find(squadId)
  if (!squad) return { squadFound: false, indexed: 0, deleted: 0, skipped: 0, errors: 0, removed: 0 }

  const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
  const source = WorkspaceFileSource.instance()
  const results = { indexed: 0, deleted: 0, skipped: 0, errors: 0, removed: 0 }

  for (const file of files) {
    if (file.event === 'delete') {
      await source.remove(squad.id, `${workspaceMount}/${file.path}`)
      results.deleted++
    } else if (file.content) {
      const result = await source.indexContent({
        squadId: squad.id,
        path: `${workspaceMount}/${file.path}`,
        content: file.content,
      })
      if (result.skipped) results.skipped++
      else if (result.success) results.indexed++
      else results.errors++
    }
  }

  if (reconcile) {
    const currentPaths = files.filter((f) => f.event === 'change').map((f) => `${workspaceMount}/${f.path}`)
    const { removed } = await source.reconcile(squad.id, { currentSourceIds: currentPaths })
    results.removed = removed
  }

  // Store scan status (file count + skipped) on squad metadata for UI
  if (reconcile) {
    const scanStatus = {
      lastScan: new Date().toISOString(),
      filesIndexed: files.filter((f) => f.event === 'change').length,
      skipped: skippedFiles ?? [],
    }
    await squad.update({
      metadata: { memory: { workspaceScanStatus: scanStatus } },
    })
  }

  ReindexScheduler.instance().schedule(squad.id)

  return { squadFound: true, ...results }
}

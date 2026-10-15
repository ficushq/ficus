/**
 * Where the Workspace tab's file browser reads and writes: the squad's shared
 * workspace (the default), or one agent's private area. FileTree, FileViewer
 * and FileUpload take a source instead of a squad id, so both targets share
 * one UI and one set of behaviors.
 */

import { useMemo } from 'react'
import type { QueryKey } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import {
  getSquadWorkspaceDownloadUrl,
  getSquadWorkspaceFile,
  getSquadWorkspaceTree,
  uploadToSquadWorkspace,
  type FileContent,
  type TreeNode,
  type UploadOptions,
  type UploadResponse,
} from '../../api/workspace'
import {
  getAgentPrivateDownloadUrl,
  getAgentPrivateFile,
  getAgentPrivateTree,
  uploadToAgentPrivate,
} from '../../api/agentPrivate'
import { usePermissions } from '../../hooks/usePermissions'

type UploadFiles = { file: File; relativePath: string }[]

export interface WorkspaceSource {
  /** Cache identity: `squad:<id>` or `agent:<id>`. */
  id: string
  /** Children of one directory (`''` = the root). */
  treeQuery: (path: string) => { queryKey: QueryKey; queryFn: () => Promise<TreeNode> }
  /** Prefix covering every tree query of this source (refresh, uploads). */
  treeQueryPrefix: QueryKey
  fileQuery: (path: string) => { queryKey: QueryKey; queryFn: () => Promise<FileContent> }
  downloadUrl: (path: string) => string
  upload: (files: UploadFiles, options: UploadOptions) => Promise<UploadResponse>
  canWrite: boolean
  /** Directories download as ZIP archives (squad workspace only). */
  directoryDownload: boolean
  /** Shown in the empty tree and the viewer placeholder. */
  emptyTitle: string
  description: string
  loadingLabel: string
  /** Absolute path as the agent sees it, for "Copy path" (agent private area only). */
  agentPath?: (path: string) => string
}

export function useSquadWorkspaceSource(squadId: string): WorkspaceSource {
  const { can, isLoading } = usePermissions(squadId)
  const canWrite = !isLoading && can('workspace:write')
  return useMemo(
    () => ({
      id: `squad:${squadId}`,
      // Same keys as before this abstraction: the root at depth 1, children without a depth.
      treeQuery: (path: string) => {
        const depth = path ? undefined : 1
        return {
          queryKey: queryKeys.squads.workspaceTree(squadId, path, depth),
          queryFn: () => getSquadWorkspaceTree(squadId, path, depth ?? 1),
        }
      },
      treeQueryPrefix: queryKeys.squads.workspaceTree(squadId),
      fileQuery: (path: string) => ({
        queryKey: queryKeys.squads.workspaceFile(squadId, path),
        queryFn: () => getSquadWorkspaceFile(squadId, path),
      }),
      downloadUrl: (path: string) => getSquadWorkspaceDownloadUrl(squadId, path),
      upload: (files: UploadFiles, options: UploadOptions) => uploadToSquadWorkspace(squadId, files, options),
      canWrite,
      directoryDownload: true,
      emptyTitle: 'Workspace is empty',
      description: 'Browse your squad’s shared workspace.',
      loadingLabel: 'Loading workspace files',
    }),
    [squadId, canWrite]
  )
}

/** Join a private-area relative path onto the agent-visible private root. */
export function agentVisiblePath(privateRoot: string, path: string): string {
  const relative = path.replace(/^\/+/, '')
  return relative ? `${privateRoot.replace(/\/+$/, '')}/${relative}` : privateRoot
}

export function useAgentPrivateSource(agentId: string, privateRoot: string): WorkspaceSource {
  return useMemo(
    () => ({
      id: `agent:${agentId}`,
      treeQuery: (path: string) => ({
        queryKey: queryKeys.agentPrivate.tree(agentId, path),
        queryFn: () => getAgentPrivateTree(agentId, path),
      }),
      treeQueryPrefix: queryKeys.agentPrivate.tree(agentId),
      fileQuery: (path: string) => ({
        queryKey: queryKeys.agentPrivate.file(agentId, path),
        queryFn: () => getAgentPrivateFile(agentId, path),
      }),
      downloadUrl: (path: string) => getAgentPrivateDownloadUrl(agentId, path),
      upload: (files: UploadFiles, options: UploadOptions) => uploadToAgentPrivate(agentId, files, options),
      // Reaching this source at all requires agents:private-access, which includes uploads.
      canWrite: true,
      directoryDownload: false,
      emptyTitle: 'Private folder is empty',
      description: 'Only this agent can read files here. Platform files such as its identity key are hidden.',
      loadingLabel: 'Loading private files',
      agentPath: (path: string) => agentVisiblePath(privateRoot, path),
    }),
    [agentId, privateRoot]
  )
}

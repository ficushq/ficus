/**
 * FileTree Component
 *
 * Lazy-loaded directory tree for the workspace file browser.
 * Expands directories on click, fetching subtrees on demand.
 * Supports file and folder upload via drag-and-drop.
 */

import { useState, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import type { TreeNode } from '../../api/workspace'
import { getSquadWorkspaceDownloadUrl } from '../../api/workspace'
import { FolderIcon } from '../icons/FolderIcon'
import { DownloadIcon, SpinnerIcon, FileIcon, ChevronDownIcon, ChevronRightIcon, RefreshIcon } from '../icons'
import { authFetch } from '../../api/client'
import { FileUpload } from './FileUpload'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { LoadingContent, LoadingSurface, SkeletonBlock, SkeletonRows } from '../loading/Skeleton'

export interface FileTreeProps {
  squadId: string
  onSelectFile: (path: string) => void
  selectedPath?: string
}

interface TreeItemProps {
  node: TreeNode
  path: string
  depth: number
  squadId: string
  selectedPath?: string
  onSelectFile: (path: string) => void
  expandedPaths: Set<string>
  onToggleExpand: (path: string, expanded: boolean) => void
  loadedPaths: Set<string>
  onMarkLoaded: (path: string) => void
  pendingUploads: Set<string>
}

function TreeItem({
  node,
  path,
  depth,
  squadId,
  selectedPath,
  onSelectFile,
  expandedPaths,
  onToggleExpand,
  loadedPaths,
  onMarkLoaded,
  pendingUploads,
}: TreeItemProps) {
  const [isDownloading, setIsDownloading] = useState(false)
  const isExpanded = expandedPaths.has(path)
  const isSelected = selectedPath === path
  const isDirectory = node.type === 'directory'
  const isPending = pendingUploads.has(path)
  const needsLoad = isDirectory && isExpanded && !loadedPaths.has(path) && !isPending

  // Fetch subtree when expanding an unloaded directory
  const { data: subtree, isLoading } = useQuery({
    ...queries.squadWorkspace.tree(squadId, path),
    enabled: needsLoad,
    staleTime: 30000, // Cache for 30 seconds
  })

  // Mark as loaded when subtree arrives
  if (subtree && needsLoad) {
    onMarkLoaded(path)
  }

  const handleClick = () => {
    if (isDirectory) {
      onToggleExpand(path, !isExpanded)
    } else {
      onSelectFile(path)
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDownloading) return

    setIsDownloading(true)
    const downloadUrl = getSquadWorkspaceDownloadUrl(squadId, path)

    try {
      // Create a temporary link with auth headers via fetch
      const response = await authFetch(downloadUrl)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // For directories, the server returns a zip file
      a.download = isDirectory ? `${node.name}.zip` : node.name
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setIsDownloading(false)
    }
  }

  // Use loaded subtree children, or initial children if already loaded
  const children = subtree?.children ?? node.children ?? []

  return (
    <div>
      <div
        className={clsx(
          'group w-full text-left px-2 py-1.5 flex min-h-9 items-center gap-2 hover:bg-surface-hover rounded-lg text-sm text-secondary cursor-pointer',
          isSelected && 'bg-selection text-accent-light'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        aria-expanded={isDirectory ? isExpanded : undefined}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            handleClick()
          }
        }}
      >
        {isDirectory && (
          <span className="w-4 text-muted">
            {isLoading ? (
              <span className="animate-pulse">...</span>
            ) : isExpanded ? (
              <ChevronDownIcon className="h-3.5 w-3.5" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5" />
            )}
          </span>
        )}
        {!isDirectory && <span className="w-4" />}
        {isPending ? (
          <SpinnerIcon className="w-4 h-4 animate-spin text-accent-light flex-shrink-0" />
        ) : (
          <span className="text-muted">
            {isDirectory ? <FolderIcon className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
          </span>
        )}
        <span className={clsx('truncate flex-1', isPending && 'text-muted italic')}>{node.name}</span>
        {!isDirectory && node.size !== undefined && !isPending && (
          <span className="text-xs text-muted">{formatSize(node.size)}</span>
        )}
        {!isPending && (
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className={clsx(
              'ficus-button',
              'p-1 rounded transition-opacity',
              isDownloading
                ? 'opacity-100 text-muted cursor-wait'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted hover:text-primary hover:bg-surface-secondary'
            )}
            title={isDirectory ? 'Download as ZIP' : 'Download'}
          >
            {isDownloading ? (
              <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      {isDirectory && isExpanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeItem
              key={child.name}
              node={child}
              path={path ? `${path}/${child.name}` : child.name}
              depth={depth + 1}
              squadId={squadId}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              loadedPaths={loadedPaths}
              onMarkLoaded={onMarkLoaded}
              pendingUploads={pendingUploads}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Merge pending upload paths into an existing tree structure.
 * Creates placeholder nodes for files/directories being uploaded.
 */
function mergePendingUploads(tree: TreeNode | undefined, pendingPaths: Set<string>): TreeNode | undefined {
  if (!tree || pendingPaths.size === 0) return tree

  // Build a map of pending items by parent path
  const pendingByParent = new Map<string, Set<string>>()
  for (const path of pendingPaths) {
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('/')
    if (!pendingByParent.has(parent)) {
      pendingByParent.set(parent, new Set())
    }
    pendingByParent.get(parent)!.add(name)
  }

  // Recursively merge pending items into the tree
  function mergeNode(node: TreeNode, currentPath: string): TreeNode {
    if (node.type !== 'directory') return node

    const existingChildren = node.children ?? []
    const pendingNames = pendingByParent.get(currentPath) ?? new Set()

    // Filter out pending items that already exist in the tree
    const existingNames = new Set(existingChildren.map((c) => c.name))
    const newPendingNames = [...pendingNames].filter((name) => !existingNames.has(name))

    // Create placeholder nodes for new pending items
    const pendingChildren: TreeNode[] = newPendingNames.map((name) => {
      const childPath = currentPath ? `${currentPath}/${name}` : name
      // Check if this is a directory (has children in pending paths)
      const isDir = [...pendingPaths].some((p) => p.startsWith(childPath + '/'))
      return {
        name,
        type: isDir ? 'directory' : 'file',
        children: isDir ? [] : undefined,
      }
    })

    // Recursively merge existing children
    const mergedExisting = existingChildren.map((child) => {
      const childPath = currentPath ? `${currentPath}/${child.name}` : child.name
      return mergeNode(child, childPath)
    })

    // Recursively merge pending children
    const mergedPending = pendingChildren.map((child) => {
      const childPath = currentPath ? `${currentPath}/${child.name}` : child.name
      return mergeNode(child, childPath)
    })

    // Sort all children alphabetically, directories first
    const allChildren = [...mergedExisting, ...mergedPending].sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    return { ...node, children: allChildren }
  }

  return mergeNode(tree, '')
}

/**
 * Get all directory paths that need to be expanded to show pending uploads.
 */
function getExpandPathsForPending(pendingPaths: Set<string>): string[] {
  const dirs = new Set<string>()
  for (const path of pendingPaths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  return [...dirs]
}

export function FileTree({ squadId, onSelectFile, selectedPath }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadedPaths, setLoadedPaths] = useState<Set<string>>(new Set())
  const [pendingUploads, setPendingUploads] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  // Expand all ancestor directories when selectedPath changes (e.g., from URL)
  useEffect(() => {
    if (!selectedPath) return

    // Get all ancestor paths: "a/b/c/file.ts" -> ["a", "a/b", "a/b/c"]
    const parts = selectedPath.split('/')
    const ancestors: string[] = []
    for (let i = 0; i < parts.length - 1; i++) {
      ancestors.push(parts.slice(0, i + 1).join('/'))
    }

    if (ancestors.length > 0) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        for (const ancestor of ancestors) {
          next.add(ancestor)
        }
        return next
      })
    }
  }, [selectedPath])

  // Fetch root tree
  const {
    data: rootTree,
    isLoading,
    isError,
    isSuccess,
    refetch,
  } = useQuery({
    ...queries.squadWorkspace.tree(squadId, '', 1),
    staleTime: 30000,
  })
  const rootSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:workspace-tree-root`,
    isSuccess ? (rootTree?.children?.length ?? 0) : undefined,
    { fallbackCount: 8, maxCount: 16 }
  )

  const handleToggleExpand = useCallback((path: string, expanded: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (expanded) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
  }, [])

  const handleMarkLoaded = useCallback((path: string) => {
    setLoadedPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }, [])

  const handleRefresh = useCallback(() => {
    // Invalidate all cached tree data (marks as stale)
    queryClient.invalidateQueries({
      queryKey: queryKeys.squads.workspaceTree(squadId),
    })
    // Clear loaded paths - this re-enables queries which will refetch since they're now stale
    setLoadedPaths(new Set())
    // Don't clear expandedPaths - keep folders open during refresh
    // Don't clear pendingUploads - they should persist until upload completes
  }, [queryClient, squadId])

  const handleUploadStart = useCallback((paths: string[]) => {
    setPendingUploads(new Set(paths))
    // Auto-expand directories containing pending uploads
    const dirsToExpand = getExpandPathsForPending(new Set(paths))
    if (dirsToExpand.length > 0) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        for (const dir of dirsToExpand) {
          next.add(dir)
        }
        return next
      })
    }
  }, [])

  const handleUploadComplete = useCallback(() => {
    setPendingUploads(new Set())
    setLoadedPaths(new Set())
    refetch()
  }, [refetch])

  const mergedTree = mergePendingUploads(rootTree, pendingUploads)
  const empty = !mergedTree?.children?.length && pendingUploads.size === 0

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-medium text-secondary">Files</span>
        <button
          onClick={handleRefresh}
          className="ficus-button rounded-lg p-1.5 text-muted hover:text-primary hover:bg-surface-hover"
          title="Refresh files"
          aria-label="Refresh files"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        <LoadingContent
          loading={isLoading && !rootTree}
          fallback={
            <LoadingSurface label="Loading workspace files">
              <SkeletonRows count={Math.max(1, rootSkeletonCount)}>
                {(index) => (
                  <div key={index} className="flex min-h-9 items-center gap-2 px-2 py-1.5">
                    <span className="w-4" />
                    <SkeletonBlock className="h-4 w-4" />
                    <SkeletonBlock className={index % 3 ? 'h-3 w-28' : 'h-3 w-36'} />
                  </div>
                )}
              </SkeletonRows>
            </LoadingSurface>
          }
        >
          {isError ? (
            <div className="p-3 text-sm text-muted">
              <p>Failed to load files</p>
              <button onClick={handleRefresh} className="ficus-button mt-2 text-accent-light">
                Retry
              </button>
            </div>
          ) : empty ? (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-secondary">Workspace is empty</p>
              <p className="mt-2 text-xs text-muted">Drop files here or use the upload buttons below.</p>
            </div>
          ) : null}
          {mergedTree?.children?.map((child) => (
            <TreeItem
              key={child.name}
              node={child}
              path={child.name}
              depth={0}
              squadId={squadId}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              onToggleExpand={handleToggleExpand}
              loadedPaths={loadedPaths}
              onMarkLoaded={handleMarkLoaded}
              pendingUploads={pendingUploads}
            />
          ))}
        </LoadingContent>
      </div>
      <FileUpload squadId={squadId} onUploadStart={handleUploadStart} onUploadComplete={handleUploadComplete} />
    </div>
  )
}

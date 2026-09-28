import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { TreeNode } from '../../api/workspace'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { LoadingContent, LoadingSurface, SkeletonBlock, SkeletonRows } from '../loading/Skeleton'

import { FolderIcon } from '../icons/FolderIcon'
import { FileIcon, ChevronDownIcon, ChevronRightIcon, RefreshIcon, SpinnerIcon } from '../icons'

export interface MemoryTreeProps {
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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
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
}: TreeItemProps) {
  const isExpanded = expandedPaths.has(path)
  const isSelected = selectedPath === path
  const isDirectory = node.type === 'directory'
  const needsLoad = isDirectory && isExpanded && !loadedPaths.has(path)

  const { data: subtree, isLoading } = useQuery({
    ...queries.squadMemory.tree(squadId, path, 1),
    enabled: needsLoad,
    staleTime: 30000,
  })

  useEffect(() => {
    if (subtree && needsLoad) onMarkLoaded(path)
  }, [subtree, needsLoad, onMarkLoaded, path])

  const children = subtree?.children ?? node.children ?? []

  return (
    <div>
      <button
        type="button"
        aria-expanded={isDirectory ? isExpanded : undefined}
        aria-current={isSelected ? 'true' : undefined}
        className={clsx(
          'w-full text-left px-2 py-2 flex items-center gap-2 hover:bg-surface-hover rounded-lg text-sm text-secondary cursor-pointer transition-colors focus-visible:outline-accent',
          isSelected && 'bg-accent/10 text-accent-light'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => (isDirectory ? onToggleExpand(path, !isExpanded) : onSelectFile(path))}
      >
        <span className="w-4 shrink-0 text-muted">
          {isDirectory &&
            (isLoading ? (
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
            ) : isExpanded ? (
              <ChevronDownIcon className="h-3.5 w-3.5" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5" />
            ))}
        </span>
        {isDirectory ? (
          <FolderIcon className="h-4 w-4 shrink-0 text-muted" />
        ) : (
          <FileIcon className="h-4 w-4 shrink-0 text-muted" />
        )}
        <span className="truncate flex-1">{node.name}</span>
        {!isDirectory && node.size !== undefined && <span className="text-xs text-muted">{formatSize(node.size)}</span>}
      </button>

      {isDirectory && isExpanded && children.length > 0 && (
        <div>
          {children.map((child) => {
            const childPath = path === '/memory' ? `/memory/${child.name}` : `${path}/${child.name}`
            return (
              <TreeItem
                key={child.name}
                node={child}
                path={childPath}
                depth={depth + 1}
                squadId={squadId}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                loadedPaths={loadedPaths}
                onMarkLoaded={onMarkLoaded}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MemoryTree({ squadId, onSelectFile, selectedPath }: MemoryTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['/memory']))
  const [loadedPaths, setLoadedPaths] = useState<Set<string>>(new Set(['/memory']))
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!selectedPath) return
    const parts = selectedPath.split('/').filter(Boolean)
    const ancestors: string[] = []
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(`/${parts.slice(0, i).join('/')}`)
    }
    setExpandedPaths((prev) => new Set([...prev, ...ancestors]))
  }, [selectedPath])

  const {
    data: rootTree,
    isLoading,
    isError,
    isSuccess,
    refetch,
  } = useQuery({
    ...queries.squadMemory.tree(squadId, '/memory', 1),
    staleTime: 30000,
  })
  const rootSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:memory-tree-root`,
    isSuccess ? (rootTree?.children?.length ?? 0) : undefined,
    { fallbackCount: 7, maxCount: 14 }
  )

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.tree(squadId) })
    setLoadedPaths(new Set(['/memory']))
    refetch()
  }, [queryClient, refetch, squadId])

  const handleToggleExpand = useCallback((path: string, expanded: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (expanded) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const handleMarkLoaded = useCallback((path: string) => {
    setLoadedPaths((prev) => new Set(prev).add(path))
  }, [])

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-secondary">Memory files</span>
        <button
          onClick={handleRefresh}
          className="ficus-button rounded-lg p-2 text-muted hover:text-primary hover:bg-surface-hover"
          title="Refresh memory"
          aria-label="Refresh memory"
        >
          <RefreshIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        <LoadingContent
          loading={isLoading}
          fallback={
            <LoadingSurface label="Loading memory">
              <SkeletonRows count={Math.max(1, rootSkeletonCount)}>
                {(index) => (
                  <div key={index} className="flex items-center gap-2 px-2 py-2">
                    <span className="w-4" />
                    <SkeletonBlock className="h-4 w-4" />
                    <SkeletonBlock className={index % 3 ? 'h-5 w-28' : 'h-5 w-36'} />
                  </div>
                )}
              </SkeletonRows>
            </LoadingSurface>
          }
        >
          {isError ? (
            <div className="p-3 text-sm text-muted">
              Couldn’t load memory.{' '}
              <button onClick={handleRefresh} className="ficus-button text-accent-light">
                Retry
              </button>
            </div>
          ) : !rootTree?.children?.length ? (
            <p className="p-3 text-sm text-muted">Memory vault is empty</p>
          ) : (
            rootTree.children.map((child) => (
              <TreeItem
                key={child.name}
                node={child}
                path={`/memory/${child.name}`}
                depth={0}
                squadId={squadId}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                loadedPaths={loadedPaths}
                onMarkLoaded={handleMarkLoaded}
              />
            ))
          )}
        </LoadingContent>
      </div>
    </div>
  )
}

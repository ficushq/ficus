import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { LocalDeployment, LocalDeploymentStatus } from '../../api/workspace'
import {
  archiveLocalDeployment,
  restartLocalDeployment,
  stopLocalDeployment,
  subscribeToLocalDeploymentLogs,
} from '../../api/workspace'
import { useURLStringState } from '../../hooks/useURLState'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { Badge, type BadgeColor } from '../Badge'
import { Modal } from '../Modal'
import { CollectionSkeleton } from '../loading/Skeleton'
import { ArchiveIcon, ChevronDownIcon, ClipboardIcon, LinkIcon, LogsIcon, RefreshIcon, StopIcon } from '../icons'

interface LocalDeploymentsPanelProps {
  squadId: string
}

type LocalDeploymentStatusFilter = 'all' | LocalDeploymentStatus

const STATUS_COLORS: Record<LocalDeployment['status'], BadgeColor> = {
  starting: 'review',
  running: 'success',
  restarting: 'progress',
  unhealthy: 'externalWait',
  crashed: 'danger',
  stopped: 'neutral',
}

const STATUS_FILTERS: LocalDeploymentStatusFilter[] = [
  'all',
  'starting',
  'running',
  'restarting',
  'unhealthy',
  'crashed',
  'stopped',
]

function getLocalDeploymentBrowserUrl(urlPathOrHost: string): string {
  if (/^https?:\/\//i.test(urlPathOrHost)) return urlPathOrHost

  const appUrl = __TAU_APP_URL__ || window.location.origin
  const appBasePath = __TAU_APP_BASE_PATH__ || import.meta.env.BASE_URL || ''
  const base = new URL(appUrl)
  const existingPath = base.pathname.replace(/^\/+|\/+$/g, '')
  const basePath = appBasePath.replace(/^\/+|\/+$/g, '')
  const pathParts = existingPath.endsWith(basePath) ? [existingPath] : [existingPath, basePath]
  base.pathname = pathParts.filter(Boolean).join('/') + '/'
  return new URL(urlPathOrHost.replace(/^\/+/, ''), base).toString()
}

export function LocalDeploymentsPanel({ squadId }: LocalDeploymentsPanelProps) {
  const [copiedLocalDeploymentId, setCopiedLocalDeploymentId] = useState<string | null>(null)
  const [confirmArchiveLocalDeploymentId, setConfirmArchiveLocalDeploymentId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<LocalDeploymentStatusFilter>('all')
  const [showDone, setShowDone] = useState(false)
  const [logsLocalDeploymentId, setLogsLocalDeploymentId] = useURLStringState<string>('localDeploymentLogs', '')
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteDeployments = !permissionsLoading && can('deployments:write')
  const canDeleteDeployments = !permissionsLoading && can('deployments:delete')

  const { data: localDeployments = [], isLoading, isSuccess } = useQuery(queries.squads.localDeployments(squadId))
  const deploymentSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:local-deployments`,
    isSuccess ? localDeployments.length : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.localDeployments(squadId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.sandbox.status(squadId) })
  }

  const stopMutation = useMutation({ mutationFn: stopLocalDeployment, onSuccess: invalidate })
  const restartMutation = useMutation({ mutationFn: restartLocalDeployment, onSuccess: invalidate })
  const archiveMutation = useMutation({
    mutationFn: archiveLocalDeployment,
    onSuccess: () => {
      setConfirmArchiveLocalDeploymentId(null)
      invalidate()
    },
  })

  const visibleLocalDeployments = useMemo(() => {
    if (statusFilter === 'all') return localDeployments
    return localDeployments.filter((localDeployment) => localDeployment.status === statusFilter)
  }, [localDeployments, statusFilter])

  const activeLocalDeployments = visibleLocalDeployments.filter((localDeployment) => !localDeployment.archivedAt)
  const doneLocalDeployments = visibleLocalDeployments.filter((localDeployment) => localDeployment.archivedAt)
  const logsLocalDeployment =
    localDeployments.find((localDeployment) => localDeployment.id === logsLocalDeploymentId) ?? null

  useEffect(() => {
    if (
      logsLocalDeploymentId &&
      doneLocalDeployments.some((localDeployment) => localDeployment.id === logsLocalDeploymentId)
    )
      setShowDone(true)
  }, [doneLocalDeployments, logsLocalDeploymentId])

  const copyUrl = async (localDeployment: LocalDeployment) => {
    await navigator.clipboard.writeText(getLocalDeploymentBrowserUrl(localDeployment.urlPathOrHost))
    setCopiedLocalDeploymentId(localDeployment.id)
    window.setTimeout(
      () => setCopiedLocalDeploymentId((current) => (current === localDeployment.id ? null : current)),
      1500
    )
  }

  const openLocalDeployment = (localDeployment: LocalDeployment) => {
    window.open(getLocalDeploymentBrowserUrl(localDeployment.urlPathOrHost), '_blank', 'noopener,noreferrer')
  }

  const showLogs = (localDeployment: LocalDeployment) => setLogsLocalDeploymentId(localDeployment.id)
  const closeLogs = () => setLogsLocalDeploymentId('')

  const confirmArchiveLocalDeployment = (localDeployment: LocalDeployment) => {
    if (confirmArchiveLocalDeploymentId !== localDeployment.id) {
      setConfirmArchiveLocalDeploymentId(localDeployment.id)
      window.setTimeout(
        () => setConfirmArchiveLocalDeploymentId((current) => (current === localDeployment.id ? null : current)),
        3000
      )
      return
    }

    archiveMutation.mutate(localDeployment.id)
  }

  if (isLoading) return <CollectionSkeleton label="Loading local deployments" count={deploymentSkeletonCount} />
  if (localDeployments.length === 0) return <div className="text-sm text-muted">No local deployments running yet.</div>

  const isBusy = stopMutation.isPending || restartMutation.isPending || archiveMutation.isPending

  return (
    <div className="space-y-3 min-w-0">
      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((filter) => (
          <Badge
            key={filter}
            color={filter === 'all' ? 'neutral' : STATUS_COLORS[filter]}
            onClick={() => setStatusFilter(filter)}
            className={clsx(
              'capitalize cursor-pointer border',
              statusFilter === filter ? 'border-accent ring-1 ring-accent' : 'border-transparent opacity-70'
            )}
          >
            {filter}
          </Badge>
        ))}
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="ficus-section-title text-xs    text-muted">Active</h3>
          <span className="text-xs text-muted">{activeLocalDeployments.length}</span>
        </div>
        {activeLocalDeployments.length > 0 ? (
          <LocalDeploymentRows
            localDeployments={activeLocalDeployments}
            copiedLocalDeploymentId={copiedLocalDeploymentId}
            confirmArchiveLocalDeploymentId={confirmArchiveLocalDeploymentId}
            isBusy={isBusy}
            onCopy={copyUrl}
            onOpen={openLocalDeployment}
            onRestart={(localDeployment) => restartMutation.mutate(localDeployment.id)}
            onStop={(localDeployment) => stopMutation.mutate(localDeployment.id)}
            onArchive={confirmArchiveLocalDeployment}
            onShowLogs={showLogs}
            canWriteDeployments={canWriteDeployments}
            canDeleteDeployments={canDeleteDeployments}
          />
        ) : (
          <div className="border-b border-panel-border last:border-b-0 p-4 text-sm text-muted">
            No active local deployments.
          </div>
        )}
      </section>

      {doneLocalDeployments.length > 0 && (
        <section className="border-t border-th-border pt-2">
          <button
            type="button"
            onClick={() => setShowDone((value) => !value)}
            className="ficus-button w-full flex items-center justify-between text-left py-1 text-xs font-semibold uppercase tracking-wide text-muted hover:text-primary transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <ChevronDownIcon className={clsx('h-4 w-4 transition-transform', !showDone && '-rotate-90')} />
              Done
            </span>
            <span>{doneLocalDeployments.length}</span>
          </button>
          {showDone && (
            <div className="mt-2">
              <LocalDeploymentRows
                localDeployments={doneLocalDeployments}
                copiedLocalDeploymentId={copiedLocalDeploymentId}
                confirmArchiveLocalDeploymentId={confirmArchiveLocalDeploymentId}
                isBusy={isBusy}
                archived
                onCopy={copyUrl}
                onOpen={openLocalDeployment}
                onRestart={(localDeployment) => restartMutation.mutate(localDeployment.id)}
                onStop={(localDeployment) => stopMutation.mutate(localDeployment.id)}
                onArchive={confirmArchiveLocalDeployment}
                onShowLogs={showLogs}
                canWriteDeployments={canWriteDeployments}
                canDeleteDeployments={canDeleteDeployments}
              />
            </div>
          )}
        </section>
      )}

      {logsLocalDeployment && <LocalDeploymentLogsModal localDeployment={logsLocalDeployment} onClose={closeLogs} />}
    </div>
  )
}

interface LocalDeploymentRowsProps {
  localDeployments: LocalDeployment[]
  copiedLocalDeploymentId: string | null
  confirmArchiveLocalDeploymentId: string | null
  isBusy: boolean
  archived?: boolean
  onCopy: (localDeployment: LocalDeployment) => void
  onOpen: (localDeployment: LocalDeployment) => void
  onRestart: (localDeployment: LocalDeployment) => void
  onStop: (localDeployment: LocalDeployment) => void
  onArchive: (localDeployment: LocalDeployment) => void
  onShowLogs: (localDeployment: LocalDeployment) => void
  canWriteDeployments: boolean
  canDeleteDeployments: boolean
}

function LocalDeploymentRows({
  localDeployments,
  copiedLocalDeploymentId,
  confirmArchiveLocalDeploymentId,
  isBusy,
  archived = false,
  onCopy,
  onOpen,
  onRestart,
  onStop,
  onArchive,
  onShowLogs,
  canWriteDeployments,
  canDeleteDeployments,
}: LocalDeploymentRowsProps) {
  return (
    <div className="grid gap-2">
      {localDeployments.map((localDeployment) => {
        const canStop = !archived && localDeployment.status !== 'stopped' && !isBusy
        const canRestart = !archived && localDeployment.mode === 'managed' && !isBusy

        return (
          <div
            key={localDeployment.id}
            className={clsx(
              'w-full min-w-0 p-3 rounded-lg hover:bg-surface-hover transition-colors',
              archived && 'opacity-75'
            )}
          >
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={STATUS_COLORS[localDeployment.status]} className="capitalize">
                    {localDeployment.status}
                  </Badge>
                  {archived && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted/10 text-muted shrink-0">
                      Done
                    </span>
                  )}
                </div>
                <h4 className="text-sm font-medium text-primary mt-1 truncate">{localDeployment.name}</h4>
                <div className="mt-0.5 text-xs text-muted break-words">
                  {localDeployment.mode.toLowerCase()}
                  {localDeployment.mode === 'attached'
                    ? ` · logs ${localDeployment.logPath ? 'captured' : 'not captured'}`
                    : ''}{' '}
                  · port {localDeployment.port} · {localDeployment.visibility.toLowerCase()} · restarts{' '}
                  {localDeployment.restartCount} · updated {new Date(localDeployment.updatedAt).toLocaleString()}
                </div>
              </div>

              {!archived && (
                <div className="flex flex-wrap items-center gap-1 sm:justify-end sm:shrink-0">
                  <button
                    type="button"
                    onClick={() => onCopy(localDeployment)}
                    className="ficus-button p-1.5 rounded text-muted hover:text-primary transition-colors"
                    title="Copy local app URL"
                  >
                    <ClipboardIcon className="h-4 w-4" />
                  </button>
                  {copiedLocalDeploymentId === localDeployment.id && (
                    <span className="text-xs text-status-success-600 dark:text-status-success-400">Copied</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen(localDeployment)}
                    className="ficus-button p-1.5 rounded text-muted hover:text-primary transition-colors"
                    title="Open local app"
                  >
                    <LinkIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRestart(localDeployment)}
                    disabled={!canWriteDeployments || !canRestart}
                    className="ficus-button p-1.5 rounded text-muted hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Restart local app"
                  >
                    <RefreshIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onShowLogs(localDeployment)}
                    className="ficus-button p-1.5 rounded text-muted hover:text-primary transition-colors"
                    title="View logs"
                  >
                    <LogsIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onStop(localDeployment)}
                    disabled={!canWriteDeployments || !canStop}
                    className="ficus-button p-1.5 rounded text-status-danger-600 dark:text-status-danger-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Stop local app"
                  >
                    <StopIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onArchive(localDeployment)}
                    disabled={!canDeleteDeployments || isBusy}
                    className={clsx(
                      'ficus-button',
                      'p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                      confirmArchiveLocalDeploymentId === localDeployment.id
                        ? 'text-status-danger-700 dark:text-status-danger-300'
                        : 'text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400'
                    )}
                    title={
                      confirmArchiveLocalDeploymentId === localDeployment.id
                        ? 'Click again to archive local app'
                        : 'Archive local app'
                    }
                  >
                    {confirmArchiveLocalDeploymentId === localDeployment.id ? (
                      <span className="text-[11px] font-medium px-0.5">Confirm</span>
                    ) : (
                      <ArchiveIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LocalDeploymentLogsModal({
  localDeployment,
  onClose,
}: {
  localDeployment: LocalDeployment
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [autoScroll, setAutoScrollState] = useState(true)
  const autoScrollRef = useRef(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const userScrollingRef = useRef(false)
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setAutoScroll = useCallback((value: boolean) => {
    autoScrollRef.current = value
    setAutoScrollState(value)
  }, [])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollContainerRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const markUserScrolling = useCallback(() => {
    userScrollingRef.current = true
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false
    }, 150)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

    if (userScrollingRef.current && autoScrollRef.current && distFromBottom > 30) {
      setAutoScroll(false)
    } else if (!autoScrollRef.current && distFromBottom < 30) {
      setAutoScroll(true)
    }
  }, [setAutoScroll])

  useEffect(() => {
    setLines([])
    setError(null)
    setAutoScroll(true)
    return subscribeToLocalDeploymentLogs(localDeployment.id, {
      onLines: (nextLines) => setLines((current) => [...current, ...nextLines].slice(-500)),
      onError: (err) => setError(err.message),
    })
  }, [localDeployment.id, setAutoScroll])

  useEffect(() => {
    if (autoScrollRef.current) scrollToBottom()
  }, [lines, scrollToBottom])

  useEffect(() => {
    return () => {
      if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    }
  }, [])

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${localDeployment.name} logs`}
      maxWidth="chat"
      noChildPadding
      headerExtra={
        <button
          type="button"
          onClick={() => {
            const next = !autoScroll
            setAutoScroll(next)
            if (next) scrollToBottom()
          }}
          className={clsx(
            'ficus-button',
            'px-2 py-1 rounded text-xs border transition-colors',
            autoScroll
              ? 'border-accent bg-accent/10 text-accent-light'
              : 'border-th-border text-muted hover:text-primary'
          )}
          title={autoScroll ? 'Following new logs' : 'Click to follow new logs'}
        >
          {autoScroll ? 'Following' : 'Follow'}
        </button>
      }
    >
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={markUserScrolling}
        onTouchMove={markUserScrolling}
        className="min-h-[50vh] max-h-[70vh] overflow-auto bg-status-neutral-950 text-status-neutral-100 p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {error ? <div className="text-status-danger-300">{error}</div> : null}
        {lines.length === 0 && !error ? <div className="text-status-neutral-400">Waiting for logs…</div> : null}
        {lines.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
    </Modal>
  )
}

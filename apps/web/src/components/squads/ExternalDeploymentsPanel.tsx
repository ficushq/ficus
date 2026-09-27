import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { archiveAppDeployment, listAppDeployments } from '../../api/workspace'
import { queryKeys } from '../../queryKeys'
import { ArchiveIcon, ChevronDownIcon, ClipboardIcon, CloudIcon, LinkIcon } from '../icons'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

interface ExternalDeploymentsPanelProps {
  squadId: string
}

export function ExternalDeploymentsPanel({ squadId }: ExternalDeploymentsPanelProps) {
  const [showDone, setShowDone] = useState(false)
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)
  const [copiedDeploymentId, setCopiedDeploymentId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canDeleteDeployments = !permissionsLoading && can('deployments:delete')
  const {
    data: deployments = [],
    isLoading,
    isSuccess,
    error,
  } = useQuery({
    queryKey: queryKeys.squads.deployments(squadId),
    queryFn: () => listAppDeployments(squadId),
  })
  const deploymentSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:external-deployments`,
    isSuccess ? deployments.length : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )
  const archiveMutation = useMutation({
    mutationFn: archiveAppDeployment,
    onSuccess: () => {
      setConfirmArchiveId(null)
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.deployments(squadId) })
    },
  })

  const activeDeployments = deployments.filter((deployment) => !deployment.archivedAt)
  const doneDeployments = deployments.filter((deployment) => deployment.archivedAt)

  const copyDeploymentUrl = async (deployment: Deployment) => {
    if (!deployment.url) return
    await navigator.clipboard.writeText(deployment.url)
    setCopiedDeploymentId(deployment.id)
    window.setTimeout(() => setCopiedDeploymentId((current) => (current === deployment.id ? null : current)), 1500)
  }

  const archiveDeployment = (deploymentId: string) => {
    if (confirmArchiveId !== deploymentId) {
      setConfirmArchiveId(deploymentId)
      window.setTimeout(() => setConfirmArchiveId((current) => (current === deploymentId ? null : current)), 3000)
      return
    }
    archiveMutation.mutate(deploymentId)
  }

  return (
    <section className="border-b border-panel-border last:border-b-0 pb-4 min-w-0 overflow-hidden">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-primary">Deployments</h3>
        <p className="text-xs text-muted mt-1">External provider deployment records maintained by agents/operators.</p>
      </div>

      {isLoading ? (
        <CollectionSkeleton label="Loading external deployments" count={deploymentSkeletonCount} />
      ) : error ? (
        <div className="text-sm text-status-danger-500">Failed to load deployments</div>
      ) : deployments.length === 0 ? (
        <div className="text-sm text-muted">No external deployments recorded yet.</div>
      ) : (
        <div className="space-y-3 min-w-0">
          <DeploymentRows
            deployments={activeDeployments}
            confirmArchiveId={confirmArchiveId}
            copiedDeploymentId={copiedDeploymentId}
            isArchiving={archiveMutation.isPending}
            onCopy={copyDeploymentUrl}
            onArchive={canDeleteDeployments ? archiveDeployment : undefined}
          />

          {doneDeployments.length > 0 && (
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
                <span>{doneDeployments.length}</span>
              </button>
              {showDone && (
                <div className="mt-2">
                  <DeploymentRows deployments={doneDeployments} archived />
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  )
}

type Deployment = Awaited<ReturnType<typeof listAppDeployments>>[number]

function DeploymentRows({
  deployments,
  archived = false,
  copiedDeploymentId,
  confirmArchiveId,
  isArchiving = false,
  onCopy,
  onArchive,
}: {
  deployments: Deployment[]
  archived?: boolean
  copiedDeploymentId?: string | null
  confirmArchiveId?: string | null
  isArchiving?: boolean
  onCopy?: (deployment: Deployment) => void
  onArchive?: (deploymentId: string) => void
}) {
  if (deployments.length === 0 && !archived) return <div className="text-sm text-muted">No active deployments.</div>

  return (
    <div className="space-y-3 min-w-0">
      {deployments.map((deployment) => (
        <div
          key={deployment.id}
          className={clsx(
            'rounded-md border border-th-border bg-surface-secondary p-3 min-w-0',
            archived && 'opacity-75'
          )}
        >
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary truncate">{deployment.name}</div>
              <div className="text-xs text-muted break-words">
                {deployment.provider} · {deployment.environment} · {deployment.status} · updated{' '}
                {new Date(deployment.updatedAt).toLocaleString()}
              </div>
            </div>
            {!archived && (
              <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                {deployment.url && onCopy && (
                  <>
                    <button
                      type="button"
                      onClick={() => onCopy(deployment)}
                      className="ficus-button p-1.5 rounded text-muted hover:text-primary transition-colors"
                      title="Copy app URL"
                      aria-label="Copy app URL"
                    >
                      <ClipboardIcon className="h-4 w-4" />
                    </button>
                    {copiedDeploymentId === deployment.id && (
                      <span className="text-xs text-status-success-600 dark:text-status-success-400">Copied</span>
                    )}
                  </>
                )}
                {deployment.url && (
                  <a
                    href={deployment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded text-muted hover:text-primary transition-colors"
                    title="Open app"
                    aria-label="Open app"
                  >
                    <LinkIcon className="h-4 w-4" />
                  </a>
                )}
                {deployment.providerProjectUrl && (
                  <a
                    href={deployment.providerProjectUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded text-muted hover:text-primary transition-colors"
                    title="Open provider dashboard"
                    aria-label="Open provider dashboard"
                  >
                    <CloudIcon className="h-4 w-4" />
                  </a>
                )}
                {onArchive && (
                  <button
                    type="button"
                    onClick={() => onArchive(deployment.id)}
                    disabled={isArchiving}
                    className={clsx(
                      'ficus-button',
                      'p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                      confirmArchiveId === deployment.id
                        ? 'text-status-danger-700 dark:text-status-danger-300'
                        : 'text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400'
                    )}
                    title={
                      confirmArchiveId === deployment.id ? 'Click again to archive deployment' : 'Archive deployment'
                    }
                  >
                    {confirmArchiveId === deployment.id ? (
                      <span className="text-[11px] font-medium px-0.5">Confirm</span>
                    ) : (
                      <ArchiveIcon className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
          {(deployment.logsCommand || deployment.rollbackCommand) && (
            <div className="mt-2 space-y-1 text-xs text-muted min-w-0">
              {deployment.logsCommand && (
                <div>
                  Logs: <code className="font-mono break-all">{deployment.logsCommand}</code>
                </div>
              )}
              {deployment.rollbackCommand && (
                <div>
                  Rollback: <code className="font-mono break-all">{deployment.rollbackCommand}</code>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

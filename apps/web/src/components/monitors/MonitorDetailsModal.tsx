import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Monitor } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { monitorsApi } from '../../api/monitors'
import { AnsiText } from '../AnsiText'
import { ConfirmButton } from '../ConfirmButton'
import { Modal } from '../Modal'
import { usePermissions } from '../../hooks/usePermissions'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

const ACTIVE = new Set(['starting', 'running', 'canceling'])

function isActiveMonitor(monitor: Monitor) {
  return ACTIVE.has(monitor.status)
}

function DetailItem({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-md border border-th-border bg-surface-secondary p-2 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 truncate text-sm text-primary">{value ?? '-'}</div>
    </div>
  )
}

export interface MonitorDetailsModalProps {
  monitorId: string
  initialMonitor?: Monitor
  onClose: () => void
}

export function MonitorDetailsModal({ monitorId, initialMonitor, onClose }: MonitorDetailsModalProps) {
  const [tail, setTail] = useState(100)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWriteMonitors = !permissionsLoading && can('monitors:write')
  const queryClient = useQueryClient()
  const detailQuery = useQuery({
    ...queries.monitors.detail(monitorId),
    refetchInterval: (query) => {
      const monitor = query.state.data
      return monitor && isActiveMonitor(monitor) ? 4000 : false
    },
  })
  const detail = detailQuery.data ?? initialMonitor
  const { data: logs } = useQuery({
    ...queries.monitors.logs(monitorId, tail),
    enabled: Boolean(detail),
    refetchInterval: detail?.status === 'running' ? 3000 : false,
  })
  const cancel = useMutation({
    mutationFn: monitorsApi.cancel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitors.all }),
  })

  if (!detail) {
    return (
      <Modal isOpen onClose={onClose} title="Monitor" maxWidth="chat">
        {detailQuery.isError ? (
          <div className="space-y-2 text-sm text-status-danger-600">
            <p>Unable to load monitor details.</p>
            <button
              type="button"
              className="ficus-button font-medium text-accent-light hover:underline"
              onClick={() => detailQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : (
          <LoadingSurface label="Loading monitor details" className="space-y-4">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <SkeletonRows count={8}>
                {(index) => (
                  <div key={index} className="space-y-2 rounded-md border border-th-border p-2">
                    <SkeletonLine className="h-2 w-12" />
                    <SkeletonLine className={index % 2 ? 'w-16' : 'w-24'} />
                  </div>
                )}
              </SkeletonRows>
            </div>
            <div className="space-y-2">
              <SkeletonLine className="w-20" />
              <SkeletonBlock className="h-14 w-full bg-status-neutral-900" />
            </div>
            <div className="space-y-2">
              <SkeletonLine className="w-24" />
              <SkeletonBlock className="h-40 w-full bg-status-neutral-900" />
            </div>
          </LoadingSurface>
        )}
      </Modal>
    )
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={detail.label}
      maxWidth="chat"
      headerExtra={<span className="font-mono text-xs text-muted truncate">{detail.id}</span>}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <DetailItem label="Status" value={detail.status} />
          <DetailItem label="Lines" value={detail.linesEmitted} />
          <DetailItem label="Bytes" value={detail.bytesEmitted} />
          <DetailItem label="Exit" value={detail.exitCode ?? '-'} />
          <DetailItem label="Created" value={detail.createdAt} />
          <DetailItem label="Started" value={detail.startedAt ?? '-'} />
          <DetailItem label="Ended" value={detail.endedAt ?? '-'} />
          <DetailItem label="Last batch" value={detail.lastBatchAt ?? '-'} />
        </div>

        {detail.failureReason && (
          <p className="rounded-md border border-status-danger-200 bg-status-danger-50 p-2 text-sm text-status-danger-700 dark:border-status-danger-900/60 dark:bg-status-danger-900/30 dark:text-status-danger-300">
            {detail.failureReason}
          </p>
        )}

        <div>
          <h3 className="mb-2 text-sm font-medium text-primary">Command</h3>
          <pre className="overflow-auto rounded-md bg-status-neutral-950 p-3 text-xs text-status-neutral-100 border border-th-border">
            {detail.command}
          </pre>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-primary">Recent log</h3>
            <div className="flex items-center gap-2">
              {tail < 500 && (
                <button
                  className="ficus-button rounded-md px-2 py-1 text-sm font-medium text-accent-light hover:bg-surface-hover transition-colors"
                  onClick={() => setTail(500)}
                >
                  Load 500
                </button>
              )}
              {isActiveMonitor(detail) && (
                <ConfirmButton
                  label="Cancel"
                  onConfirm={() => cancel.mutate(detail.id)}
                  disabled={!canWriteMonitors || cancel.isPending}
                  title={canWriteMonitors ? 'Cancel monitor' : 'You do not have permission to cancel monitors'}
                  className="ficus-button rounded-md px-2 py-1 text-xs font-medium text-status-danger-600 hover:bg-status-danger-50 dark:text-status-danger-400 dark:hover:bg-status-danger-900/30 transition-colors"
                  confirmClassName="rounded-md bg-status-danger-50 px-2 py-1 text-xs font-medium text-status-danger-700 hover:bg-status-danger-100 dark:bg-status-danger-900/30 dark:text-status-danger-300 dark:hover:bg-status-danger-900/50 transition-colors"
                />
              )}
            </div>
          </div>
          <pre className="max-h-80 overflow-auto rounded-md bg-status-neutral-950 p-3 text-xs text-status-neutral-100 border border-th-border">
            <AnsiText>{logs?.lines.join('\n') ?? ''}</AnsiText>
          </pre>
        </div>
      </div>
    </Modal>
  )
}

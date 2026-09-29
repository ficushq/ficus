import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StorageFolder, StorageMachine } from '@ficus/shared'
import { refreshStorage } from '../../api/system'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { StorageMonitorSettings } from './StorageMonitorSettings'
import { ChevronRightIcon } from '../icons'

function storageSize(bytes: number | null): string {
  if (bytes === null) return 'Unavailable'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1)
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`
}

const scanReasons: Record<NonNullable<StorageMachine['diagnostics']>['reasons'][number], string> = {
  scan_timeout: 'The scan reached its 45-second time limit.',
  permission_denied: 'Some directories could not be read with the scanner’s permissions.',
  scan_failed: 'The scan command did not complete successfully.',
  incomplete_output: 'The directory traversal did not return all totals.',
  missing_home_totals: 'Some sandbox home totals are missing; their measured folders are still shown.',
  disk_usage_unavailable: 'Filesystem capacity could not be measured.',
  ssh_timeout: 'The connection timed out before results were received.',
  ssh_failed: 'The machine could not be reached for storage measurement.',
  machine_not_ready: 'The machine is offline, parked, or not ready to scan.',
}

function measuredSize(item: { bytes: number | null; status?: string }): string {
  if (item.bytes === null) return 'Not measured'
  return `${storageSize(item.bytes)}${item.status === 'partial' ? ' measured · Partial' : ''}`
}

function FolderRow({ folder }: { folder: StorageFolder }) {
  const label = (
    <span className="inline-flex w-full min-w-0 items-baseline justify-between gap-4">
      <span className="min-w-0 break-all" title={folder.path}>
        {folder.name}
      </span>
      <span className="shrink-0 tabular-nums text-secondary">{measuredSize(folder)}</span>
    </span>
  )
  if (!folder.children.length) return <div className="py-2 pl-5 text-sm">{label}</div>
  return (
    <details className="text-sm [&[open]>summary>svg]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
        {label}
      </summary>
      <div className="ml-4 border-l border-th-border pl-3">
        {folder.children.map((child) => (
          <FolderRow key={child.name} folder={child} />
        ))}
      </div>
    </details>
  )
}

export function StorageSection() {
  const { can } = usePermissions()
  const query = useQuery(queries.system.storage())
  const client = useQueryClient()
  const refresh = useMutation({
    mutationFn: refreshStorage,
    onSuccess: (data) => client.setQueryData(queryKeys.system.storage(), data),
  })
  const data = query.data
  return (
    <section className="space-y-6" aria-labelledby="storage-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="storage-heading" className="text-lg font-semibold text-primary">
            Storage
          </h2>
          <p className="mt-1 text-sm text-secondary">Find the squads and project folders using the most disk space.</p>
        </div>
        <button
          className="ficus-button ficus-button-secondary shrink-0 px-3 py-2 text-sm"
          disabled={query.isPending || data?.scanning || refresh.isPending || data?.supported === false}
          onClick={() => refresh.mutate()}
        >
          {data?.scanning || refresh.isPending ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      {data?.supported && data.monitoring && can('settings:write') && (
        <StorageMonitorSettings
          key={JSON.stringify([
            data.monitoring.intervalHours,
            data.monitoring.thresholds,
            data.monitoring.alertsEnabled,
          ])}
          config={data.monitoring}
        />
      )}
      {data?.warnings?.map((warning) => (
        <p key={warning.machineId} role="status" className="text-sm text-status-attention-500">
          {warning.machineName}: {warning.percent.toFixed(1)}% full at {new Date(warning.measuredAt).toLocaleString()}.
          {warning.stale ? ' Stale reading; current capacity is unknown.' : ''}
        </p>
      ))}
      <p className="text-xs text-secondary" role="status">
        {data?.scanning ? 'Measuring storage in the background… ' : ''}
        {data?.monitoring?.nextScanAt
          ? `Next scheduled scan ${new Date(data.monitoring.nextScanAt).toLocaleString()}. `
          : ''}
        {data?.scannedAt ? `Last scanned ${new Date(data.scannedAt).toLocaleString()}.` : 'Waiting for the first scan.'}
      </p>
      {(query.isError || refresh.isError || data?.error) && (
        <p role="alert" className="text-sm text-status-danger-400">
          {data?.error ?? 'Could not load storage. Try refreshing.'}
        </p>
      )}
      {query.isPending && (
        <div className="h-28 animate-pulse rounded-lg bg-surface-secondary" aria-label="Loading storage" />
      )}
      {data?.supported === false && (
        <p className="text-sm text-secondary">
          Storage breakdown is available for Cloud and self-hosted instances using VM sandbox machines.
        </p>
      )}
      {data?.supported && data.scannedAt && !data.machines.length && (
        <p className="text-sm text-secondary">No sandbox machines to measure yet.</p>
      )}
      {data?.machines.map((machine) => (
        <div key={machine.id} className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium text-primary">{machine.name}</h3>
            <span className="text-sm text-secondary">
              {storageSize(machine.usedBytes)} used / {storageSize(machine.totalBytes)}
            </span>
          </div>
          {machine.usedBytes !== null && machine.totalBytes !== null && (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-inset"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={machine.totalBytes}
              aria-valuenow={machine.usedBytes}
              aria-label={`${machine.name} disk usage`}
            >
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, (machine.usedBytes / machine.totalBytes) * 100)}%` }}
              />
            </div>
          )}
          {machine.status !== 'available' && (
            <p className="text-sm text-secondary">
              {machine.status === 'partial'
                ? 'Partial scan. Some directories could not be measured; shown sizes may be incomplete.'
                : 'Storage is unavailable. The machine may be offline or parked.'}
            </p>
          )}
          {machine.diagnostics && machine.status !== 'available' && (
            <div className="space-y-1 text-xs text-secondary">
              {machine.diagnostics.reasons.map((reason) => (
                <p key={reason}>{scanReasons[reason]}</p>
              ))}
              <p>
                {machine.diagnostics.measuredHomes} of {machine.diagnostics.expectedHomes} sandbox home totals returned.
              </p>
            </div>
          )}
          <div className="divide-y divide-th-border">
            {machine.squads.map((squad) => (
              <details key={squad.id} className="[&[open]>summary>svg]:rotate-90">
                <summary className="flex cursor-pointer list-none items-center gap-2 py-3 [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
                  <span className="inline-flex w-full min-w-0 justify-between gap-4 text-sm">
                    <span className="min-w-0 break-words font-medium">{squad.name}</span>
                    <span className="shrink-0 tabular-nums">{measuredSize(squad)}</span>
                  </span>
                </summary>
                <div className="pb-3 pl-5">
                  {squad.folders.map((folder, index) => (
                    <FolderRow key={index} folder={folder} />
                  ))}
                </div>
              </details>
            ))}
            {machine.unattributedBytes !== null && (
              <div className="flex justify-between gap-4 py-3 text-sm text-secondary">
                <span>Other disk usage</span>
                <span className="shrink-0 tabular-nums">{storageSize(machine.unattributedBytes)}</span>
              </div>
            )}
          </div>
        </div>
      ))}
      {data?.supported && (
        <div className="space-y-2 text-xs text-secondary">
          <p>
            Expand a squad to inspect its workspace, repositories, worktrees, caches, and agent files. Folder sizes
            include their contents; they are not additional usage.
          </p>
          <p>
            Other disk usage includes shared tools, system files, and storage not attributed to a squad. Sizes are
            estimates of allocated space; shared files and changes during a scan can affect attribution. Hardlinked
            files are counted once and may be attributed to the first folder visited; a folder's size is not a
            prediction of space freed by deleting it.
          </p>
          <p>
            Measurements are saved and scanned by the worker on the configured schedule, even with this page closed.
            These are the latest measured values, not continuous live readings. Manual requests are limited to once a
            minute and start on the next worker check. Scanning does not start agents or remove files.
          </p>
        </div>
      )}
    </section>
  )
}

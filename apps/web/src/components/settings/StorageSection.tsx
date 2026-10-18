import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StorageMachine } from '@ficus/shared'
import { refreshStorage } from '../../api/system'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { StorageMonitorSettings } from './StorageMonitorSettings'
import { DormantRetentionSettings } from './storage/DormantRetentionSettings'
import { HostCleanupSection } from './storage/HostCleanupSection'
import { StorageSquadView } from './storage/StorageSquadView'
import { StoredFilesSection } from './storage/StoredFilesSection'
import { GrowthText } from './storage/FolderRow'
import { scanProgressLabel, storageSize } from './storage/format'

const scanReasons: Record<NonNullable<StorageMachine['diagnostics']>['reasons'][number], string> = {
  scan_timeout: 'Some directories could not be measured in time, even in smaller parts; they are marked Partial.',
  permission_denied: 'Some directories could not be read with the scanner’s permissions.',
  scan_failed: 'The last scan step did not complete; scanning retries automatically.',
  incomplete_output: 'The directory traversal did not return all totals.',
  missing_home_totals: 'Some sandbox homes have not been measured yet.',
  disk_usage_unavailable: 'Filesystem capacity could not be measured.',
  ssh_timeout: 'The connection timed out during the last scan step; scanning retries automatically.',
  ssh_failed: 'The machine could not be reached; scanning resumes where it stopped once it is reachable.',
  machine_not_ready: 'The machine is offline, parked, or not ready; scanning resumes where it stopped.',
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
  const retentionDays = data?.dormantRetentionDays ?? 7
  const [notice, setNotice] = useState<string | null>(null)
  const firstMachineBySquad = new Map<string, string>()
  for (const machine of data?.machines ?? [])
    for (const squad of machine.squads)
      if (!firstMachineBySquad.has(squad.id)) firstMachineBySquad.set(squad.id, machine.id)
  // Actions change agents and files now; measured disk sizes change only on the next scan.
  const actionDone = (message: string) => {
    setNotice(message)
    void client.invalidateQueries({ queryKey: queryKeys.system.all })
    void client.invalidateQueries({ queryKey: queryKeys.agents.all })
    void client.invalidateQueries({ queryKey: queryKeys.squads.all })
  }
  return (
    <section className="space-y-6" aria-labelledby="storage-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="storage-heading" className="text-lg font-semibold text-primary">
            Storage
          </h2>
          <p className="mt-1 text-sm text-secondary">
            Find the squads, agents and files using the most disk space, and clean up what is no longer needed.
          </p>
        </div>
        <button
          className="ficus-button ficus-button-secondary shrink-0 px-3 py-2 text-sm"
          disabled={query.isPending || data?.scanning || refresh.isPending || data?.supported === false}
          onClick={() => refresh.mutate()}
        >
          {data?.scanning || refresh.isPending ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      {data?.warnings?.map((warning) => (
        <p key={warning.machineId} role="status" className="text-sm text-status-attention-500">
          {warning.machineName}: {warning.percent.toFixed(1)}% full at {new Date(warning.measuredAt).toLocaleString()}.
          {warning.stale ? ' Stale reading; current capacity is unknown.' : ''}
        </p>
      ))}
      <p className="text-xs text-secondary" role="status">
        {data?.scanning ? 'Measuring storage in the background… ' : ''}
        {data?.monitoring?.nextScanAt
          ? `Next pass starts ${new Date(data.monitoring.nextScanAt).toLocaleString()}. `
          : ''}
        {data?.scannedAt
          ? `Last measured ${new Date(data.scannedAt).toLocaleString()}.`
          : 'Waiting for the first scan.'}
      </p>
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice} Sizes update after the next scan; use Refresh to scan sooner.
        </p>
      )}
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
              {machine.diskGrowth && (
                <>
                  {' · '}
                  <GrowthText growth={machine.diskGrowth} />
                </>
              )}
            </span>
          </div>
          {machine.scan && (
            <p className="text-xs text-secondary" role="status">
              {scanProgressLabel(machine.scan)}
            </p>
          )}
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
                ? 'Some homes are not measured yet or could not be fully measured. Each row shows its latest measured size.'
                : 'Storage is unavailable. The machine may be offline or parked.'}
            </p>
          )}
          {machine.diagnostics && machine.status !== 'available' && (
            <div className="space-y-1 text-xs text-secondary">
              {machine.diagnostics.reasons.map((reason) => (
                <p key={reason}>{scanReasons[reason]}</p>
              ))}
              <p>
                {machine.diagnostics.measuredHomes} of {machine.diagnostics.expectedHomes} sandbox homes have a
                measurement.
              </p>
            </div>
          )}
          <div className="divide-y divide-th-border">
            {machine.squads.map((squad) => (
              <StorageSquadView
                key={squad.id}
                squad={squad}
                showSquadActions={firstMachineBySquad.get(squad.id) === machine.id}
                retentionDays={retentionDays}
                onDone={actionDone}
              />
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
            Expand a squad to inspect its workspace and each agent&apos;s files, largest first. Folder sizes include
            their contents; they are not additional usage. Dormant agents keep their files until they are removed
            automatically {retentionDays} days after becoming dormant.
          </p>
          <p>
            Other disk usage includes shared tools, system files, and storage not attributed to a squad. Sizes are
            estimates of allocated space measured at different moments, so totals are approximate. Folder sizes can add
            up to more than the total: files hard-linked into several folders are counted in each. A home&apos;s total
            counts such a file once, except where it is marked approximate (≈ on a squad that includes one); a file
            hard-linked into several homes counts in each. A folder&apos;s size is not a prediction of space freed by
            deleting it.
          </p>
          <p>
            Storage is measured continuously in the background, a few homes at a time at low priority, even with this
            page closed. Each row shows its latest measured size and when it was measured; rows from the previous pass
            are marked as such until the current pass reaches them. Growth compares against a measurement about a day
            earlier. Refresh starts a new pass if none is running (at most once a minute). Scanning does not start
            agents or remove files.
          </p>
        </div>
      )}
      <StoredFilesSection />
      {can('system:cleanup') && <HostCleanupSection onDone={actionDone} />}
      {data && can('settings:write') && (
        <section className="space-y-5 border-t border-th-border pt-6" aria-labelledby="storage-settings-heading">
          <h3 id="storage-settings-heading" className="font-medium text-primary">
            Settings
          </h3>
          {data.supported && data.monitoring && (
            <StorageMonitorSettings
              key={JSON.stringify([
                data.monitoring.intervalHours,
                data.monitoring.thresholds,
                data.monitoring.alertsEnabled,
              ])}
              config={data.monitoring}
            />
          )}
          <DormantRetentionSettings key={retentionDays} days={retentionDays} />
        </section>
      )}
    </section>
  )
}

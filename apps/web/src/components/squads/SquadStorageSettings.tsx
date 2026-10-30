import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SquadStorageView } from '@ficus/shared'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { StorageSquadView } from '../settings/storage/StorageSquadView'
import { APPROXIMATE_SQUAD_HINT, squadScanLabel, storageSize } from '../settings/storage/format'

/**
 * Squad settings → Storage, for storage:read holders in this squad. The squad's share of the
 * instance Storage page (Settings → Storage, system:logs), drawn with the same rows: its box
 * homes on each machine, their folders, growth and measurement age, and the files Ficus stores
 * for it. Host disk totals, other squads and the instance quota are not in the response.
 * Read-only: there is no Refresh, because squad callers never start instance-wide scans.
 */
export function SquadStorageSettings({ squadId }: { squadId: string }) {
  const query = useQuery(queries.squads.storage(squadId))
  const client = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null)
  const data = query.data
  const retentionDays = data?.dormantRetentionDays ?? 7
  // The shared rows offer Make dormant (agents:terminate) and Remove now (system:cleanup) on
  // their own permission checks. Those change agents now; sizes change on the next pass.
  const actionDone = (message: string) => {
    setNotice(message)
    void client.invalidateQueries({ queryKey: queryKeys.squads.storage(squadId) })
    void client.invalidateQueries({ queryKey: queryKeys.agents.all })
  }
  return (
    <section className="space-y-6" aria-labelledby="squad-storage-heading">
      <div>
        <h2 id="squad-storage-heading" className="text-lg font-semibold text-primary">
          Storage
        </h2>
        <p className="mt-1 text-sm text-secondary">
          Disk space used by this squad&apos;s workspace and agents, and the files Ficus stores for it.
        </p>
      </div>
      <p className="text-xs text-secondary" role="status">
        {measuredStatus(data)}
      </p>
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice} Sizes update after the next scan.
        </p>
      )}
      {(query.isError || data?.error) && (
        <p role="alert" className="text-sm text-status-danger-400">
          {data?.error ?? 'Could not load storage for this squad.'}
        </p>
      )}
      {query.isPending && (
        <div className="h-28 animate-pulse rounded-lg bg-surface-secondary" aria-label="Loading storage" />
      )}
      {data?.supported === false && (
        <p className="text-sm text-secondary">
          Workspace and agent sizes are measured on Cloud and self-hosted instances using VM sandbox machines.
        </p>
      )}
      {data?.supported && !data.machines.length && (
        <p className="text-sm text-secondary">This squad has no measured workspace or agent files yet.</p>
      )}
      {/* With one machine, its squad row already shows the total. */}
      {data && data.machines.length > 1 && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-primary">Total across {data.machines.length} machines</span>
          <span className="tabular-nums" title={approximate(data) ? APPROXIMATE_SQUAD_HINT : undefined}>
            {data.bytes === null ? 'Not measured' : `${approximate(data) ? '≈ ' : ''}${storageSize(data.bytes)}`}
          </span>
        </div>
      )}
      {data?.machines.map((machine, index) => (
        <div key={machine.id} className="space-y-2">
          <h3 className="font-medium text-primary">{machine.name}</h3>
          {machine.scan && (
            <p className="text-xs text-secondary" role="status">
              {squadScanLabel(machine.scan)}
            </p>
          )}
          {machine.storage.status !== 'available' && (
            <p className="text-sm text-secondary">
              {machine.storage.status === 'partial'
                ? 'Some homes are not measured yet or could not be fully measured. Each row shows its latest measured size.'
                : 'Storage is unavailable. The machine may be offline or parked.'}
            </p>
          )}
          <div className="divide-y divide-th-border">
            <StorageSquadView
              squad={machine.storage}
              showSquadActions={index === 0}
              defaultOpen
              retentionDays={retentionDays}
              onDone={actionDone}
            />
          </div>
        </div>
      ))}
      {data?.supported && data.machines.length > 0 && (
        <div className="space-y-2 text-xs text-secondary">
          <p>
            Each machine lists this squad&apos;s workspace and each agent&apos;s files, largest first. Folder sizes
            include their contents; they are not additional usage. Dormant agents keep their files until they are
            removed automatically {retentionDays} days after becoming dormant.
          </p>
          <p>
            Sizes are estimates of allocated space measured at different moments, so totals are approximate. Folder
            sizes can add up to more than the total: files hard-linked into several folders are counted in each. A
            folder&apos;s size is not a prediction of space freed by deleting it. Storage is measured continuously in
            the background at low priority; growth compares against a measurement about a day earlier.
          </p>
        </div>
      )}
      {data && <SquadStoredFilesSummary storedFiles={data.storedFiles} />}
    </section>
  )
}

/** "Measuring storage in the background… Next pass starts …. Last measured …; oldest value from …." */
function measuredStatus(data: SquadStorageView | undefined): string {
  if (!data) return ''
  const parts: string[] = []
  if (data.scanning) parts.push('Measuring storage in the background…')
  if (data.monitoring.nextScanAt)
    parts.push(`Next pass starts ${new Date(data.monitoring.nextScanAt).toLocaleString()}.`)
  if (!data.supported) return parts.join(' ')
  if (!data.scannedAt) parts.push('Waiting for the first measurement.')
  else if (data.oldestMeasuredAt && data.oldestMeasuredAt !== data.scannedAt)
    parts.push(
      `Last measured ${new Date(data.scannedAt).toLocaleString()}; the oldest value is from ${new Date(data.oldestMeasuredAt).toLocaleString()}.`
    )
  else parts.push(`Last measured ${new Date(data.scannedAt).toLocaleString()}.`)
  return parts.join(' ')
}

const approximate = (data: SquadStorageView) => data.machines.some((machine) => machine.storage.totalExact === false)

/** The squad's attachments and images on the Ficus server, per source (no disk scan, no instance quota). */
function SquadStoredFilesSummary({ storedFiles }: { storedFiles: SquadStorageView['storedFiles'] }) {
  const sources = storedFiles.sources.filter((source) => source.bytes > 0)
  return (
    <section className="space-y-3" aria-labelledby="squad-stored-files-heading">
      <div>
        <h3 id="squad-stored-files-heading" className="font-medium text-primary">
          Files stored by Ficus
        </h3>
        <p className="mt-1 text-sm text-secondary">
          This squad&apos;s attachments and images kept on the Ficus server itself, totalled from Ficus&apos;s records.
          They are not part of the workspace and agent sizes above.
        </p>
      </div>
      <div className="divide-y divide-th-border">
        {sources.map((source) => (
          <div key={source.key} className="flex justify-between gap-4 py-2 text-sm">
            <span className="min-w-0 break-words">
              {source.label}
              {!source.countsTowardQuota && (
                <span className="block text-xs text-secondary">Does not count toward the attachment quota</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-secondary">{storageSize(source.bytes)}</span>
          </div>
        ))}
        {sources.length > 0 ? (
          <div className="flex justify-between gap-4 py-2 text-sm font-medium">
            <span>Total</span>
            <span className="shrink-0 tabular-nums">{storageSize(storedFiles.bytes)}</span>
          </div>
        ) : (
          <p className="py-2 text-sm text-secondary">No attachments or images are stored for this squad yet.</p>
        )}
      </div>
    </section>
  )
}

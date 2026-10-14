import { useQuery } from '@tanstack/react-query'
import type { StoredFilesSummary } from '@ficus/shared'
import { queries } from '../../../queryOptions'
import { storageSize } from './format'

function breakdown(summary: StoredFilesSummary, sources: Record<string, number>): string {
  return summary.sources
    .filter((source) => sources[source.key])
    .map((source) => `${source.label} ${storageSize(sources[source.key]!)}`)
    .join(' · ')
}

/** Attachments and images kept on the Ficus server, per squad, from Ficus's own records (no disk scan). */
export function StoredFilesSection() {
  const query = useQuery(queries.system.storedFiles())
  const summary = query.data
  return (
    <section className="space-y-3" aria-labelledby="stored-files-heading">
      <div>
        <h3 id="stored-files-heading" className="font-medium text-primary">
          Files stored by Ficus
        </h3>
        <p className="mt-1 text-sm text-secondary">
          Attachments and images kept on the Ficus server itself, totalled from Ficus&apos;s records. They are not part
          of the sandbox machine totals above.
        </p>
      </div>
      {query.isPending && <div className="h-16 animate-pulse rounded-lg bg-surface-secondary" aria-label="Loading" />}
      {query.isError && (
        <p role="alert" className="text-sm text-status-danger-400">
          Could not load stored files.
        </p>
      )}
      {summary && (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-sm text-secondary">
              <span>
                {storageSize(summary.quotaUsedBytes)} of {storageSize(summary.quotaBytes)} attachment quota
              </span>
              <span>{storageSize(summary.totalBytes)} stored in total</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-inset"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={summary.quotaBytes}
              aria-valuenow={summary.quotaUsedBytes}
              aria-label="Attachment storage quota"
            >
              <div
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${summary.quotaBytes > 0 ? Math.min(100, (summary.quotaUsedBytes / summary.quotaBytes) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="text-xs text-secondary">
              {summary.sources
                .filter((source) => !source.countsTowardQuota)
                .map((source) => source.label)
                .join(', ')}{' '}
              {summary.sources.some((source) => !source.countsTowardQuota) ? 'do not count toward the quota.' : ''}
            </p>
          </div>
          <div className="divide-y divide-th-border">
            {summary.squads.map((squad) => (
              <div key={squad.id} className="flex justify-between gap-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block break-words font-medium">{squad.name}</span>
                  <span className="block text-xs text-secondary">{breakdown(summary, squad.sources)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{storageSize(squad.bytes)}</span>
              </div>
            ))}
            {summary.unattributed.bytes > 0 && (
              <div className="flex justify-between gap-4 py-2 text-sm text-secondary">
                <span className="min-w-0">
                  <span className="block">Unattributed</span>
                  <span className="block text-xs">
                    People&apos;s and system inbox attachments, and files whose agent or squad no longer exists.{' '}
                    {breakdown(summary, summary.unattributed.sources)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{storageSize(summary.unattributed.bytes)}</span>
              </div>
            )}
            {!summary.squads.length && !summary.unattributed.bytes && (
              <p className="py-2 text-sm text-secondary">No attachments or images are stored yet.</p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

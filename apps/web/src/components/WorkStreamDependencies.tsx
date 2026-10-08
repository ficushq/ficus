import { useState } from 'react'
import clsx from 'clsx'
import { WORK_STREAM_STATUS_ROLE, workStreamTitle, type WorkStream, type WorkStreamWait } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import { getWsDisplayState, workStreamStatusLabel } from '../lib/workStreamStatusPresentation'
import { MarkdownContent } from './MarkdownContent'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { CheckIcon } from './icons'

/** "waiting 3m": how long a wait has been open, from its opening time. */
export function waitingFor(openedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(openedAt).getTime()) / 1000))
  if (seconds < 60) return `waiting ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `waiting ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `waiting ${hours}h`
  return `waiting ${Math.floor(hours / 24)}d`
}

/** A wait's relative age with its exact opening time on hover. */
export function WaitAge({ wait, className }: { wait: WorkStreamWait; className?: string }) {
  const opened = new Date(wait.openedAt)
  return (
    <time dateTime={wait.openedAt} title={opened.toLocaleString()} className={className}>
      {waitingFor(wait.openedAt)}
    </time>
  )
}

interface DependencyRow {
  /** The stream depended on; null for a dependency wait that names none. */
  id: string | null
  wait?: WorkStreamWait
}

/**
 * Every stream this one depends on, once: its link, status dot and state. A dependency with an open
 * wait reads "Blocking · waiting 3m"; a finished one is muted with a check. Dependency waits that name
 * a stream outside `dependsOn` (or none) still get a row, so no wait goes unexplained.
 */
export function WorkStreamDependencies({
  dependsOn,
  waits,
  streams,
  onSelectWorkStream,
}: {
  dependsOn: string[]
  /** The stream's open waits; only dependency waits are used. */
  waits: WorkStreamWait[]
  streams: Map<string, WorkStream>
  onSelectWorkStream?: (id: string) => void
}) {
  const dependencyWaits = waits.filter((wait) => wait.type === 'dependency')
  const rows: DependencyRow[] = Array.from(new Set(dependsOn)).map((id) => ({
    id,
    wait: dependencyWaits.find((wait) => wait.referenceId === id),
  }))
  for (const wait of dependencyWaits)
    if (!rows.some((row) => row.wait === wait)) rows.push({ id: wait.referenceId, wait })
  if (!rows.length) return null
  // Blockers first, then the rest in declared order.
  rows.sort((a, b) => Number(!!b.wait) - Number(!!a.wait))
  return (
    <section aria-label="Dependencies">
      <h3 className="text-xs font-medium text-secondary">Dependencies</h3>
      <ul className="mt-1 space-y-1.5">
        {rows.map((row, index) => (
          <li
            key={row.wait?.id ?? row.id ?? index}
            data-blocking={row.wait ? true : undefined}
            className="min-w-0 text-sm"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <DependencyLink
                id={row.id}
                dependency={row.id ? streams.get(row.id) : undefined}
                onSelect={onSelectWorkStream}
              />
              {row.wait && (
                <span className="text-xs font-medium text-status-attention-700 dark:text-status-attention-300">
                  Blocking · <WaitAge wait={row.wait} />
                </span>
              )}
            </div>
            {row.wait?.message && (
              <div className="mt-0.5 pl-3.5 text-xs text-secondary">
                <MarkdownContent variant="document">{row.wait.message}</MarkdownContent>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** "● number · title  In Progress": opens the dependency (in place when the caller can switch streams). */
function DependencyLink({
  id,
  dependency,
  onSelect,
}: {
  id: string | null
  dependency?: WorkStream
  onSelect?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const done = dependency?.status === 'done'
  const state = dependency ? getWsDisplayState(dependency) : null
  const treatment = state ? webStatus(WORK_STREAM_STATUS_ROLE[state]) : webStatus('neutral')
  const statusLabel = dependency ? workStreamStatusLabel(dependency) : null
  const label = dependency?.title ?? id?.slice(0, 8) ?? 'dependency'
  const canOpen = !!id && (!!onSelect || !!dependency)
  return (
    <>
      <button
        type="button"
        aria-label={`Open dependency ${label}`}
        onClick={() => (onSelect ? onSelect(id!) : setOpen(true))}
        disabled={!canOpen}
        className={clsx(
          'ficus-button ficus-button-link inline-flex min-w-0 items-center gap-1.5 text-left disabled:text-secondary disabled:no-underline',
          done && 'opacity-70'
        )}
      >
        {done ? (
          <span aria-label="Done status" className="inline-flex shrink-0 text-status-success-fg">
            <CheckIcon className="h-3 w-3" />
          </span>
        ) : (
          <span
            aria-label={statusLabel ? `${statusLabel} status` : 'Unknown status'}
            className={clsx('h-2 w-2 shrink-0 rounded-full', treatment.markerClass)}
          />
        )}
        {dependency ? (
          <span className="min-w-0 break-words">{workStreamTitle(dependency)}</span>
        ) : (
          <span className="min-w-0">
            A dependency{id && <span className="ml-1 font-mono text-xs">{id.slice(0, 8)}</span>}
          </span>
        )}
      </button>
      {statusLabel && <span className={clsx('text-xs', done ? 'text-muted' : 'text-secondary')}>{statusLabel}</span>}
      {open && dependency && (
        <WorkStreamViewModal workStreamId={dependency.id} squadId={dependency.squadId} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

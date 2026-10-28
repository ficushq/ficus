import { useState } from 'react'
import clsx from 'clsx'
import {
  WORK_STREAM_STATUS_ROLE,
  workStreamTitle,
  type WorkStream,
  type WorkStreamDependencyEdge,
  type WorkStreamWait,
} from '@ficus/shared'
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
  edge?: WorkStreamDependencyEdge
}

/**
 * What an edge waits on and whether it is satisfied, in one line: "Waits until its pull request is
 * ready", or "Unlocked when its pull request was ready · built on work/a · delivery held until it
 * merges". Null when the server reported no per-edge state.
 */
export function dependencyConditionText(edge: WorkStreamDependencyEdge | undefined): string | null {
  if (!edge) return null
  const parts: string[] = []
  if (edge.condition === 'ready')
    parts.push(
      !edge.satisfied
        ? 'Waits until its pull request is ready'
        : edge.unlockedAt
          ? 'Unlocked when its pull request was ready'
          : 'Satisfied'
    )
  else parts.push(edge.satisfied ? 'Satisfied' : 'Waits until it is done')
  if (edge.stack)
    parts.push(
      edge.stack.mode === 'stacked'
        ? `built on ${edge.stack.branch}`
        : edge.stack.mode === 'included'
          ? `${edge.stack.branch} is contained in this branch’s base`
          : `merge ${edge.stack.branch} in by hand`
    )
  if (edge.holdsDelivery) parts.push('delivery held until it merges')
  return parts.join(' · ')
}

/**
 * Every stream this one depends on, once: its link, status dot and state. A dependency with an open
 * wait reads "Blocking · waiting 3m"; a finished one is muted with a check. Dependency waits that name
 * a stream outside `dependsOn` (or none) still get a row, so no wait goes unexplained.
 */
export function WorkStreamDependencies({
  dependsOn,
  dependencies,
  waits,
  streams,
  onSelectWorkStream,
}: {
  dependsOn: string[]
  /** Per-edge condition and state; older servers omit it. */
  dependencies?: WorkStreamDependencyEdge[]
  /** The stream's open waits; only dependency waits are used. */
  waits: WorkStreamWait[]
  streams: Map<string, WorkStream>
  onSelectWorkStream?: (id: string) => void
}) {
  const dependencyWaits = waits.filter((wait) => wait.type === 'dependency')
  const rows: DependencyRow[] = Array.from(new Set(dependsOn)).map((id) => ({
    id,
    wait: dependencyWaits.find((wait) => wait.referenceId === id),
    edge: dependencies?.find((edge) => edge.workStreamId === id),
  }))
  for (const wait of dependencyWaits)
    if (!rows.some((row) => row.wait === wait)) rows.push({ id: wait.referenceId, wait })
  if (!rows.length) return null
  // Blockers first, then the rest in declared order.
  rows.sort((a, b) => Number(!!b.wait) - Number(!!a.wait))
  return (
    <section aria-label="Dependencies">
      <h3 className="text-xs font-medium text-secondary">Dependencies</h3>
      <ul className="mt-1 space-y-3">
        {rows.map((row, index) => {
          const dependency = row.id ? streams.get(row.id) : undefined
          const statusLabel = dependency ? workStreamStatusLabel(dependency) : null
          const condition = dependencyConditionText(row.edge)
          return (
            <li
              key={row.wait?.id ?? row.id ?? index}
              data-blocking={row.wait ? true : undefined}
              className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-sm [overflow-wrap:anywhere]"
            >
              <DependencyLink id={row.id} dependency={dependency} onSelect={onSelectWorkStream} />
              {(statusLabel || row.wait) && (
                <div className="col-start-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  {statusLabel && (
                    <span className={dependency?.status === 'done' ? 'text-muted' : 'text-secondary'}>
                      {statusLabel}
                    </span>
                  )}
                  {row.wait && (
                    <span className="font-medium text-status-attention-700 dark:text-status-attention-300">
                      Blocking · <WaitAge wait={row.wait} />
                    </span>
                  )}
                </div>
              )}
              {condition && (
                <div
                  data-condition={row.edge!.condition}
                  data-satisfied={row.edge!.satisfied}
                  className={clsx(
                    'col-start-2 min-w-0 text-xs',
                    row.edge!.holdsDelivery
                      ? 'text-status-attention-700 dark:text-status-attention-300'
                      : 'text-secondary'
                  )}
                >
                  {condition}
                </div>
              )}
              {row.wait?.message && (
                <div className="col-start-2 min-w-0 text-xs text-secondary">
                  <MarkdownContent variant="document">{row.wait.message}</MarkdownContent>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Fixed marker gutter and a wrapping title; opens in place when the caller can switch streams. */
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
          'ficus-button ficus-button-link col-span-2 grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-1.5 text-left disabled:text-secondary disabled:no-underline',
          done && 'opacity-70'
        )}
      >
        {done ? (
          <span aria-label="Done status" className="mt-1 inline-flex justify-self-center text-status-success-fg">
            <CheckIcon className="h-3 w-3" />
          </span>
        ) : (
          <span
            aria-label={statusLabel ? `${statusLabel} status` : 'Unknown status'}
            className={clsx('mt-1.5 h-2 w-2 justify-self-center rounded-full', treatment.markerClass)}
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
      {open && dependency && (
        <WorkStreamViewModal workStreamId={dependency.id} squadId={dependency.squadId} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

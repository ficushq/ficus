import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { workStreamRef, workStreamTitle, type WorkStream } from '@ficus/shared'
import { Badge } from '../Badge'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { WorkStreamStatusMarker } from '../WorkStreamStatusMarker'
import {
  getWsDisplayState,
  workStreamStatusLabel,
  WS_STATUS_BADGE_COLORS,
} from '../../lib/workStreamStatusPresentation'
import { orderSquadCardWork, SQUAD_CARD_WORK_LIMIT } from './squadCardWorkOrder'

/**
 * The squad card's work rows. The card itself opens the squad through a link stretched
 * over it, so every link here sits above that layer (`relative z-10`).
 *
 * `needsViewer` is null until both the streams and the viewer's pending actions have
 * loaded. The rows wait as placeholders until then: shown earlier, they would sit in
 * activity order and jump once the streams that need the viewer moved to the top.
 * Once the streams have loaded (`workStreamsLoaded`), a squad with at most one active
 * stream has nothing to reorder, so it shows its final content without waiting. The
 * placeholders hold the "+N more" line too, so the card keeps its height when the
 * rows arrive.
 */
export function SquadCardWork({
  squadName,
  squadSlug,
  workStreams,
  workStreamsLoaded,
  needsViewer,
}: {
  squadName: string
  squadSlug: string
  workStreams: readonly WorkStream[]
  workStreamsLoaded: boolean
  needsViewer: ReadonlySet<string> | null
}) {
  const ordered = orderSquadCardWork(workStreams, needsViewer ?? new Set())
  const shown = ordered.slice(0, SQUAD_CARD_WORK_LIMIT)
  const more = ordered.length - shown.length
  if (needsViewer === null && (!workStreamsLoaded || ordered.length > 1)) {
    return (
      <LoadingSurface label={`Loading ${squadName} active work`} className="mb-3 -mx-2">
        <div className="flex flex-col">
          <SkeletonRows count={Math.max(1, shown.length)}>
            {(index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-2 py-1.5"
                data-testid="squad-card-work-placeholder"
              >
                <SkeletonBlock className="h-3 w-3 shrink-0 rounded-full" />
                <SkeletonLine className="flex-1" />
                <SkeletonBlock className="h-5 w-14 shrink-0 rounded-full" />
              </div>
            )}
          </SkeletonRows>
        </div>
        {more > 0 && (
          <SquadCardMoreLine>
            <SkeletonBlock className="ml-2 h-4 w-14 rounded" />
          </SquadCardMoreLine>
        )}
      </LoadingSurface>
    )
  }
  if (ordered.length === 0) {
    return <p className="mb-3 text-sm text-muted">No active work</p>
  }
  return (
    <div className="mb-3 -mx-2">
      <ul aria-label={`${squadName} active work`} className="flex flex-col">
        {shown.map((workStream) => (
          <li key={workStream.id}>
            <SquadCardWorkRow workStream={workStream} squadSlug={squadSlug} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <SquadCardMoreLine>
          <Link
            to={`/squads/${squadSlug}/work`}
            className="relative z-10 ml-2 rounded text-xs text-secondary hover:text-link-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`${more} more active work ${more === 1 ? 'stream' : 'streams'} in ${squadName}`}
          >
            +{more} more
          </Link>
        </SquadCardMoreLine>
      )}
    </div>
  )
}

/**
 * The "+N more" line, and its placeholder: a flex line one `text-xs` line tall, so the
 * placeholder and the link take the same height whatever the card's own font size.
 */
function SquadCardMoreLine({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex h-4 items-center">{children}</div>
}

function SquadCardWorkRow({ workStream, squadSlug }: { workStream: WorkStream; squadSlug: string }) {
  const state = getWsDisplayState(workStream)
  const label = workStreamStatusLabel(workStream)
  const title = workStreamTitle(workStream)
  return (
    <Link
      to={`/squads/${squadSlug}/work?ws=${encodeURIComponent(workStreamRef(workStream))}`}
      className="relative z-10 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      title={title}
      data-testid="squad-card-work-row"
    >
      {/* The same status marker as every work stream row; the badge carries the words. */}
      <WorkStreamStatusMarker workStream={workStream} />
      <span className="min-w-0 flex-1 truncate text-sm text-primary">{title}</span>
      <Badge color={WS_STATUS_BADGE_COLORS[state]} className="shrink-0">
        {label}
      </Badge>
    </Link>
  )
}

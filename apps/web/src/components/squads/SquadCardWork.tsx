import { Link } from 'react-router'
import { workStreamRef, workStreamTitle, type WorkStream } from '@ficus/shared'
import { Badge } from '../Badge'
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
 */
export function SquadCardWork({
  squadName,
  squadSlug,
  workStreams,
  needsViewer,
}: {
  squadName: string
  squadSlug: string
  workStreams: readonly WorkStream[]
  needsViewer: ReadonlySet<string>
}) {
  const ordered = orderSquadCardWork(workStreams, needsViewer)
  if (ordered.length === 0) {
    return <p className="mb-3 text-sm text-muted">No active work</p>
  }
  const shown = ordered.slice(0, SQUAD_CARD_WORK_LIMIT)
  const more = ordered.length - shown.length
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
        <Link
          to={`/squads/${squadSlug}/work`}
          className="relative z-10 ml-2 mt-1 inline-block rounded text-xs text-secondary hover:text-link-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`${more} more active work ${more === 1 ? 'stream' : 'streams'} in ${squadName}`}
        >
          +{more} more
        </Link>
      )}
    </div>
  )
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

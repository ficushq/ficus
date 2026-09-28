import type { WorkStreamPresentationFacts } from '@ficus/shared'
import { Badge } from './Badge'
import {
  getWsDisplayState,
  isWorkStreamParked,
  workStreamStatusLabel,
  WS_STATUS_BADGE_COLORS,
} from '../lib/workStreamStatusPresentation'

/** The reason for waiting and admission state are independent facts. */
export function WorkStreamStatusBadges({
  workStream,
  showPrimary = true,
  showQueuePosition = false,
}: {
  workStream: WorkStreamPresentationFacts & { queuePosition?: number | null }
  showPrimary?: boolean
  showQueuePosition?: boolean
}) {
  const state = getWsDisplayState(workStream)
  const parked = isWorkStreamParked(workStream)
  if (!showPrimary && !parked) return null
  const label =
    showQueuePosition && state === 'queued' && workStream.queuePosition != null
      ? `${workStreamStatusLabel(workStream)} — position ${workStream.queuePosition}`
      : workStreamStatusLabel(workStream)
  const title =
    !showQueuePosition && workStream.status === 'queued' && workStream.queuePosition != null
      ? `${label} (${workStream.queuePosition})`
      : label
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 min-w-0">
      {showPrimary && (
        <Badge color={WS_STATUS_BADGE_COLORS[state]} title={title}>
          {label}
        </Badge>
      )}
      {parked && (
        <Badge
          color="neutral"
          title="This work stream has released its squad concurrency slot. It can run again once its blockers or pause are cleared and capacity is available."
        >
          Parked
        </Badge>
      )}
    </span>
  )
}

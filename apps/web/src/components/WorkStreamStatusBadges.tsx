import {
  workStreamQueuedReviewLabel,
  workStreamSecondaryDeliveryLabel,
  type WorkStreamPresentationFacts,
} from '@ficus/shared'
import clsx from 'clsx'
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
  className,
}: {
  workStream: WorkStreamPresentationFacts & { queuePosition?: number | null }
  showPrimary?: boolean
  showQueuePosition?: boolean
  className?: string
}) {
  const state = getWsDisplayState(workStream)
  const parked = isWorkStreamParked(workStream)
  const secondaryDelivery = workStreamSecondaryDeliveryLabel(workStream)
  const queuedReview = workStreamQueuedReviewLabel(workStream)
  if (!showPrimary && !parked && !secondaryDelivery && !queuedReview) return null
  const label =
    showQueuePosition && state === 'queued' && workStream.queuePosition != null
      ? `${workStreamStatusLabel(workStream)} — position ${workStream.queuePosition}`
      : workStreamStatusLabel(workStream)
  const title =
    !showQueuePosition && workStream.status === 'queued' && workStream.queuePosition != null
      ? `${label} (${workStream.queuePosition})`
      : label
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1.5 min-w-0', className)}>
      {showPrimary && (
        <Badge color={WS_STATUS_BADGE_COLORS[state]} title={title}>
          {label}
        </Badge>
      )}
      {queuedReview && <span className="text-xs text-secondary">{queuedReview}</span>}
      {secondaryDelivery && (
        <span className="text-xs text-secondary" title={`Delivery: ${secondaryDelivery}`}>
          <span className="sr-only">Delivery: </span>
          {secondaryDelivery}
        </span>
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

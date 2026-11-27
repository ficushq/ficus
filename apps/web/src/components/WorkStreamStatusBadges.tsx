import { workStreamQueuedReviewLabel, type WorkStreamPresentationFacts } from '@ficus/shared'
import clsx from 'clsx'
import { Badge } from './Badge'
import { liveEmphasisProps } from '../lib/liveListMotion'
import {
  getWsDisplayState,
  isWorkStreamParked,
  workStreamDeliveryTag,
  workStreamStatusLabel,
  WS_STATUS_BADGE_COLORS,
} from '../lib/workStreamStatusPresentation'

/**
 * How the secondary delivery label renders: muted `text` where the surrounding line is text
 * (board cards, the mobile details line), a colored `pill` among other pills, or `none` when
 * the caller attaches it to the delivery pull request instead.
 */
export type WorkStreamDeliveryLabelMode = 'text' | 'pill' | 'none'

/** The reason for waiting and admission state are independent facts. */
export function WorkStreamStatusBadges({
  workStream,
  showPrimary = true,
  showQueuePosition = false,
  deliveryLabel = 'text',
  showQueuedReview = true,
  className,
  liveEmphasis = false,
}: {
  workStream: WorkStreamPresentationFacts & { queuePosition?: number | null }
  showPrimary?: boolean
  showQueuePosition?: boolean
  deliveryLabel?: WorkStreamDeliveryLabelMode
  /** Pill rows leave "Review queued" to the peek card; text surfaces keep it. */
  showQueuedReview?: boolean
  className?: string
  /** The element a live list emphasizes when this stream's status changes (LiveListMotion). */
  liveEmphasis?: boolean
}) {
  const state = getWsDisplayState(workStream)
  const parked = isWorkStreamParked(workStream)
  const deliveryTag = deliveryLabel === 'none' ? null : workStreamDeliveryTag(workStream)
  const queuedReview = showQueuedReview ? workStreamQueuedReviewLabel(workStream) : null
  if (!showPrimary && !parked && !deliveryTag && !queuedReview) return null
  const label =
    showQueuePosition && state === 'queued' && workStream.queuePosition != null
      ? `${workStreamStatusLabel(workStream)} — position ${workStream.queuePosition}`
      : workStreamStatusLabel(workStream)
  const title =
    !showQueuePosition && workStream.status === 'queued' && workStream.queuePosition != null
      ? `${label} (${workStream.queuePosition})`
      : label
  return (
    <span
      className={clsx('inline-flex flex-wrap items-center gap-1.5 min-w-0', className)}
      {...(liveEmphasis ? liveEmphasisProps : {})}
    >
      {showPrimary && (
        <Badge color={WS_STATUS_BADGE_COLORS[state]} title={title}>
          {label}
        </Badge>
      )}
      {queuedReview && <span className="text-xs text-secondary">{queuedReview}</span>}
      {deliveryTag &&
        (deliveryLabel === 'pill' ? (
          <Badge color={deliveryTag.color} title={`Delivery: ${deliveryTag.label}`}>
            <span className="sr-only">Delivery: </span>
            {deliveryTag.label}
          </Badge>
        ) : (
          <span className="text-xs text-secondary" title={`Delivery: ${deliveryTag.label}`}>
            <span className="sr-only">Delivery: </span>
            {deliveryTag.label}
          </span>
        ))}
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

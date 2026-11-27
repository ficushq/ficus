import clsx from 'clsx'
import { WORK_STREAM_STATUS_ROLE, type WorkStreamPresentationFacts } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import { getWsDisplayState, workStreamStatusLabel } from '../lib/workStreamStatusPresentation'

/**
 * The status marker that leads every work stream row: a dot in the state's color. Every row that
 * draws it also shows the status badge with the same words, so the dot is hidden from assistive
 * technology (the badge is read once) and carries the words only as a hover title.
 */
export function WorkStreamStatusMarker({
  workStream,
  className,
}: {
  workStream: WorkStreamPresentationFacts
  className?: string
}) {
  const label = workStreamStatusLabel(workStream)
  const role = WORK_STREAM_STATUS_ROLE[getWsDisplayState(workStream)] ?? 'neutral'
  return (
    <span
      aria-hidden="true"
      title={label}
      data-testid="work-stream-status-marker"
      className={clsx('h-2 w-2 shrink-0 rounded-full', webStatus(role).markerClass, className)}
    />
  )
}

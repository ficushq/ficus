import clsx from 'clsx'
import { WORK_STREAM_STATUS_ROLE, type WorkStreamPresentationFacts } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import { getWsDisplayState, workStreamStatusLabel } from '../lib/workStreamStatusPresentation'

/**
 * The status marker that leads every work stream row: a dot in the state's color, labelled with the
 * same words as the row's status badge so color is never the only cue.
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
      role="img"
      aria-label={label}
      title={label}
      data-testid="work-stream-status-marker"
      className={clsx('h-2 w-2 shrink-0 rounded-full', webStatus(role).markerClass, className)}
    />
  )
}

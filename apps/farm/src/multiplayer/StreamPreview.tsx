import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { farmQueries } from '../api/queries'
import { agentLabel } from '../farm/agentLabels'
import type { FarmCardEnv } from '../farm/cards/context'
import { RobotAvatar } from '../farm/RobotAvatar'
import { plantStateLabel } from '../farm/selection'
import type { PlotLayout } from '../farm/types'

/** A stream that's no longer planted: where it ended up. */
function offFarm(stream: WorkStream): string {
  if (stream.status === 'done') return 'Harvested'
  if (stream.status === 'canceled') return 'Composted'
  return 'Not on the farm right now'
}

/**
 * What a work stream reference is about, since inline it's only a sprout and
 * a number: its title, how its plant is doing, its plot and who's tending it.
 * A tooltip (nothing in it to click) that opens under the reference, or above
 * it when there's no room below. Streams not on the farm are fetched.
 */
export function StreamPreview({
  id,
  anchor,
  refId,
  plot,
  known,
  env,
}: {
  id: string
  anchor: HTMLElement
  /** The reference's id: a number or a stream id. */
  refId: string
  plot: PlotLayout | undefined
  known: WorkStream | undefined
  env: FarmCardEnv
}) {
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const fetched = useQuery({ ...farmQueries.workStream(refId), enabled: !known, staleTime: 30_000, retry: false })
  const stream = known ?? fetched.data

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect()
    const box = card.current?.getBoundingClientRect()
    if (!box) return
    const below = rect.bottom + 6 + box.height <= window.innerHeight - 8
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
      top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - box.height),
    })
  }, [anchor, stream])

  const squad = stream ? env.squadsById.get(stream.squadId) : undefined
  const tender = plot?.tender?.agent
  const number = stream?.number ?? (/^\d+$/.test(refId) ? refId : undefined)

  return createPortal(
    <div
      ref={card}
      id={id}
      role="tooltip"
      className="g-card g-stream-preview"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
    >
      <p className="g-eyebrow">
        {[squad?.name, number ? `Work stream ${number}` : 'Work stream'].filter(Boolean).join(' · ')}
      </p>
      {stream ? (
        <>
          <p className="g-stream-preview-title">{stream.title}</p>
          <p className="g-crew-meta" data-needs={plot?.badge ? 'yes' : undefined}>
            {plot ? plantStateLabel(plot.state) : offFarm(stream)}
          </p>
          {tender && (
            <p className="g-stream-preview-tender">
              <RobotAvatar agent={tender} squad={squad} halted={env.halted.has(tender.id)} size={22} />
              <span>{agentLabel(tender).primary}</span>
              {plot && plot.extraTenders > 0 && <span className="g-crew-meta">+{plot.extraTenders}</span>}
            </p>
          )}
        </>
      ) : (
        <p className="g-crew-meta">{fetched.isError ? 'Couldn’t find this work stream.' : 'Looking it up…'}</p>
      )}
    </div>,
    anchor.closest('.g-farm') ?? document.body
  )
}

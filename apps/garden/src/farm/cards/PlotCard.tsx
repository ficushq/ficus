import type { WorkStream } from '@ficus/shared'
import { plantStateLabel } from '../selection'
import { deliveryNote } from '../delivery'
import { findPlot } from '../find'
import { Crew } from './Crew'
import { useFarmCard } from './context'
import { PlotActions } from './slots'

function participantIds(stream: WorkStream): string[] {
  const ids = new Set(stream.agentIds ?? [])
  if (stream.assigneeAgentId) ids.add(stream.assigneeAgentId)
  if (stream.ownerAgentId) ids.add(stream.ownerAgentId)
  return [...ids]
}

export function PlotCard({ streamId }: { streamId: string }) {
  const env = useFarmCard()
  const plot = findPlot(env.layout, streamId)
  if (!plot) return <p className="g-card-text">This plant has moved on.</p>
  const { stream } = plot
  const note = deliveryNote(stream.delivery?.explanation)
  const squad = env.squadsById.get(stream.squadId)
  return (
    <>
      <p className="g-eyebrow">{plot.squadName}</p>
      <h2 className="g-card-title">{stream.title}</h2>
      <p className="g-state-tag" data-state={plot.state}>
        {plantStateLabel(plot.state)}
      </p>
      {note && <p className="g-card-text g-delivery-note">{note}</p>}
      {stream.description && <p className="g-card-text g-clamp">{stream.description}</p>}
      <PlotActions stream={stream} />
      <h3 className="g-card-subtitle">Crew</h3>
      <Crew
        agentIds={participantIds(stream)}
        known={env.agentsById}
        squad={squad}
        halted={env.halted}
        onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
      />
    </>
  )
}

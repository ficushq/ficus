import type { WorkStream } from '@ficus/shared'
import { plantStateLabel } from '../selection'
import { deliveryNote } from '../delivery'
import { findPlot } from '../find'
import { Crew } from './Crew'
import { useFarmCard } from './context'
import { PlotActions } from './slots'
import { workStreamPullRequests } from '../pullRequests'
import { PullRequestIcon } from '../../icons'

/**
 * Who's on a plant's crew: everyone who worked on it, plus its owner and
 * creator when those aren't the squad's manager (usually they are, which says
 * nothing new). Owner and creator are labelled, and merged when the same agent.
 */
export function crewFor(
  stream: Pick<WorkStream, 'agentIds' | 'assigneeAgentId' | 'ownerAgentId' | 'creatorAgentId'>,
  isManager: (agentId: string) => boolean
): { ids: string[]; notes: Record<string, string> } {
  const ids = new Set(stream.agentIds ?? [])
  if (stream.assigneeAgentId) ids.add(stream.assigneeAgentId)
  const notes: Record<string, string> = {}
  const tag = (id: string | null, label: string) => {
    if (!id || isManager(id)) return
    ids.add(id)
    notes[id] = notes[id] ? `${notes[id]} · ${label.toLowerCase()}` : label
  }
  tag(stream.ownerAgentId, 'Owner')
  tag(stream.creatorAgentId, 'Creator')
  return { ids: [...ids], notes }
}

export function PlotCard({ streamId }: { streamId: string }) {
  const env = useFarmCard()
  const plot = findPlot(env.layout, streamId)
  if (!plot) return <p className="g-card-text">This plant has moved on.</p>
  const { stream } = plot
  const note = deliveryNote(stream.delivery?.explanation)
  const pullRequests = workStreamPullRequests(stream.metadata ?? {})
  const squad = env.squadsById.get(stream.squadId)
  const crew = crewFor(
    stream,
    (id) => id === squad?.managerAgentId || env.agentsById.get(id)?.agentTypeId === 'manager'
  )
  return (
    <>
      <p className="g-eyebrow">{plot.squadName}</p>
      <h2 className="g-card-title">{stream.title}</h2>
      <p className="g-state-tag" data-state={plot.state}>
        {plantStateLabel(plot.state)}
      </p>
      {note && <p className="g-card-text g-delivery-note">{note}</p>}
      {pullRequests.length > 0 && (
        <p className="g-pr-links">
          {pullRequests.map((pr) =>
            pr.url ? (
              <a key={pr.key} className="g-pr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                <PullRequestIcon />
                Pull request #{pr.number}
              </a>
            ) : (
              <span key={pr.key} className="g-pr-link">
                <PullRequestIcon />
                Pull request #{pr.number}
              </span>
            )
          )}
        </p>
      )}
      {stream.description && <p className="g-card-text g-clamp">{stream.description}</p>}
      <PlotActions stream={stream} />
      <h3 className="g-card-subtitle">Crew</h3>
      <Crew
        agentIds={crew.ids}
        notes={crew.notes}
        known={env.agentsById}
        squad={squad}
        halted={env.halted}
        onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
      />
    </>
  )
}

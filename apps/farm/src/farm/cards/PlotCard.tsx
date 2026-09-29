import type { WorkStream } from '@ficus/shared'
import { plantStateLabel } from '../selection'
import { deliveryNote } from '../delivery'
import { findPlot } from '../find'
import { Crew, statusTone } from './Crew'
import { useFarmCard } from './context'
import { PlotActions } from './slots'
import { workStreamPullRequests } from '../pullRequests'
import { PullRequestIcon } from '../../icons'
import { farmRefText } from '../../multiplayer/messageTokens'

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
  // Who's on it: the assignee, else the robot tending the plant.
  const lead = stream.assigneeAgentId ?? plot.tender?.agent.id ?? null
  const leadAgent = lead ? env.agentsById.get(lead) : undefined
  const rest = crew.ids.filter((id) => id !== lead)
  const openAgent = (id: string) => env.select({ kind: 'robot', agentId: id })
  return (
    <>
      <p className="g-eyebrow">{plot.squadName}</p>
      <h2 className="g-card-title">{stream.title}</h2>
      <p className="g-state-tag" data-state={plot.state}>
        {plantStateLabel(plot.state)}
      </p>
      <section className="g-plot-lead" aria-label="Who's on it">
        <h3 className="g-plot-lead-label">
          {leadAgent && statusTone(leadAgent.status, env.halted.has(leadAgent.id)) === 'working'
            ? 'Working on it'
            : 'Assigned to'}
        </h3>
        {lead ? (
          <Crew
            agentIds={[lead]}
            notes={crew.notes}
            omit={stream.title}
            known={env.agentsById}
            squad={squad}
            halted={env.halted}
            onOpenAgent={openAgent}
          />
        ) : (
          <p className="g-card-text">Nobody yet.</p>
        )}
      </section>
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
      <button
        type="button"
        className="g-link g-share"
        onClick={() => env.shareInChat(farmRefText({ kind: 'ws', id: String(stream.number ?? stream.id) }))}
      >
        Share in farm chat
      </button>
      <PlotActions stream={stream} />
      {rest.length > 0 && (
        <>
          <h3 className="g-card-subtitle">{lead ? 'Also on the crew' : 'Crew'}</h3>
          <Crew
            agentIds={rest}
            notes={crew.notes}
            omit={stream.title}
            known={env.agentsById}
            squad={squad}
            halted={env.halted}
            onOpenAgent={openAgent}
          />
        </>
      )}
    </>
  )
}

import { useQueries } from '@tanstack/react-query'
import type { Agent, Squad } from '@ficus/shared'
import { farmQueries } from '../../api/queries'
import { AGENT_STATUS_LABELS, agentLabel } from '../agentLabels'
import { RobotAvatar } from '../RobotAvatar'

/**
 * Every agent that has worked on something, live or finished, with its face.
 * Agents missing from the live roster (finished ones) are fetched by id.
 */
export function Crew({
  agentIds,
  known,
  squad,
  halted,
  onOpenAgent,
  empty = 'Nobody has worked on this yet.',
  notes = {},
  onTalk,
}: {
  agentIds: string[]
  /** A short label per agent, e.g. "Owner", shown before its status. */
  notes?: Record<string, string>
  /** Adds a Talk button to each row. */
  onTalk?: (agentId: string) => void
  known: ReadonlyMap<string, Agent>
  squad?: Squad
  halted: ReadonlySet<string>
  onOpenAgent: (agentId: string) => void
  empty?: string
}) {
  const missing = agentIds.filter((id) => !known.has(id))
  const fetched = useQueries({ queries: missing.map((id) => ({ ...farmQueries.agent(id), staleTime: 60_000 })) })
  const byId = new Map(known)
  for (const q of fetched) if (q.data) byId.set(q.data.id, q.data)
  const agents = agentIds.map((id) => byId.get(id)).filter((a): a is Agent => !!a)

  if (!agentIds.length) return <p className="g-card-text">{empty}</p>
  return (
    <ul className="g-crew">
      {agents.map((agent) => {
        const label = agentLabel(agent)
        const isHalted = halted.has(agent.id)
        return (
          <li key={agent.id}>
            <div className="g-crew-line">
              <button type="button" className="g-crew-row" onClick={() => onOpenAgent(agent.id)}>
                <RobotAvatar agent={agent} squad={squad} halted={isHalted} size={38} />
                <span className="g-crew-text">
                  <span className="g-crew-name">{label.primary}</span>
                  <span className="g-crew-meta">
                    {notes[agent.id] ? `${notes[agent.id]} · ` : ''}
                    {label.secondary ? `${label.secondary} · ` : ''}
                    {isHalted ? 'Halted' : AGENT_STATUS_LABELS[agent.status]}
                  </span>
                </span>
              </button>
              {onTalk && (
                <button type="button" className="g-crew-talk" onClick={() => onTalk(agent.id)}>
                  Talk
                </button>
              )}
            </div>
          </li>
        )
      })}
      {agents.length < agentIds.length && <li className="g-crew-meta">Finding the rest of the crew…</li>}
    </ul>
  )
}

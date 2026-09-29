import { useQueries } from '@tanstack/react-query'
import type { Agent, AgentStatus, Squad } from '@ficus/shared'
import { farmQueries } from '../../api/queries'
import { AGENT_STATUS_LABELS, agentLabel } from '../agentLabels'
import { RobotAvatar } from '../RobotAvatar'

/** How an agent's status reads at a glance: at work, needing you, stopped by an error, or resting. */
export function statusTone(status: AgentStatus, halted: boolean): 'working' | 'needs' | 'halted' | 'quiet' {
  if (halted) return 'halted'
  if (status === 'waiting-input') return 'needs'
  if (status === 'active' || status === 'compacting') return 'working'
  return 'quiet'
}

/** An agent's status as a pill, coloured by its tone. */
export function StatusPill({ agent, halted }: { agent: Agent; halted: boolean }) {
  return (
    <span className="g-status-pill" data-tone={statusTone(agent.status, halted)}>
      {halted ? 'Halted' : AGENT_STATUS_LABELS[agent.status]}
    </span>
  )
}

/**
 * Every agent that has worked on something, live or finished, with its face
 * and its status as a pill. Agents missing from the live roster (finished
 * ones) are fetched by id.
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
  omit,
}: {
  agentIds: string[]
  /** Text to leave out of names, e.g. the work stream's own title when they're listed on it. */
  omit?: string
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
        const primary = withoutText(label.primary, omit) ?? label.primary
        const secondary = withoutText(label.secondary, omit)
        return (
          <li key={agent.id}>
            <div className="g-crew-line">
              <button type="button" className="g-crew-row" onClick={() => onOpenAgent(agent.id)}>
                <RobotAvatar agent={agent} squad={squad} halted={isHalted} size={38} />
                <span className="g-crew-text">
                  <span className="g-crew-name">{primary}</span>
                  <span className="g-crew-meta">
                    <StatusPill agent={agent} halted={isHalted} />
                    {[notes[agent.id], secondary].filter(Boolean).join(' · ')}
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

/** A name without `text` in it (and the " · " that joined them), or undefined if nothing's left. */
function withoutText(name: string | undefined, text: string | undefined): string | undefined {
  if (!name || !text) return name
  const rest = name
    .split(' · ')
    .filter((part) => part.trim() !== text.trim())
    .join(' · ')
    .trim()
  return rest || undefined
}

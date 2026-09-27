import { useQuery } from '@tanstack/react-query'
import { gardenQueries } from '../../api/queries'
import { AGENT_STATUS_LABELS, agentLabel } from '../agentLabels'
import { findRobot } from '../find'
import { RobotAvatar } from '../RobotAvatar'
import { roleFor } from '../appearance'
import { roleLabel } from '../selection'
import { useFarmCard } from './context'
import { RobotActions } from './slots'
import { AssistantCard } from './AssistantCard'
import { PORCH_ASSISTANT_ID } from '../useFarmData'

export function RobotCard({ agentId }: { agentId: string }) {
  const env = useFarmCard()
  const placed = findRobot(env.layout, agentId)
  const known = env.agentsById.get(agentId)
  // Robots reached from a crew list or roster may not be on the field (finished, asleep).
  const detail = useQuery({
    ...gardenQueries.agent(agentId),
    enabled: !placed && !known && agentId !== PORCH_ASSISTANT_ID,
  })
  const agent = placed?.agent ?? known ?? detail.data
  if (!agent)
    return <p className="g-card-text">{detail.isError ? "Couldn't find this robot." : 'Finding this robot…'}</p>

  const squad = agent.squadId ? env.squadsById.get(agent.squadId) : undefined
  const role =
    placed?.role ?? (env.input.assistants.some((a) => a.id === agentId) ? 'assistant' : roleFor(agent, squad))
  if (role === 'assistant') return <AssistantCard />
  const label = agentLabel(agent)
  const halted = env.halted.has(agentId)
  const working = env.layout.yards
    .flatMap((y) => y.plots)
    .filter((p) => p.tender?.agent.id === agentId || (p.stream.agentIds ?? []).includes(agentId))

  return (
    <>
      <div className="g-card-head">
        <RobotAvatar agent={agent} squad={squad} role={role} halted={halted} size={56} />
        <div>
          <p className="g-eyebrow">
            {roleLabel(role)}
            {squad ? ` · ${squad.name}` : ''}
          </p>
          <h2 className="g-card-title">{label.primary}</h2>
        </div>
      </div>
      {label.secondary && <p className="g-card-text">{label.secondary}</p>}
      <p className="g-state-tag">{halted ? 'Halted — needs a nudge' : AGENT_STATUS_LABELS[agent.status]}</p>
      <RobotActions agentId={agentId} />
      <button type="button" className="g-button g-button-primary g-card-wide" onClick={() => env.openChat(agentId)}>
        {role === 'manager' ? 'Talk to farmer' : 'Talk to robot'}
      </button>
      {working.length > 0 && (
        <>
          <h3 className="g-card-subtitle">Tending</h3>
          <ul className="g-link-list">
            {working.map((p) => (
              <li key={p.stream.id}>
                <button
                  type="button"
                  className="g-link"
                  onClick={() => env.select({ kind: 'plot', streamId: p.stream.id })}
                >
                  {p.stream.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

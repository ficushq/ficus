import { useQuery } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { gardenQueries } from '../../api/queries'
import { roleFor } from '../appearance'
import { Crew } from './Crew'
import { useFarmCard } from './context'

const ROLE_ORDER = { manager: 0, consultant: 1, worker: 2, assistant: 3 } as const

/** The squad's plot sign: who's here (including robots that already finished) and ways in. */
export function YardCard({ squadId }: { squadId: string }) {
  const env = useFarmCard()
  const yard = env.layout.yards.find((y) => y.squad.id === squadId)
  const roster = useQuery(gardenQueries.squadRoster(squadId))
  if (!yard) return <p className="g-card-text">This plot is gone.</p>
  const { squad } = yard

  const live = roster.data?.agents ?? env.input.agents.filter((a) => a.squadId === squadId)
  const finished = roster.data?.recentlyTerminated ?? []
  const known = new Map<string, Agent>([...live, ...finished].map((a) => [a.id, a]))
  const order = (a: Agent) => ROLE_ORDER[roleFor(a, squad)]
  const current = [...live].filter((a) => !a.parentAgentId).sort((a, b) => order(a) - order(b))
  const farmer = yard.farmer?.agent ?? current.find((a) => roleFor(a, squad) === 'manager')

  return (
    <>
      <p className="g-eyebrow">Squad plot</p>
      <h2 className="g-card-title">{squad.name}</h2>
      <p className="g-card-text">
        {yard.plots.length} growing{yard.needsYou ? ` · ${yard.needsYou} need you` : ''}
      </p>
      <div className="g-card-actions">
        {farmer && (
          <button type="button" className="g-button g-button-primary" onClick={() => env.openChat(farmer.id)}>
            Talk to the farmer
          </button>
        )}
        <button type="button" className="g-button" onClick={() => env.startConsultant(squadId)}>
          Plant a seed
        </button>
      </div>
      <h3 className="g-card-subtitle">Robots</h3>
      <Crew
        agentIds={current.map((a) => a.id)}
        known={known}
        squad={squad}
        halted={env.halted}
        onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
        empty="No robots here yet."
      />
      {finished.length > 0 && (
        <details className="g-disclosure">
          <summary>Recently finished ({finished.length})</summary>
          <Crew
            agentIds={finished.map((a) => a.id)}
            known={known}
            squad={squad}
            halted={env.halted}
            onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
          />
        </details>
      )}
    </>
  )
}

import { Crew } from './Crew'
import { useFarmCard } from './context'

/** A yard's charging hut: every idle robot resting there, each a click away from a chat. */
export function HutCard({ squadId }: { squadId: string }) {
  const env = useFarmCard()
  const yard = env.layout.yards.find((y) => y.squad.id === squadId)
  if (!yard) return <p className="g-card-text">This hut is gone.</p>
  const ids = yard.dock.ids ?? []
  return (
    <>
      <p className="g-eyebrow">{yard.squad.name} · charging hut</p>
      <h2 className="g-card-title">
        {ids.length ? `${ids.length} robot${ids.length === 1 ? '' : 's'} resting` : 'Nobody is resting'}
      </h2>
      <p className="g-card-text">Idle robots recharge here until there's work for them.</p>
      {ids.length > 0 && (
        <Crew
          agentIds={ids}
          known={env.agentsById}
          squad={yard.squad}
          halted={env.halted}
          onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
          onTalk={env.openChat}
        />
      )}
    </>
  )
}

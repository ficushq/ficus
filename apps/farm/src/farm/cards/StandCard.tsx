import { Crew } from './Crew'
import { useFarmCard } from './context'

/** A squad's consulting stand: the consultant chats people started here, and a way to start another. */
export function StandCard({ squadId }: { squadId: string }) {
  const env = useFarmCard()
  const yard = env.layout.yards.find((y) => y.squad.id === squadId)
  if (!yard) return <p className="g-card-text">This stand is gone.</p>
  const ids = yard.stand.ids ?? []
  return (
    <>
      <p className="g-eyebrow">{yard.squad.name} · consulting stand</p>
      <h2 className="g-card-title">
        {ids.length ? `${ids.length} consultant chat${ids.length === 1 ? '' : 's'}` : 'No consultant chats yet'}
      </h2>
      <p className="g-card-text">Talk an idea or question through with a consultant before it becomes work.</p>
      <button
        type="button"
        className="g-button g-button-primary g-card-wide"
        onClick={() => env.startConsultant(squadId)}
      >
        New consultant
      </button>
      {ids.length > 0 && (
        <>
          {/* Every chat the stand counts, questions for you first, then most recently active. */}
          <h3 className="g-card-subtitle">Recent</h3>
          <Crew
            agentIds={ids}
            known={env.agentsById}
            squad={yard.squad}
            halted={env.halted}
            onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
            onTalk={env.openChat}
            notes={Object.fromEntries((yard.stand.asking ?? []).map((id) => [id, 'Has a question for you']))}
          />
        </>
      )}
    </>
  )
}

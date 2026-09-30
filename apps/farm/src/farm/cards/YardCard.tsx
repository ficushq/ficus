import { plantStateLabel } from '../selection'
import { useFarmCard } from './context'

/** A squad's plot sign: its active work streams, and the ways in (farmer, consultants, resting robots). */
export function YardCard({ squadId }: { squadId: string }) {
  const env = useFarmCard()
  const yard = env.layout.yards.find((y) => y.squad.id === squadId)
  if (!yard) return <p className="g-card-text">This plot is gone.</p>
  const { squad, plots } = yard
  const consultants = yard.stand.ids?.length ?? 0
  const resting = yard.dock.ids?.length ?? 0
  // What needs you first, then the rest in planting order.
  const ordered = [...plots].sort((a, b) => Number(!!b.badge) - Number(!!a.badge))

  return (
    <>
      <p className="g-eyebrow">Squad plot</p>
      <h2 className="g-card-title">{squad.name}</h2>
      <p className="g-card-text">
        {plots.length} growing{yard.needsYou ? ` · ${yard.needsYou} need you` : ''}
      </p>
      <div className="g-card-actions">
        {yard.farmer && (
          <button
            type="button"
            className="g-button g-button-primary"
            onClick={() => env.openChat(yard.farmer!.agent.id)}
          >
            Talk to farmer
          </button>
        )}
        <button type="button" className="g-button" onClick={() => env.startConsultant(squadId)}>
          Plant a seed
        </button>
        <button type="button" className="g-button" onClick={() => env.openFieldLog(squadId)}>
          Watch the field
        </button>
      </div>

      <h3 className="g-card-subtitle">Work streams</h3>
      {ordered.length === 0 ? (
        <p className="g-card-text">Nothing growing right now.</p>
      ) : (
        <ul className="g-link-list">
          {ordered.map((p) => (
            <li key={p.stream.id}>
              <button
                type="button"
                className="g-list-row"
                onClick={() => env.select({ kind: 'plot', streamId: p.stream.id })}
              >
                <span className="g-list-title">{p.stream.title}</span>
                <span className="g-crew-meta" data-needs={p.badge ? 'yes' : undefined}>
                  {plantStateLabel(p.state)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="g-link-list g-yard-places">
        <li>
          <button type="button" className="g-link" onClick={() => env.select({ kind: 'stand', squadId })}>
            Consulting stand{consultants ? ` · ${consultants} chat${consultants === 1 ? '' : 's'}` : ''}
          </button>
        </li>
        <li>
          <button type="button" className="g-link" onClick={() => env.select({ kind: 'hut', squadId })}>
            Charging hut{resting ? ` · ${resting} resting` : ''}
          </button>
        </li>
      </ul>
    </>
  )
}

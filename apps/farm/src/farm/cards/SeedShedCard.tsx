import { SeedPacketIcon } from '../../icons'
import { useFarmCard } from './context'

/** Seed packets start a conversation with a new consultant for the chosen plot. */
export function SeedShedCard() {
  const env = useFarmCard()
  return (
    <>
      <p className="g-eyebrow">Seed shed</p>
      <h2 className="g-card-title">What shall we grow?</h2>
      <p className="g-card-text">Pick a plot. A consultant will come over and talk it through with you.</p>
      <ul className="g-seed-list">
        {env.layout.yards.map((yard) => (
          <li key={yard.squad.id}>
            <button type="button" className="g-seed" onClick={() => env.startConsultant(yard.squad.id)}>
              <SeedPacketIcon />
              <span>{yard.squad.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

import { agentLabel } from '../agentLabels'
import { RobotAvatar } from '../RobotAvatar'
import { plantStateLabel } from '../selection'
import type { RobotPlacement, YardLayout } from '../types'
import { useFarmCard } from './context'

/** Everyone out on a plot: its farmer, the robots tending its plants, and its consultants (each once). */
function robotsOf(yard: YardLayout): RobotPlacement[] {
  const all = [
    ...(yard.farmer ? [yard.farmer] : []),
    ...yard.plots.flatMap((p) => p.tender ?? []),
    ...yard.stand.robots,
  ]
  return all.filter((r, n) => all.findIndex((other) => other.agent.id === r.agent.id) === n)
}

/**
 * The whole farm at a glance (from the growing counter or the farmhouse):
 * every plot with what's growing in it, what needs you first, and the faces
 * of the robots out there. Also a plain way around for screen readers and
 * keyboards.
 */
export function OverviewCard() {
  const env = useFarmCard()
  const { yards } = env.layout
  const growing = yards.reduce((n, y) => n + y.plots.length, 0)
  const needsYou = yards.reduce((n, y) => n + y.needsYou, 0)

  return (
    <>
      <p className="g-eyebrow">The whole farm</p>
      <h2 className="g-card-title">Everything growing</h2>
      <p className="g-card-text">
        {growing} growing in {yards.length} plot{yards.length === 1 ? '' : 's'}
        {needsYou ? ` · ${needsYou} need you` : ''}
      </p>
      {yards.length === 0 && <p className="g-card-text">No plots yet.</p>}
      {yards.map((yard) => {
        const robots = robotsOf(yard)
        // What needs you first, then the rest in planting order.
        const plots = [...yard.plots].sort((a, b) => Number(!!b.badge) - Number(!!a.badge))
        return (
          <section key={yard.squad.id} className="g-overview-plot" aria-label={yard.squad.name}>
            <button
              type="button"
              className="g-overview-head"
              onClick={() => env.select({ kind: 'yard', squadId: yard.squad.id })}
            >
              <span className="g-overview-name">{yard.squad.name}</span>
              <span className="g-crew-meta" data-needs={yard.needsYou ? 'yes' : undefined}>
                {yard.needsYou ? `${yard.needsYou} need you` : `${yard.plots.length} growing`}
              </span>
            </button>
            {plots.length === 0 ? (
              <p className="g-overview-empty">Nothing growing right now.</p>
            ) : (
              <ul className="g-link-list">
                {plots.map((p) => (
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
            {robots.length > 0 && (
              <ul className="g-overview-robots" aria-label="Robots">
                {robots.map((r) => {
                  const name = agentLabel(r.agent).primary
                  return (
                    <li key={r.agent.id}>
                      <button
                        type="button"
                        className="g-overview-robot"
                        aria-label={name}
                        title={name}
                        onClick={() => env.select({ kind: 'robot', agentId: r.agent.id })}
                      >
                        <RobotAvatar agent={r.agent} squad={yard.squad} halted={env.halted.has(r.agent.id)} size={30} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </>
  )
}

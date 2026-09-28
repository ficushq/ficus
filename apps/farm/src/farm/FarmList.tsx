import { useEffect, useRef } from 'react'
import { plantStateLabel } from './selection'
import { agentLabel } from './agentLabels'
import type { FarmLayout, RobotPlacement } from './types'
import type { Selection } from './selection'
import { CloseIcon } from '../icons'

/**
 * The whole farm as a plain list: a quick overview, and a straightforward way
 * around for screen readers and keyboards.
 */
export function FarmList({
  layout,
  onSelect,
  onClose,
}: {
  layout: FarmLayout
  onSelect: (s: Selection) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const go = (s: Selection) => {
    onSelect(s)
    onClose()
  }
  const robotsOf = (y: FarmLayout['yards'][number]): RobotPlacement[] => [
    ...(y.farmer ? [y.farmer] : []),
    ...y.plots.flatMap((p) => (p.tender ? [p.tender] : [])),
    ...y.stand.robots,
  ]

  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="g-card g-farm-list"
      aria-label="Farm list"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <button type="button" className="g-card-close" aria-label="Close list" onClick={onClose}>
        <CloseIcon />
      </button>
      <p className="g-eyebrow">The whole farm</p>
      <h2 className="g-card-title">Everything growing</h2>
      {layout.yards.length === 0 && <p className="g-card-text">No plots yet.</p>}
      {layout.yards.map((yard) => (
        <div key={yard.squad.id} className="g-list-yard">
          <h3 className="g-card-subtitle">
            <button type="button" className="g-link" onClick={() => go({ kind: 'yard', squadId: yard.squad.id })}>
              {yard.squad.name}
            </button>
            {yard.needsYou > 0 && <span className="g-list-needs"> · {yard.needsYou} need you</span>}
          </h3>
          <ul className="g-link-list">
            {yard.plots.map((p) => (
              <li key={p.stream.id}>
                <button
                  type="button"
                  className="g-list-row"
                  onClick={() => go({ kind: 'plot', streamId: p.stream.id })}
                >
                  <span className="g-list-title">{p.stream.title}</span>
                  <span className="g-crew-meta" data-needs={p.badge ? 'yes' : undefined}>
                    {plantStateLabel(p.state)}
                  </span>
                </button>
              </li>
            ))}
            {yard.plots.length === 0 && <li className="g-crew-meta">Nothing planted.</li>}
          </ul>
          {robotsOf(yard).length > 0 && (
            <p className="g-crew-meta g-list-robots">
              Robots:{' '}
              {robotsOf(yard).map((r, n) => (
                <span key={r.agent.id}>
                  {n > 0 && ', '}
                  <button type="button" className="g-link" onClick={() => go({ kind: 'robot', agentId: r.agent.id })}>
                    {agentLabel(r.agent).primary}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}

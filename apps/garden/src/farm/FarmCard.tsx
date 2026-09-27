import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { iso } from './iso'
import type { FarmInput } from './layout'
import type { FarmLayout, PlotLayout, RobotPlacement } from './types'
import { plantStateLabel, roleLabel, type Selection } from './selection'
import { AGENT_STATUS_LABELS, agentLabel } from './agentLabels'
import { webAppUrl } from '../api/base'
import { CloseIcon } from '../icons'

/** World point a card for this selection points at, or null if it's no longer on the farm. */
export function selectionAnchor(layout: FarmLayout, s: Selection): readonly [number, number] | null {
  switch (s.kind) {
    case 'plot': {
      const p = findPlot(layout, s.streamId)
      return p ? iso(p.i + 0.5, p.j + 0.5) : null
    }
    case 'robot': {
      const r = findRobot(layout, s.agentId)
      return r ? iso(r.i, r.j) : null
    }
    case 'yard': {
      const y = layout.yards.find((yard) => yard.squad.id === s.squadId)
      return y ? iso(y.sign.i, y.sign.j) : null
    }
    case 'mailbox':
      return iso(layout.mailbox.i, layout.mailbox.j)
    case 'farmhouse':
      return iso(layout.farmhouse.i, layout.farmhouse.j)
    case 'seedShed':
      return iso(layout.seedShed.i, layout.seedShed.j)
    case 'crates':
      return iso(layout.crates.i, layout.crates.j)
    case 'compost':
      return iso(layout.compost.i, layout.compost.j)
  }
}

export function findPlot(layout: FarmLayout, streamId: string): (PlotLayout & { squadName: string }) | null {
  for (const yard of layout.yards) {
    const p = yard.plots.find((plot) => plot.stream.id === streamId)
    if (p) return { ...p, squadName: yard.squad.name }
  }
  return null
}

export function findRobot(layout: FarmLayout, agentId: string): RobotPlacement | null {
  for (const yard of layout.yards) {
    if (yard.farmer?.agent.id === agentId) return yard.farmer
    for (const p of yard.plots) if (p.tender?.agent.id === agentId) return p.tender
    for (const r of [...yard.dock.robots, ...yard.bench.robots]) if (r.agent.id === agentId) return r
  }
  return layout.porch.robots.find((r) => r.agent.id === agentId) ?? null
}

const CARD_W = 320
const NARROW = 640

interface FarmCardProps {
  layout: FarmLayout
  input: FarmInput
  selection: Selection
  screen: readonly [number, number]
  viewport: { width: number; height: number }
  onClose: () => void
}

/**
 * The wooden card that pops up next to whatever was clicked. On narrow
 * screens it becomes a bottom sheet. (Actions arrive in the next milestone;
 * this shows what the thing is.)
 */
export function FarmCard({ layout, input, selection, screen, viewport, onClose }: FarmCardProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [selection])

  const narrow = viewport.width < NARROW
  const right = screen[0] + 44 + CARD_W < viewport.width - 16
  const style = narrow
    ? undefined
    : {
        left: right ? screen[0] + 44 : Math.max(16, screen[0] - 44 - CARD_W),
        top: Math.min(Math.max(16, screen[1] - 120), Math.max(16, viewport.height - 380)),
      }

  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={clsx('g-card g-farm-card', narrow ? 'g-sheet' : right ? 'g-point-left' : 'g-point-right')}
      style={style}
      aria-label="Details"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <button type="button" className="g-card-close" aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
      <CardBody layout={layout} input={input} selection={selection} />
    </section>
  )
}

function CardBody({ layout, input, selection }: { layout: FarmLayout; input: FarmInput; selection: Selection }) {
  switch (selection.kind) {
    case 'plot': {
      const p = findPlot(layout, selection.streamId)
      if (!p) return <p>This plant has moved on.</p>
      return (
        <>
          <p className="g-eyebrow">{p.squadName}</p>
          <h2 className="g-card-title">{p.stream.title}</h2>
          <p className="g-state-tag">{plantStateLabel(p.state)}</p>
          {p.stream.description && <p className="g-card-text">{p.stream.description}</p>}
        </>
      )
    }
    case 'robot': {
      const r = findRobot(layout, selection.agentId)
      if (!r) return <p>This robot has wandered off.</p>
      return (
        <>
          <p className="g-eyebrow">{roleLabel(r.role)}</p>
          <h2 className="g-card-title">{agentLabel(r.agent).primary}</h2>
          <p className="g-state-tag">{AGENT_STATUS_LABELS[r.agent.status]}</p>
        </>
      )
    }
    case 'yard': {
      const y = layout.yards.find((yard) => yard.squad.id === selection.squadId)
      if (!y) return <p>This plot is gone.</p>
      return (
        <>
          <p className="g-eyebrow">Squad plot</p>
          <h2 className="g-card-title">{y.squad.name}</h2>
          <p className="g-card-text">
            {y.plots.length} growing{y.needsYou ? ` · ${y.needsYou} need you` : ''}
          </p>
        </>
      )
    }
    case 'mailbox':
      return (
        <>
          <p className="g-eyebrow">Mailbox</p>
          <h2 className="g-card-title">
            {input.pendingActions.length ? `${input.pendingActions.length} need you` : 'Nothing needs you'}
          </h2>
        </>
      )
    case 'farmhouse':
      return (
        <>
          <p className="g-eyebrow">Farmhouse</p>
          <h2 className="g-card-title">Settings and everything else</h2>
          <p className="g-card-text">Settings, integrations and schedules live in the regular Ficus app.</p>
          <a className="g-button g-button-primary" href={webAppUrl('/')}>
            Open Ficus
          </a>
        </>
      )
    case 'seedShed':
      return (
        <>
          <p className="g-eyebrow">Seed shed</p>
          <h2 className="g-card-title">What shall we grow?</h2>
          <p className="g-card-text">Pick a plot and a consultant will talk it through with you.</p>
        </>
      )
    case 'crates':
      return (
        <>
          <p className="g-eyebrow">Harvest</p>
          <h2 className="g-card-title">{layout.crates.count} harvested</h2>
        </>
      )
    case 'compost':
      return (
        <>
          <p className="g-eyebrow">Compost</p>
          <h2 className="g-card-title">{layout.compost.count} canceled</h2>
        </>
      )
  }
}

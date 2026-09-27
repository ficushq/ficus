import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { iso } from './iso'
import type { FarmLayout } from './types'
import { findPlot, findRobot } from './find'
import type { Selection } from './selection'
import { useFarmCard } from './cards/context'
import { PlotCard } from './cards/PlotCard'
import { RobotCard } from './cards/RobotCard'
import { YardCard } from './cards/YardCard'
import { SeedShedCard } from './cards/SeedShedCard'
import { MailboxCard } from './cards/MailboxCard'
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

const CARD_W = 320
const NARROW = 640

interface FarmCardProps {
  selection: Selection
  screen: readonly [number, number]
  viewport: { width: number; height: number }
  onClose: () => void
}

/**
 * The wooden card that pops up next to whatever was clicked. On narrow
 * screens it becomes a bottom sheet.
 */
export function FarmCard({ selection, screen, viewport, onClose }: FarmCardProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [selection])

  const narrow = viewport.width < NARROW
  const right = screen[0] + 44 + CARD_W < viewport.width - 16
  const top = Math.min(Math.max(72, screen[1] - 120), Math.max(72, viewport.height - 420))
  const style = narrow
    ? undefined
    : {
        left: right ? screen[0] + 44 : Math.max(16, screen[0] - 44 - CARD_W),
        top,
        maxHeight: viewport.height - top - 16,
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
      <CardBody selection={selection} />
    </section>
  )
}

function CardBody({ selection }: { selection: Selection }) {
  const { layout, input } = useFarmCard()
  switch (selection.kind) {
    case 'plot':
      return <PlotCard streamId={selection.streamId} />
    case 'robot':
      return <RobotCard agentId={selection.agentId} />
    case 'yard':
      return <YardCard squadId={selection.squadId} />
    case 'seedShed':
      return <SeedShedCard />
    case 'mailbox':
      return <MailboxCard />
    case 'farmhouse':
      return (
        <>
          <p className="g-eyebrow">Farmhouse</p>
          <h2 className="g-card-title">Settings and everything else</h2>
          <p className="g-card-text">Settings, integrations and schedules live in the regular Ficus app.</p>
          <a className="g-button g-button-primary g-card-wide" href={webAppUrl('/')}>
            Open Ficus
          </a>
        </>
      )
    case 'crates':
      return (
        <>
          <p className="g-eyebrow">Harvest</p>
          <h2 className="g-card-title">{layout.crates.count} harvested</h2>
          <p className="g-card-text">Finished work streams end up here.</p>
          <a className="g-button g-card-wide" href={webAppUrl('/')}>
            See them in Ficus
          </a>
        </>
      )
    case 'compost':
      return (
        <>
          <p className="g-eyebrow">Compost</p>
          <h2 className="g-card-title">{layout.compost.count} canceled</h2>
        </>
      )
    default:
      return <p className="g-card-text">{input.squads.length} plots</p>
  }
}

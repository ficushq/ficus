import { useCallback, useMemo, useRef, useState } from 'react'
import './farm.css'
import './sprites.css'
import { screenBounds } from './iso'
import { layoutFarm, type FarmInput } from './layout'
import { SceneWorld } from './Scene'
import { useCamera } from './useCamera'
import { useViewportSize } from './useViewportSize'
import { FarmCard, selectionAnchor } from './FarmCard'
import type { Selection } from './selection'
import type { LiveStatus } from '../live/LiveUpdates'
import { BasketIcon, EnvelopeIcon, FitIcon, LeafIcon, MailboxIcon, MinusIcon, PlusIcon, SeedPacketIcon } from '../icons'

/** How far sprites stick up above/out of their tiles (trees, the farmhouse roof). */
const WORLD_PAD = { top: 200, side: 60, bottom: 40 }

export function FarmScreen({ input, live }: { input: FarmInput; live: LiveStatus }) {
  const layout = useMemo(() => layoutFarm(input), [input])
  const viewport = useRef<HTMLDivElement>(null)
  const size = useViewportSize(viewport)
  const world = useMemo(() => {
    const b = screenBounds(layout.bounds.minI, layout.bounds.maxI, layout.bounds.minJ, layout.bounds.maxJ)
    return {
      minX: b.minX - WORLD_PAD.side,
      maxX: b.maxX + WORLD_PAD.side,
      minY: b.minY - WORLD_PAD.top,
      maxY: b.maxY + WORLD_PAD.bottom,
    }
  }, [layout.bounds])
  const focusBox = useMemo(() => {
    const tiles: Array<[number, number]> = [
      [layout.farmhouse.i - 2, layout.farmhouse.j - 2],
      [layout.seedShed.i - 1, layout.seedShed.j + 1],
      [layout.mailbox.i + 1, layout.mailbox.j + 1],
    ]
    for (const y of layout.yards) tiles.push([y.i0 - 1, y.j0 - 1], [y.i0 + y.w + 1, y.j0 + y.h + 1.5])
    const is = tiles.map((t) => t[0])
    const js = tiles.map((t) => t[1])
    const b = screenBounds(Math.min(...is), Math.max(...is), Math.min(...js), Math.max(...js))
    return { minX: b.minX, maxX: b.maxX, minY: b.minY - 120, maxY: b.maxY }
  }, [layout])
  const { camera, fit, zoomBy } = useCamera(viewport, world, focusBox)
  const [selection, setSelection] = useState<Selection | null>(null)
  const onSelect = useCallback((s: Selection) => setSelection(s), [])

  const needsYou = input.pendingActions.length
  const growing = layout.yards.reduce((n, y) => n + y.plots.length, 0)
  const anchor = selection ? selectionAnchor(layout, selection) : null
  const toScreen = (x: number, y: number) =>
    [(x - camera.x) * camera.zoom + size.width / 2, (y - camera.y) * camera.zoom + size.height / 2] as const

  return (
    <div className="g-farm">
      <div ref={viewport} className="g-viewport" onKeyDown={(e) => e.key === 'Escape' && setSelection(null)}>
        <svg className="g-scene" width={size.width} height={size.height} role="application" aria-label="Your farm">
          <g
            transform={`translate(${size.width / 2} ${size.height / 2}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}
          >
            <SceneWorld layout={layout} selection={selection} mailboxCount={needsYou} onSelect={onSelect} />
          </g>
        </svg>
      </div>

      <header className="g-hud">
        <div className="g-logo g-panel">
          <img src={`${import.meta.env.BASE_URL}ficus-mark.svg`} alt="" width={32} height={32} />
          <span>ficus garden</span>
        </div>
        <div className="g-counters" aria-live="polite">
          <Counter icon={<EnvelopeIcon />} tint="#b0582f" value={needsYou} label="need you" hot={needsYou > 0} />
          <Counter icon={<LeafIcon />} tint="#5d9a58" value={growing} label="growing" />
          <Counter icon={<BasketIcon />} tint="#e0a93b" value={layout.crates.count} label="harvested" />
        </div>
      </header>

      <nav className="g-tools" aria-label="Garden tools">
        <ToolButton label="Mail" badge={needsYou} onClick={() => setSelection({ kind: 'mailbox' })}>
          <MailboxIcon />
        </ToolButton>
        <ToolButton label="Seeds" onClick={() => setSelection({ kind: 'seedShed' })}>
          <SeedPacketIcon />
        </ToolButton>
        <ToolButton label="Zoom in" short="In" onClick={() => zoomBy(1.25)}>
          <PlusIcon />
        </ToolButton>
        <ToolButton label="Zoom out" short="Out" onClick={() => zoomBy(0.8)}>
          <MinusIcon />
        </ToolButton>
        <ToolButton label="Show the whole farm" short="Fit" onClick={fit}>
          <FitIcon />
        </ToolButton>
      </nav>

      {live !== 'live' && (
        <p className="g-live-note g-panel" role="status">
          {live === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
        </p>
      )}

      {selection && anchor && (
        <FarmCard
          layout={layout}
          input={input}
          selection={selection}
          screen={toScreen(anchor[0], anchor[1])}
          viewport={size}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  )
}

function Counter({
  icon,
  tint,
  value,
  label,
  hot,
}: {
  icon: React.ReactNode
  tint: string
  value: number
  label: string
  hot?: boolean
}) {
  return (
    <div className="g-counter g-panel">
      <span className="g-counter-icon" style={{ background: tint }}>
        {icon}
      </span>
      <b className={hot ? 'g-hot' : undefined}>{value}</b>
      <small>{label}</small>
    </div>
  )
}

function ToolButton({
  label,
  short,
  badge,
  onClick,
  children,
}: {
  label: string
  short?: string
  badge?: number
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className="g-tool"
      aria-label={badge ? `${label}, ${badge} need you` : label}
      onClick={onClick}
    >
      {children}
      {badge ? <span className="g-tool-badge">{badge}</span> : null}
      <span className="g-tool-label" aria-hidden="true">
        {short ?? label}
      </span>
    </button>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import './farm.css'
import './sprites.css'
import { screenBounds } from './iso'
import { layoutFarm, type FarmInput } from './layout'
import { SceneWorld } from './Scene'
import { useCamera } from './useCamera'
import { useViewportSize } from './useViewportSize'
import { FarmCard, selectionAnchor } from './FarmCard'
import { FarmCardContext, type FarmCardEnv } from './cards/context'
import { type ChatTarget } from './cards/ChatSlot'
import { ChatWindows, useChatWindows } from './ChatWindows'
import { haltedAgentIds } from './state'
import { useStableRef } from '../hooks/useStableRef'
import { useDesktopShellChrome } from '../desktop/shell'
import type { Selection } from './selection'
import type { LiveStatus } from '../live/LiveUpdates'
import {
  AssistantIcon,
  BasketIcon,
  EnvelopeIcon,
  FitIcon,
  LeafIcon,
  ListIcon,
  MailboxIcon,
  MinusIcon,
  PlusIcon,
  SeedPacketIcon,
  SpeakerIcon,
} from '../icons'
import { FarmList } from './FarmList'
import { useFarmSounds } from '../sound/useFarmSounds'
import { webAppUrl } from '../api/base'

/** How far sprites stick up above/out of their tiles (trees, the farmhouse roof). */
const WORLD_PAD = { top: 200, side: 60, bottom: 40 }

export function FarmScreen({ input, live }: { input: FarmInput; live: LiveStatus }) {
  useDesktopShellChrome()
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
  const { camera, fit, zoomBy, focus } = useCamera(viewport, world, focusBox)
  const cameraRef = useStableRef(camera)
  const sizeRef = useStableRef(size)
  /** Pan just enough to bring a world point into the comfortable middle of the screen. */
  const reveal = useCallback(
    (x: number, y: number) => {
      const c = cameraRef.current
      const { width, height } = sizeRef.current
      const sx = (x - c.x) * c.zoom + width / 2
      const sy = (y - c.y) * c.zoom + height / 2
      const margin = Math.min(width, height) * 0.18
      if (sx < margin || sx > width - margin || sy < margin || sy > height - margin) focus(x, y, c.zoom)
    },
    [cameraRef, sizeRef, focus]
  )
  const [selection, setSelection] = useState<Selection | null>(null)
  const chats = useChatWindows(size)
  // Phones have room for one thing: a chat opened from a card replaces the card.
  const openChatRef = useStableRef((target: ChatTarget) => {
    if (size.width < 640) setSelection(null)
    chats.open(target)
  })
  const onSelect = useCallback((s: Selection) => setSelection(s), [])

  const env = useMemo<FarmCardEnv>(
    () => ({
      layout,
      input,
      agentsById: new Map([...input.agents, ...input.assistants].map((a) => [a.id, a])),
      squadsById: new Map(input.squads.map((s) => [s.id, s])),
      halted: haltedAgentIds(input.pendingActions),
      select: setSelection,
      openChat: (agentId) => openChatRef.current({ kind: 'agent', agentId } satisfies ChatTarget),
      startConsultant: (squadId) => openChatRef.current({ kind: 'consultant', squadId }),
      openAssistant: (conversationId) => openChatRef.current({ kind: 'assistant', conversationId }),
      startAssistant: () => openChatRef.current({ kind: 'assistant', fresh: crypto.randomUUID() }),
    }),
    [layout, input]
  )

  // On phones the card is a bottom sheet: lift the selected thing into the top of the screen.
  const selectionRef = useStableRef(selection)
  useEffect(() => {
    const s = selectionRef.current
    const { width, height } = sizeRef.current
    if (!s || width >= 640) return
    const point = selectionAnchor(layout, s)
    if (!point) return
    const zoom = cameraRef.current.zoom
    focus(point[0], point[1] + (height * 0.5 - height * 0.18) / zoom, zoom)
  }, [selection, layout, focus, selectionRef, sizeRef, cameraRef])

  const needsYou = input.pendingActions.length
  const assistantTotals = input.assistantActivity?.totals
  // Assistant conversations with a question for you or updates you haven't read.
  const assistantNews = (assistantTotals?.needsInputTasks ?? 0) + (assistantTotals?.unreadUpdates ?? 0)
  const sound = useFarmSounds(layout, needsYou)
  const [listOpen, setListOpen] = useState(false)
  const growing = layout.yards.reduce((n, y) => n + y.plots.length, 0)
  // A robot reached from a list or a chat may not stand anywhere on the farm (finished, asleep):
  // its card opens where the previous card was, else mid-screen, rather than not at all.
  const lastAnchor = useRef<readonly [number, number] | null>(null)
  const anchor =
    selection?.kind === 'assistant'
      ? ([camera.x, camera.y] as const)
      : selection
        ? (selectionAnchor(layout, selection) ?? lastAnchor.current ?? ([camera.x, camera.y] as const))
        : null
  if (anchor) lastAnchor.current = anchor
  const toScreen = (x: number, y: number) =>
    [(x - camera.x) * camera.zoom + size.width / 2, (y - camera.y) * camera.zoom + size.height / 2] as const

  return (
    <div className="g-farm">
      <div ref={viewport} className="g-viewport" onKeyDown={(e) => e.key === 'Escape' && setSelection(null)}>
        <svg className="g-scene" width={size.width} height={size.height} role="application" aria-label="Your farm">
          <g
            transform={`translate(${size.width / 2} ${size.height / 2}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}
          >
            <SceneWorld
              layout={layout}
              selection={selection}
              mailboxCount={needsYou}
              onSelect={onSelect}
              onReveal={reveal}
            />
          </g>
        </svg>
      </div>

      {/* Desktop's hidden title bar: the top strip drags the window (see desktop/shell.ts). */}
      <div className="g-titlebar" aria-hidden="true" />
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
        <ToolButton
          label="Assistant"
          badge={assistantNews || undefined}
          badgeLabel="waiting"
          onClick={() => setSelection({ kind: 'assistant' })}
        >
          <AssistantIcon />
        </ToolButton>
        <ToolButton label="Mail" badge={needsYou} onClick={() => setSelection({ kind: 'mailbox' })}>
          <MailboxIcon />
        </ToolButton>
        <ToolButton label="Seeds" onClick={() => setSelection({ kind: 'seedShed' })}>
          <SeedPacketIcon />
        </ToolButton>
        <ToolButton label="Zoom in" short="In" wideOnly onClick={() => zoomBy(1.25)}>
          <PlusIcon />
        </ToolButton>
        <ToolButton label="Zoom out" short="Out" wideOnly onClick={() => zoomBy(0.8)}>
          <MinusIcon />
        </ToolButton>
        <ToolButton label="Show the whole farm" short="Fit" onClick={fit}>
          <FitIcon />
        </ToolButton>
        <ToolButton label="List everything on the farm" short="List" onClick={() => setListOpen((o) => !o)}>
          <ListIcon />
        </ToolButton>
        <ToolButton label={sound.on ? 'Sound on, turn off' : 'Sound off, turn on'} short="Sound" onClick={sound.toggle}>
          <SpeakerIcon muted={!sound.on} />
        </ToolButton>
      </nav>

      {live !== 'live' && (
        <p className="g-live-note g-panel" role="status">
          {live === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
        </p>
      )}

      {layout.yards.length === 0 && (
        <div className="g-card g-empty-farm">
          <h2 className="g-card-title">An empty field</h2>
          <p className="g-card-text">
            Plots are squads. Create your first squad in Ficus and it will appear here, fenced and ready to plant.
          </p>
          <a className="g-button g-button-primary g-card-wide" href={webAppUrl('/squads')}>
            Create a squad
          </a>
        </div>
      )}

      {listOpen && <FarmList layout={layout} onSelect={setSelection} onClose={() => setListOpen(false)} />}

      <FarmCardContext.Provider value={env}>
        {selection && anchor && (
          <FarmCard
            selection={selection}
            screen={toScreen(anchor[0], anchor[1])}
            dock={selection.kind === 'assistant' ? 'tools' : undefined}
            viewport={size}
            onClose={() => setSelection(null)}
          />
        )}
        <ChatWindows chats={chats} narrow={size.width < 640} />
      </FarmCardContext.Provider>
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
  badgeLabel = 'need you',
  wideOnly,
  onClick,
  children,
}: {
  label: string
  short?: string
  badge?: number
  /** How the badge count reads to screen readers ("3 need you"). */
  badgeLabel?: string
  /** Hidden on phones, where pinch does the job. */
  wideOnly?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={clsx('g-tool', wideOnly && 'g-tool-wide-only')}
      aria-label={badge ? `${label}, ${badge} ${badgeLabel}` : label}
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

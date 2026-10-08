import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import './farm.css'
import { screenBounds } from './iso'
import { layoutFarm, type FarmInput } from './layout'
import { SceneWorld } from './Scene'
import { PlantingWalker, usePlantings } from './Planting'
import { RobotWalker, useRobotWalks } from './RobotWalkers'
import { FlyingLetters } from './FlyingLetters'
import { useCamera } from './useCamera'
import { shownMoods } from './moods'
import { useMoodSnapshot, useRobotMoodWatching } from './useRobotMoods'
import { useViewportSize } from './useViewportSize'
import { FarmCard, selectionAnchor } from './FarmCard'
import { FarmCardContext, type FarmCardEnv } from './cards/context'
import { type ChatTarget } from './cards/ChatSlot'
import { ChatWindows, useChatWindows } from './ChatWindows'
import { frontmost } from './chatWindowState'
import { iso } from './iso'
import { useMultiplayer } from '../multiplayer/MultiplayerProvider'
import { focusFor, huddle, spotFor } from '../multiplayer/spots'
import { People, type PlacedPerson } from '../multiplayer/People'
import { lookFor } from '../multiplayer/personLook'
import { FarmChatPanel } from '../multiplayer/FarmChatPanel'
import { LookBuilder } from '../multiplayer/LookBuilder'
import { useFirstVisit } from '../onboarding/useFirstVisit'
import { Welcome } from '../onboarding/Welcome'
import { chatKeys } from '../multiplayer/chatApi'
import { useQueryClient } from '@tanstack/react-query'
import { haltedAgentIds } from './state'
import { useStableRef } from '../hooks/useStableRef'
import { isDemo } from '../app/demo'
import { readView, viewKey, writeView } from './savedView'
import { useDesktopShellChrome } from '../desktop/shell'
import { SKINS, useSkin } from '../skins'
import type { Selection } from './selection'
import type { LiveStatus } from '../live/LiveUpdates'
import {
  AssistantIcon,
  BasketIcon,
  ChatBubblesIcon,
  EnvelopeIcon,
  FitIcon,
  LeafIcon,
  MailboxIcon,
  MinusIcon,
  PlusIcon,
  MoreIcon,
  PeopleIcon,
  ShirtIcon,
  SeedPacketIcon,
  SpeakerIcon,
  StyleIcon,
} from '../icons'
import { useFarmSounds } from '../sound/useFarmSounds'
import { webAppUrl } from '../api/base'
// The one source of the mark (brand/), so fixes to it reach the farm without a copy to update.
import ficusMark from '../../../../brand/ficus-mark.svg'

/** How long after the last change the view (camera, card, chats) is saved. */
const SAVE_VIEW_MS = 400

export function FarmScreen({ input, live }: { input: FarmInput; live: LiveStatus }) {
  useDesktopShellChrome()
  // Where you were before a refresh: the camera, the card you had open and your chat windows.
  const [saved] = useState(() => readView(viewKey(isDemo)))
  const { skin, setSkin } = useSkin()
  const layout = useMemo(() => layoutFarm(input), [input])
  // Robots walk to new jobs (and home to rest); one out walking plants when it's back.
  const walks = useRobotWalks(layout)
  const plantings = usePlantings(layout, walks.walking)
  const hidden = useMemo(
    () =>
      walks.walking.size
        ? { ...plantings.hidden, robots: new Set([...plantings.hidden.robots, ...walks.walking]) }
        : plantings.hidden,
    [plantings.hidden, walks.walking]
  )
  const viewport = useRef<HTMLDivElement>(null)
  const size = useViewportSize(viewport)
  const world = useMemo(() => {
    const b = screenBounds(layout.bounds.minI, layout.bounds.maxI, layout.bounds.minJ, layout.bounds.maxJ)
    return {
      // How far the style's art reaches past the tiles (trees, roofs).
      minX: b.minX - skin.worldPad.side,
      maxX: b.maxX + skin.worldPad.side,
      minY: b.minY - skin.worldPad.top,
      maxY: b.maxY + skin.worldPad.bottom,
    }
  }, [layout.bounds, skin.worldPad])
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
  const { camera, fit, zoomBy, focus, flyTo } = useCamera(viewport, world, focusBox, saved.camera)
  const cameraRef = useStableRef(camera)
  // Robot moods: Core works them out only for the robots on screen here.
  useRobotMoodWatching(layout, camera, size)
  const moodSnapshot = useMoodSnapshot()
  const moods = useMemo(() => shownMoods(layout, moodSnapshot), [layout, moodSnapshot])
  const sizeRef = useStableRef(size)
  /** Pan just enough to bring a world point into the comfortable middle of the screen. */
  const reveal = useCallback(
    (x: number, y: number) => {
      const c = cameraRef.current
      const { width, height } = sizeRef.current
      // Not measured yet (the first moments after a load): everything would look off screen.
      if (!width || !height) return
      const sx = (x - c.x) * c.zoom + width / 2
      const sy = (y - c.y) * c.zoom + height / 2
      const margin = Math.min(width, height) * 0.18
      if (sx < margin || sx > width - margin || sy < margin || sy > height - margin) focus(x, y, c.zoom)
    },
    [cameraRef, sizeRef, focus]
  )
  const [selection, setSelection] = useState<Selection | null>(saved.selection)
  const chats = useChatWindows(size, saved.chats)
  // Keep the view for next time: a moment after it settles, and straight away when the page goes.
  const view = useStableRef({ camera, selection, chats: chats.windows })
  useEffect(() => {
    const timer = window.setTimeout(() => writeView(viewKey(isDemo), view.current), SAVE_VIEW_MS)
    return () => window.clearTimeout(timer)
  }, [camera, selection, chats.windows, view])
  useEffect(() => {
    const flush = () => writeView(viewKey(isDemo), view.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [view])
  // Phones have room for one thing: a chat opened from a card replaces the card.
  const openChatRef = useStableRef((target: ChatTarget) => {
    if (size.width < 640) setSelection(null)
    chats.open(target)
  })
  const onSelect = useCallback((s: Selection) => setSelection(s), [])

  // Multiplayer: tell everyone what you're at (your frontmost chat, else your card; looking at
  // someone's card keeps you where you were), and place everyone on the farm.
  const multiplayer = useMultiplayer()
  const queryClient = useQueryClient()
  const frontChat = frontmost(chats.windows)?.target
  const lastFocus = useRef<ReturnType<typeof focusFor>>(null)
  const myFocus = selection?.kind === 'person' ? lastFocus.current : focusFor(selection, frontChat)
  lastFocus.current = myFocus
  const focusKey = JSON.stringify(myFocus)
  const setFocus = multiplayer.setFocus
  useEffect(() => {
    setFocus(JSON.parse(focusKey))
  }, [focusKey, setFocus])
  const [farmChat, setFarmChat] = useState<{
    open: boolean
    roomId: string | null
    /** Something to add to what you're writing in the open room (sharing a plant or robot). */
    insert?: { text: string; at: number }
  }>({ open: false, roomId: null })
  const [lookOpen, setLookOpen] = useState(false)
  // First time here: pick a style, then make your farmer.
  const { firstVisit, welcomed } = useFirstVisit()
  const agentsById = useMemo(
    () => new Map([...input.agents, ...input.assistants].map((a) => [a.id, a])),
    [input.agents, input.assistants]
  )
  const placed = useMemo<PlacedPerson[]>(() => {
    if (!multiplayer.enabled) return []
    const everyone = multiplayer.people.map((p) => ({
      userId: p.userId,
      name: p.name,
      focus: p.focus,
      isMe: false,
      look: lookFor(p.userId, p.look),
    }))
    if (multiplayer.me)
      everyone.push({
        userId: multiplayer.me.userId,
        name: multiplayer.me.name,
        focus: multiplayer.focus,
        isMe: true,
        look: multiplayer.myLook,
      })
    const spots = huddle(everyone.map((p) => ({ key: p.userId, spot: spotFor(layout, p.focus, agentsById) })))
    const here = everyone.map(({ focus: _focus, ...p }) => ({
      ...p,
      spot: spots.get(p.userId)!,
      // Out of the farmhouse: someone who just came onto the farm, or you, arriving.
      coming: p.isMe || multiplayer.arrivals.has(p.userId),
      leaving: false,
    }))
    // Whoever just left walks back into the farmhouse from where they were.
    const going = multiplayer.departures
      .filter((p) => !here.some((h) => h.userId === p.userId))
      .map((p) => ({
        userId: p.userId,
        name: p.name,
        isMe: false,
        look: lookFor(p.userId, p.look),
        spot: spotFor(layout, p.focus, agentsById),
        coming: false,
        leaving: true,
      }))
    return [...here, ...going]
  }, [
    multiplayer.enabled,
    multiplayer.people,
    multiplayer.arrivals,
    multiplayer.departures,
    multiplayer.me,
    multiplayer.focus,
    multiplayer.myLook,
    layout,
    agentsById,
  ])
  const selectPerson = useCallback((userId: string) => setSelection({ kind: 'person', userId }), [])
  const chatApi = multiplayer.chat
  const openDmRef = useStableRef(async (userId: string) => {
    const room = await chatApi.directRoom(userId)
    await queryClient.invalidateQueries({ queryKey: chatKeys.rooms() })
    // The DM takes over from the person's card.
    setSelection(null)
    setFarmChat({ open: true, roomId: room.id })
  })

  // A notification was clicked: open its room.
  const requested = multiplayer.openRoom
  useEffect(() => {
    if (!requested) return
    setLookOpen(false)
    setFarmChat((c) => ({ ...c, open: true, roomId: requested.roomId }))
  }, [requested])

  const flyToRef = useStableRef((s: Selection) => {
    const phone = sizeRef.current.width < 640
    // A phone's chat covers the farm: close it so you see where you went (the card's own lift moves the camera).
    if (phone) setFarmChat((c) => ({ ...c, open: false }))
    setSelection(s)
    const point = selectionAnchor(layout, s)
    if (point && !phone) flyTo(point[0], point[1])
  })

  const env = useMemo<FarmCardEnv>(
    () => ({
      layout,
      input,
      agentsById,
      squadsById: new Map(input.squads.map((s) => [s.id, s])),
      halted: haltedAgentIds(input.pendingActions),
      select: setSelection,
      openChat: (agentId) => openChatRef.current({ kind: 'agent', agentId } satisfies ChatTarget),
      startConsultant: (squadId) => openChatRef.current({ kind: 'consultant', squadId }),
      openFieldLog: (squadId) => openChatRef.current({ kind: 'fieldLog', squadId }),
      openAssistant: (conversationId) => openChatRef.current({ kind: 'assistant', conversationId }),
      startAssistant: () => openChatRef.current({ kind: 'assistant', fresh: crypto.randomUUID() }),
      messagePerson: (userId) => void openDmRef.current(userId),
      changeLook: () => {
        setSelection(null)
        setFarmChat((c) => ({ ...c, open: false }))
        setLookOpen(true)
      },
      flyTo: (s) => flyToRef.current(s),
      shareInChat: (text) => {
        setLookOpen(false)
        setFarmChat((c) => ({ ...c, open: true, insert: { text, at: Date.now() } }))
      },
    }),
    [layout, input, agentsById, openDmRef, flyToRef]
  )

  // On phones the card is a bottom sheet: lift the selected thing into the top of the screen.
  const selectionRef = useStableRef(selection)
  // Only once the viewport is measured: before that every screen looks phone-sized.
  const measured = size.width > 0
  useEffect(() => {
    const s = selectionRef.current
    const { width, height } = sizeRef.current
    if (!s || !measured || width >= 640) return
    const point = selectionAnchor(layout, s)
    if (!point) return
    const zoom = cameraRef.current.zoom
    focus(point[0], point[1] + (height * 0.5 - height * 0.18) / zoom, zoom)
  }, [selection, layout, focus, measured, selectionRef, sizeRef, cameraRef])

  const needsYou = input.pendingActions.length
  const nextSkin = SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]!
  const sound = useFarmSounds(layout, needsYou)
  // Phones have room for four tools; the rest sit behind More.
  const narrow = size.width > 0 && size.width < 640
  const [moreOpen, setMoreOpen] = useState(false)
  const fitTool = (
    <ToolButton label="Show the whole farm" short="Fit" onClick={fit}>
      <FitIcon />
    </ToolButton>
  )
  const extraTools = (
    <>
      {narrow && fitTool}
      <ToolButton
        label={
          multiplayer.enabled
            ? 'Multiplayer: others can see you. Switch to single-player'
            : 'Single-player: nobody sees you. Rejoin everyone'
        }
        short={multiplayer.enabled ? 'Together' : 'Solo'}
        onClick={() => multiplayer.setEnabled(!multiplayer.enabled)}
      >
        <PeopleIcon solo={!multiplayer.enabled} />
      </ToolButton>
      <ToolButton label="Change your look" short="Look" expanded={lookOpen} onClick={() => env.changeLook()}>
        <ShirtIcon />
      </ToolButton>
      <ToolButton
        label={`Style: ${skin.label}. Switch to ${nextSkin.label}`}
        short={skin.label}
        onClick={() => setSkin(nextSkin.id)}
      >
        <StyleIcon />
      </ToolButton>
      <ToolButton label={sound.on ? 'Sound on, turn off' : 'Sound off, turn on'} short="Sound" onClick={sound.toggle}>
        <SpeakerIcon muted={!sound.on} />
      </ToolButton>
    </>
  )
  const assistantTotals = input.assistantActivity?.totals
  // Assistant conversations with a question for you or updates you haven't read.
  const assistantNews = (assistantTotals?.needsInputTasks ?? 0) + (assistantTotals?.unreadUpdates ?? 0)
  const growing = layout.yards.reduce((n, y) => n + y.plots.length, 0)
  // A robot reached from a list or a chat may not stand anywhere on the farm (finished, asleep):
  // its card opens where the previous card was, else mid-screen, rather than not at all.
  const lastAnchor = useRef<readonly [number, number] | null>(null)
  const person = selection?.kind === 'person' ? placed.find((p) => p.userId === selection.userId) : undefined
  const anchor =
    selection?.kind === 'assistant' || selection?.kind === 'overview'
      ? ([camera.x, camera.y] as const)
      : person
        ? iso(person.spot.at[0], person.spot.at[1])
        : selection
          ? (selectionAnchor(layout, selection) ?? lastAnchor.current ?? ([camera.x, camera.y] as const))
          : null
  if (anchor) lastAnchor.current = anchor
  const toScreen = (x: number, y: number) =>
    [(x - camera.x) * camera.zoom + size.width / 2, (y - camera.y) * camera.zoom + size.height / 2] as const

  return (
    <div className={clsx('g-farm', skin.className)}>
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
              hidden={hidden}
              moods={moods}
            />
            {walks.walks.map((walk) => (
              <RobotWalker key={`${walk.agentId}:${walk.serial}`} walk={walk} onStep={walks.step} onDone={walks.done} />
            ))}
            {plantings.active.map((planting) => (
              <PlantingWalker
                key={planting.streamId}
                planting={planting}
                onPlanted={plantings.planted}
                onDone={plantings.done}
              />
            ))}
            <People
              layout={layout}
              people={placed}
              bubbles={multiplayer.bubbles}
              emotes={multiplayer.emotes}
              selectedUserId={selection?.kind === 'person' ? selection.userId : null}
              onSelect={selectPerson}
            />
            <FlyingLetters layout={layout} me={placed.find((p) => p.isMe)?.spot.at ?? null} />
          </g>
        </svg>
      </div>

      {/* Desktop's hidden title bar: the top strip drags the window (see desktop/shell.ts). */}
      <div className="g-titlebar" aria-hidden="true" />
      <header className="g-hud">
        {/* Back to the regular app, like the farmhouse's Open Ficus (Ficus Mobile catches it and shows its feed). */}
        <a className="g-logo g-panel" href={webAppUrl('/')} aria-label="Ficus Farm: open Ficus" title="Open Ficus">
          <img src={ficusMark} alt="" width={32} height={32} />
          <span aria-hidden="true">Ficus Farm</span>
        </a>
        <div className="g-counters" aria-live="polite">
          <Counter
            icon={<EnvelopeIcon />}
            tint="var(--g-counter-mail)"
            value={needsYou}
            label="need you"
            hot={needsYou > 0}
            opens="Open the mailbox"
            onClick={() => setSelection({ kind: 'mailbox' })}
          />
          <Counter
            icon={<LeafIcon />}
            tint="var(--g-counter-growing)"
            value={growing}
            label="growing"
            opens="See everything growing"
            onClick={() => setSelection({ kind: 'overview' })}
          />
          <Counter
            icon={<BasketIcon />}
            tint="var(--g-counter-harvested)"
            value={layout.crates.count}
            label="harvested"
            opens="See the harvest"
            onClick={() => setSelection({ kind: 'crates' })}
          />
        </div>
      </header>

      <nav className="g-tools" aria-label="Farm tools">
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
        <ToolButton
          label="Farm chat"
          short="Chat"
          badge={multiplayer.unread || undefined}
          badgeLabel="unread"
          expanded={farmChat.open}
          onClick={() => {
            setLookOpen(false)
            setFarmChat((c) => ({ ...c, open: !c.open }))
          }}
        >
          <ChatBubblesIcon />
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
        {!narrow && fitTool}
        {narrow ? (
          <ToolButton label="More tools" short="More" expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
            <MoreIcon />
          </ToolButton>
        ) : (
          extraTools
        )}
      </nav>

      {narrow && moreOpen && (
        <nav className="g-tools g-tools-more" aria-label="More tools" onClick={() => setMoreOpen(false)}>
          {extraTools}
        </nav>
      )}

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

      <FarmCardContext.Provider value={env}>
        {selection && anchor && (
          <FarmCard
            selection={selection}
            screen={toScreen(anchor[0], anchor[1])}
            dock={selection.kind === 'assistant' ? 'tools' : selection.kind === 'overview' ? 'counters' : undefined}
            viewport={size}
            onClose={() => setSelection(null)}
          />
        )}
        <ChatWindows chats={chats} narrow={size.width < 640} />
        {farmChat.open && (
          <FarmChatPanel
            roomId={farmChat.roomId}
            onRoom={(roomId) => setFarmChat((c) => ({ ...c, open: true, roomId }))}
            insert={farmChat.insert}
            onInserted={() => setFarmChat((c) => ({ ...c, insert: undefined }))}
            onClose={() => setFarmChat((c) => ({ ...c, open: false }))}
            narrow={narrow}
          />
        )}
      </FarmCardContext.Provider>
      {lookOpen && <LookBuilder narrow={narrow} onClose={() => setLookOpen(false)} />}
      {firstVisit && <Welcome narrow={narrow} onDone={welcomed} />}
    </div>
  )
}

function Counter({
  icon,
  tint,
  value,
  label,
  hot,
  opens,
  onClick,
}: {
  icon: React.ReactNode
  tint: string
  value: number
  label: string
  hot?: boolean
  /** What clicking it opens, e.g. "Open the mailbox". */
  opens: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="g-counter g-panel"
      aria-label={`${value} ${label}. ${opens}`}
      title={opens}
      onClick={onClick}
    >
      <span className="g-counter-icon" style={{ background: tint }}>
        {icon}
      </span>
      <b className={hot ? 'g-hot' : undefined}>{value}</b>
      <small>{label}</small>
    </button>
  )
}

function ToolButton({
  label,
  short,
  badge,
  badgeLabel = 'need you',
  wideOnly,
  expanded,
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
  /** For a button that opens a menu. */
  expanded?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={clsx('g-tool', wideOnly && 'g-tool-wide-only')}
      aria-label={badge ? `${label}, ${badge} ${badgeLabel}` : label}
      aria-expanded={expanded}
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

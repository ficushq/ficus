import { memo, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { depth, iso } from './iso'
import type { FarmLayout, PlotLayout, RobotPlacement } from './types'
import { plantStateLabel, roleLabel, selectionKey, type Selection } from './selection'
import { agentLabel } from './agentLabels'
import type { FarmSkin, HitBox } from '../skins/types'
import { useSkin } from '../skins'

interface Drawable {
  key: string
  depth: number
  node: ReactNode
}

/** What a planting in progress keeps off the map (see Planting.tsx). */
export interface SceneHidden {
  /** Plants not planted yet: their robot is still on its way. */
  plants: ReadonlySet<string>
  /** Robots out planting: drawn walking instead of at their spot. */
  robots: ReadonlySet<string>
  /** Plants just planted, which pop up out of the soil. */
  popping: ReadonlySet<string>
}

export const NOTHING_HIDDEN: SceneHidden = { plants: new Set(), robots: new Set(), popping: new Set() }

interface SceneProps {
  layout: FarmLayout
  selection: Selection | null
  mailboxCount: number
  onSelect: (selection: Selection) => void
  /** Keyboard focus landed on a sprite at this world point: bring it into view. */
  onReveal: (x: number, y: number) => void
  hidden?: SceneHidden
}

/** Wraps a sprite at a world position as a keyboard- and screen-reader-reachable button. */
function Hit({
  x,
  y,
  label,
  selected,
  onActivate,
  box,
  onReveal,
  children,
}: {
  x: number
  y: number
  label: string
  selected?: boolean
  onActivate: () => void
  /** Generous tap area around the anchor: [left, top, width, height]. */
  box: HitBox
  onReveal: (x: number, y: number) => void
  children: ReactNode
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate()
    }
  }
  return (
    <g transform={`translate(${x} ${y})`}>
      <g
        className="g-hit"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        onFocus={() => onReveal(x, y + box[1] / 2)}
      >
        <rect className="g-hit-area" x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx={14} />
        {children}
        <rect className="g-focus-ring" x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx={14} />
      </g>
    </g>
  )
}

function robotLabel(r: RobotPlacement): string {
  const name = agentLabel(r.agent).primary
  const face =
    r.face === 'question'
      ? 'waiting on you'
      : r.face === 'error'
        ? 'halted'
        : r.face === 'happy'
          ? 'working'
          : r.face === 'sleepy'
            ? 'asleep'
            : 'idle'
  const role = r.role === 'manager' ? 'farmer (squad manager)' : roleLabel(r.role).toLowerCase()
  return `${name}, ${role}, ${face}`
}

function buildDrawables(
  skin: FarmSkin,
  layout: FarmLayout,
  selected: string | null,
  mailboxCount: number,
  onSelect: (s: Selection) => void,
  onReveal: (x: number, y: number) => void,
  hidden: SceneHidden
): { ground: ReactNode[]; items: Drawable[]; badges: ReactNode[] } {
  const yardGround: ReactNode[] = []
  const ground: ReactNode[] = []
  const items: Drawable[] = []
  const badges: ReactNode[] = []

  const robot = (r: RobotPlacement, extra = 0, keyPrefix = 'robot') => {
    if (hidden.robots.has(r.agent.id)) return
    const [x, y] = iso(r.i, r.j)
    const key = `robot:${r.agent.id}`
    items.push({
      key: `${keyPrefix}:${r.agent.id}`,
      depth: depth(r.i, r.j),
      node: (
        <Hit
          onReveal={onReveal}
          key={`${keyPrefix}:${r.agent.id}`}
          x={x}
          y={y}
          label={robotLabel(r)}
          selected={selected === key}
          box={skin.boxes.robot}
          onActivate={() => onSelect({ kind: 'robot', agentId: r.agent.id })}
        >
          <skin.Robot placement={r} extra={extra} />
        </Hit>
      ),
    })
  }

  const plot = (p: PlotLayout, squadName: string) => {
    const key = `plot:${p.stream.id}`
    const isSelected = selected === key
    ground.push(<skin.PlotGround key={`${key}:ground`} i={p.i} j={p.j} selected={isSelected} />)
    if (p.tender) robot(p.tender, p.extraTenders)
    // Not planted yet: only its soil shows until its robot gets there.
    if (hidden.plants.has(p.stream.id)) return
    const [x, y] = iso(p.i + 0.5, p.j + 0.5)
    items.push({
      key,
      depth: depth(p.i + 0.5, p.j + 0.5),
      node: (
        <Hit
          onReveal={onReveal}
          key={key}
          x={x}
          y={y + 2}
          label={`${p.stream.title}, ${squadName}: ${plantStateLabel(p.state)}`}
          selected={isSelected}
          box={skin.boxes.plant}
          onActivate={() => onSelect({ kind: 'plot', streamId: p.stream.id })}
        >
          {hidden.popping.has(p.stream.id) ? (
            <g className="g-pop">
              <skin.Plant plot={p} />
            </g>
          ) : (
            <skin.Plant plot={p} />
          )}
        </Hit>
      ),
    })
    if (p.badge) {
      badges.push(
        <g key={`${key}:badge`} transform={`translate(${x} ${y + 2 + skin.badgeLift(p)})`} aria-hidden="true">
          <skin.Badge kind={p.badge} />
        </g>
      )
    }
  }

  for (const yard of layout.yards) {
    const { i0, j0, w, h, squad } = yard
    // The back fence and the yard's grass tint sit under everything inside the yard, soil included.
    yardGround.push(<skin.YardBack key={`yb:${squad.id}`} i0={i0} j0={j0} w={w} h={h} />)
    for (const piece of skin.yardFront({ i0, j0, w, h }))
      items.push({
        key: `yard:${squad.id}:${piece.key}`,
        depth: piece.depth,
        node: <g key={`yard:${squad.id}:${piece.key}`}>{piece.node}</g>,
      })
    const [sx, sy] = iso(yard.sign.i, yard.sign.j)
    items.push({
      key: `yard:${squad.id}:sign`,
      depth: depth(yard.sign.i, yard.sign.j),
      node: (
        <Hit
          onReveal={onReveal}
          key={`sign:${squad.id}`}
          x={sx}
          y={sy}
          label={`${squad.name} plot${yard.needsYou ? `, ${yard.needsYou} need you` : ''}`}
          selected={selected === `yard:${squad.id}`}
          box={skin.boxes.sign}
          onActivate={() => onSelect({ kind: 'yard', squadId: squad.id })}
        >
          <skin.Sign name={squad.name} flag={yard.needsYou > 0} />
        </Hit>
      ),
    })
    for (const p of yard.plots) plot(p, squad.name)
    if (yard.farmer) robot(yard.farmer)
    // The charging hut: one sprite whatever the count; its card lists who's resting.
    const resting = yard.dock.ids?.length ?? 0
    const [hx, hy] = iso(yard.dock.i, yard.dock.j)
    items.push({
      key: `hut:${squad.id}`,
      depth: depth(yard.dock.i, yard.dock.j),
      node: (
        <Hit
          onReveal={onReveal}
          key={`hut:${squad.id}`}
          x={hx}
          y={hy}
          label={`Charging hut, ${resting ? `${resting} robot${resting === 1 ? '' : 's'} resting` : 'empty'}`}
          selected={selected === `hut:${squad.id}`}
          box={skin.boxes.hut}
          onActivate={() => onSelect({ kind: 'hut', squadId: squad.id })}
        >
          <skin.Hut count={resting} peek={yard.dock.robots[0]} />
        </Hit>
      ),
    })
    // The consulting stand: one sprite whatever the count; its card lists the squad's consultant chats.
    const chats = yard.stand.ids?.length ?? 0
    const [sx2, sy2] = iso(yard.stand.i, yard.stand.j)
    items.push({
      key: `stand:${squad.id}`,
      depth: depth(yard.stand.i, yard.stand.j),
      node: (
        <Hit
          onReveal={onReveal}
          key={`stand:${squad.id}`}
          x={sx2}
          y={sy2}
          label={`Consulting stand, ${chats ? `${chats} consultant chat${chats === 1 ? '' : 's'}` : 'no consultant chats yet'}`}
          selected={selected === `stand:${squad.id}`}
          box={skin.boxes.stand}
          onActivate={() => onSelect({ kind: 'stand', squadId: squad.id })}
        >
          <skin.Stand count={chats} host={yard.stand.robots.find((host) => !hidden.robots.has(host.agent.id))} />
        </Hit>
      ),
    })
  }

  const place = (key: string, i: number, j: number, label: string, s: Selection, node: ReactNode, box: HitBox) => {
    const [x, y] = iso(i, j)
    items.push({
      key,
      depth: depth(i, j),
      node: (
        <Hit
          onReveal={onReveal}
          key={key}
          x={x}
          y={y}
          label={label}
          selected={selected === selectionKey(s)}
          box={box}
          onActivate={() => onSelect(s)}
        >
          {node}
        </Hit>
      ),
    })
  }
  const { farmhouse, seedShed, mailbox, crates, compost } = layout
  place(
    'farmhouse',
    farmhouse.i,
    farmhouse.j,
    'Farmhouse: open the Ficus web app',
    { kind: 'farmhouse' },
    <skin.Farmhouse />,
    skin.boxes.farmhouse
  )
  place(
    'seedShed',
    seedShed.i,
    seedShed.j,
    'Seed shed: start something new with a consultant',
    { kind: 'seedShed' },
    <skin.SeedShed />,
    skin.boxes.seedShed
  )
  place(
    'mailbox',
    mailbox.i,
    mailbox.j,
    mailboxCount ? `Mailbox, ${mailboxCount} need you` : 'Mailbox, nothing needs you',
    { kind: 'mailbox' },
    <skin.Mailbox count={mailboxCount} />,
    skin.boxes.mailbox
  )
  if (crates.count)
    place(
      'crates',
      crates.i,
      crates.j,
      `Harvested: ${crates.count}`,
      { kind: 'crates' },
      <skin.Crates count={crates.count} />,
      skin.boxes.crates
    )
  if (compost.count)
    place(
      'compost',
      compost.i,
      compost.j,
      `Compost: ${compost.count} canceled`,
      { kind: 'compost' },
      <skin.Compost count={compost.count} />,
      skin.boxes.compost
    )

  for (const d of layout.decor) {
    const [x, y] = iso(d.i, d.j)
    items.push({
      key: `decor:${d.kind}:${d.i}:${d.j}`,
      depth: depth(d.i, d.j),
      node: (
        <g key={`decor:${d.kind}:${d.i}:${d.j}`} transform={`translate(${x} ${y})`} aria-hidden="true">
          <skin.Decor decor={d} />
        </g>
      ),
    })
  }

  items.sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1))
  return { ground: [...yardGround, ...ground], items, badges }
}

/** The farm's world, drawn once per layout/selection change; the camera only moves the outer transform. */
export const SceneWorld = memo(function SceneWorld({
  layout,
  selection,
  mailboxCount,
  onSelect,
  onReveal,
  hidden = NOTHING_HIDDEN,
}: SceneProps) {
  const { skin } = useSkin()
  const selected = selectionKey(selection)
  const { ground, items, badges } = useMemo(
    () => buildDrawables(skin, layout, selected, mailboxCount, onSelect, onReveal, hidden),
    [skin, layout, selected, mailboxCount, onSelect, onReveal, hidden]
  )
  const { bounds } = layout
  return (
    <>
      <skin.Defs />
      <skin.Ground bounds={bounds} />
      <g aria-hidden="true">{ground}</g>
      {items.map((d) => d.node)}
      <g className="g-badges">{badges}</g>
    </>
  )
})

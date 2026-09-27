import { memo, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { depth, iso } from './iso'
import type { CrowdSpot, FarmLayout, PlotLayout, RobotPlacement } from './types'
import { plantStateLabel, roleLabel, selectionKey, type Selection } from './selection'
import { agentLabel } from './agentLabels'
import {
  Badge,
  badgeLift,
  Bench,
  Bush,
  ChargingDock,
  Compost,
  Crates,
  Crop,
  Farmhouse,
  Flowers,
  Grass,
  HayBale,
  Mailbox,
  PlotSelectionGround,
  PlotSelectionTint,
  PlowedSoil,
  Robot,
  SceneDefs,
  SeedShed,
  Tree,
  YardBack,
  YardFront,
  YardSign,
} from './sprites'

interface Drawable {
  key: string
  depth: number
  node: ReactNode
}

interface SceneProps {
  layout: FarmLayout
  selection: Selection | null
  mailboxCount: number
  onSelect: (selection: Selection) => void
}

/** Wraps a sprite at a world position as a keyboard- and screen-reader-reachable button. */
function Hit({
  x,
  y,
  label,
  selected,
  onActivate,
  box,
  children,
}: {
  x: number
  y: number
  label: string
  selected?: boolean
  onActivate: () => void
  /** Generous tap area around the anchor: [left, top, width, height]. */
  box: readonly [number, number, number, number]
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
      >
        <rect className="g-hit-area" x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx={14} />
        {children}
        <rect className="g-focus-ring" x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx={14} />
      </g>
    </g>
  )
}

const ROBOT_BOX = [-22, -74, 44, 80] as const
const PLANT_BOX = [-34, -78, 68, 92] as const

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
  return `${name}, ${roleLabel(r.role).toLowerCase()}, ${face}`
}

function buildDrawables(
  layout: FarmLayout,
  selected: string | null,
  mailboxCount: number,
  onSelect: (s: Selection) => void
): { ground: ReactNode[]; items: Drawable[]; badges: ReactNode[] } {
  const yardGround: ReactNode[] = []
  const ground: ReactNode[] = []
  const items: Drawable[] = []
  const badges: ReactNode[] = []

  const robot = (r: RobotPlacement, extra = 0, keyPrefix = 'robot') => {
    const [x, y] = iso(r.i, r.j)
    const key = `robot:${r.agent.id}`
    items.push({
      key: `${keyPrefix}:${r.agent.id}`,
      depth: depth(r.i, r.j),
      node: (
        <Hit
          key={`${keyPrefix}:${r.agent.id}`}
          x={x}
          y={y}
          label={robotLabel(r)}
          selected={selected === key}
          box={ROBOT_BOX}
          onActivate={() => onSelect({ kind: 'robot', agentId: r.agent.id })}
        >
          <Robot look={r.look} face={r.face} prop={r.prop} helpers={r.helpers} extra={extra} />
        </Hit>
      ),
    })
  }

  const crowd = (spot: CrowdSpot, keyPrefix: string) => {
    spot.robots.forEach((r, n) => robot(r, n === spot.robots.length - 1 ? spot.overflow : 0, keyPrefix))
  }

  const plot = (p: PlotLayout, squadName: string) => {
    const key = `plot:${p.stream.id}`
    const isSelected = selected === key
    if (isSelected) ground.push(<PlotSelectionGround key={`${key}:sel`} i={p.i} j={p.j} />)
    ground.push(<PlowedSoil key={`${key}:soil`} i={p.i} j={p.j} />)
    if (isSelected) ground.push(<PlotSelectionTint key={`${key}:tint`} i={p.i} j={p.j} />)
    const [x, y] = iso(p.i + 0.5, p.j + 0.5)
    items.push({
      key,
      depth: depth(p.i + 0.5, p.j + 0.5),
      node: (
        <Hit
          key={key}
          x={x}
          y={y + 2}
          label={`${p.stream.title}, ${squadName}: ${plantStateLabel(p.state)}`}
          selected={isSelected}
          box={PLANT_BOX}
          onActivate={() => onSelect({ kind: 'plot', streamId: p.stream.id })}
        >
          <Crop kind={p.crop} state={p.state} />
        </Hit>
      ),
    })
    if (p.badge) {
      badges.push(
        <g key={`${key}:badge`} transform={`translate(${x} ${y + 2 + badgeLift(p.crop)})`} aria-hidden="true">
          <Badge kind={p.badge} />
        </g>
      )
    }
    if (p.tender) robot(p.tender, p.extraTenders)
  }

  for (const yard of layout.yards) {
    const { i0, j0, w, h, squad } = yard
    // The back fence and the yard's grass tint sit under everything inside the yard, soil included.
    yardGround.push(<YardBack key={`yb:${squad.id}`} i0={i0} j0={j0} w={w} h={h} />)
    items.push({
      key: `yard:${squad.id}:front`,
      depth: i0 + w + j0 + h + 0.5,
      node: <YardFront key={`yf:${squad.id}`} i0={i0} j0={j0} w={w} h={h} />,
    })
    const [sx, sy] = iso(yard.sign.i, yard.sign.j)
    items.push({
      key: `yard:${squad.id}:sign`,
      depth: i0 + w + j0 + h + 1,
      node: (
        <Hit
          key={`sign:${squad.id}`}
          x={sx}
          y={sy}
          label={`${squad.name} plot${yard.needsYou ? `, ${yard.needsYou} need you` : ''}`}
          selected={selected === `yard:${squad.id}`}
          box={[-60, -72, 120, 78]}
          onActivate={() => onSelect({ kind: 'yard', squadId: squad.id })}
        >
          <YardSign name={squad.name} flag={yard.needsYou > 0} />
        </Hit>
      ),
    })
    for (const p of yard.plots) plot(p, squad.name)
    if (yard.farmer) robot(yard.farmer)
    const [dx, dy] = iso(yard.dock.i, yard.dock.j)
    items.push({
      key: `dock:${squad.id}`,
      depth: depth(yard.dock.i, yard.dock.j) - 0.01,
      node: (
        <g key={`dock:${squad.id}`} transform={`translate(${dx} ${dy})`} aria-hidden="true">
          <ChargingDock count={yard.dock.robots.length + yard.dock.overflow} />
        </g>
      ),
    })
    crowd(yard.dock, 'dock')
    if (yard.bench.robots.length) {
      const [bx, by] = iso(yard.bench.i, yard.bench.j)
      items.push({
        key: `bench:${squad.id}`,
        depth: depth(yard.bench.i, yard.bench.j) - 0.01,
        node: (
          <g key={`bench:${squad.id}`} transform={`translate(${bx} ${by})`} aria-hidden="true">
            <Bench />
          </g>
        ),
      })
      crowd(yard.bench, 'bench')
    }
  }

  const place = (
    key: string,
    i: number,
    j: number,
    label: string,
    s: Selection,
    node: ReactNode,
    box: readonly [number, number, number, number]
  ) => {
    const [x, y] = iso(i, j)
    items.push({
      key,
      depth: depth(i, j),
      node: (
        <Hit
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
    <Farmhouse />,
    [-120, -190, 240, 220]
  )
  place(
    'seedShed',
    seedShed.i,
    seedShed.j,
    'Seed shed: start something new with a consultant',
    { kind: 'seedShed' },
    <SeedShed />,
    [-80, -120, 160, 150]
  )
  place(
    'mailbox',
    mailbox.i,
    mailbox.j,
    mailboxCount ? `Mailbox, ${mailboxCount} need you` : 'Mailbox, nothing needs you',
    { kind: 'mailbox' },
    <Mailbox count={mailboxCount} />,
    [-34, -96, 68, 104]
  )
  if (crates.count)
    place(
      'crates',
      crates.i,
      crates.j,
      `Harvested: ${crates.count}`,
      { kind: 'crates' },
      <Crates count={crates.count} />,
      [-40, -40, 80, 50]
    )
  if (compost.count)
    place(
      'compost',
      compost.i,
      compost.j,
      `Compost: ${compost.count} canceled`,
      { kind: 'compost' },
      <Compost count={compost.count} />,
      [-30, -30, 60, 40]
    )
  crowd(layout.porch, 'porch')

  for (const d of layout.decor) {
    const [x, y] = iso(d.i, d.j)
    const node =
      d.kind === 'tree' || d.kind === 'fruitTree' ? (
        <Tree fruit={d.kind === 'fruitTree'} seed={d.seed} />
      ) : d.kind === 'bush' ? (
        <Bush seed={d.seed} />
      ) : d.kind === 'flowers' ? (
        <Flowers seed={d.seed} />
      ) : (
        <HayBale />
      )
    items.push({
      key: `decor:${d.kind}:${d.i}:${d.j}`,
      depth: depth(d.i, d.j),
      node: (
        <g key={`decor:${d.kind}:${d.i}:${d.j}`} transform={`translate(${x} ${y})`} aria-hidden="true">
          {node}
        </g>
      ),
    })
  }

  items.sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1))
  return { ground: [...yardGround, ...ground], items, badges }
}

/** The farm's world, drawn once per layout/selection change; the camera only moves the outer transform. */
export const SceneWorld = memo(function SceneWorld({ layout, selection, mailboxCount, onSelect }: SceneProps) {
  const selected = selectionKey(selection)
  const { ground, items, badges } = useMemo(
    () => buildDrawables(layout, selected, mailboxCount, onSelect),
    [layout, selected, mailboxCount, onSelect]
  )
  const { bounds } = layout
  return (
    <>
      <SceneDefs />
      <Grass minI={bounds.minI} maxI={bounds.maxI} minJ={bounds.minJ} maxJ={bounds.maxJ} />
      <g aria-hidden="true">{ground}</g>
      {items.map((d) => d.node)}
      <g className="g-badges">{badges}</g>
    </>
  )
})

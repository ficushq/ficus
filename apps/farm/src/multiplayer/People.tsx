import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { FarmLook } from '@ficus/shared'
import { useSkin } from '../skins'
import { useStableRef } from '../hooks/useStableRef'
import { iso } from '../farm/iso'
import { along, pathLength, type TilePoint } from '../farm/plantingRoute'
import { usePrefersReducedMotion } from '../farm/Planting'
import { walkBetween } from '../farm/robotMoves'
import type { FarmLayout } from '../farm/types'
import type { FarmhouseDoor } from '../skins/types'
import { doorwayOut, FADE_TILES, porchLift } from './doorway'
import type { Spot } from './spots'
import type { ChatBubble, Emote } from './MultiplayerProvider'

/** Walking speed, tiles per second; long walks go faster, so none takes more than MAX_WALK_S. */
const SPEED = 2.2
const MAX_WALK_S = 6
const BUBBLE_CHARS = 60

export interface PlacedPerson {
  userId: string
  name: string
  spot: Spot
  isMe: boolean
  look: FarmLook
  /** Just came onto the farm: walks out of the farmhouse to their spot (read when they first appear). */
  coming: boolean
  /** Just left: walks back into the farmhouse, then is gone. */
  leaving: boolean
}

/** Where people come and go: the farmhouse, its door and porch as this style draws them. */
interface Doorway {
  house: TilePoint
  door: FarmhouseDoor
}

/** A short name for the tag over someone's head: their first name, or the start of their email. */
export function tagName(name: string): string {
  const first = (name.includes('@') ? name.split('@')[0]! : name).split(/\s+/)[0] ?? name
  return first.length > 12 ? `${first.slice(0, 11)}…` : first
}

const facingAlong = (a: TilePoint, b: TilePoint): 'left' | 'right' =>
  b[0] - b[1] - (a[0] - a[1]) < 0 ? 'left' : 'right'

/**
 * One person: walks to their spot whenever it changes (out of a yard and in
 * through the next one's gate). Someone arriving walks out of the farmhouse
 * door and down its steps; someone leaving walks back up them and in. With
 * reduced motion they simply appear there, or are gone.
 */
const Walker = memo(function Walker({
  person,
  layout,
  doorway,
  bubble,
  emote,
  selected,
  onSelect,
}: {
  person: PlacedPerson
  layout: FarmLayout
  doorway: Doorway
  bubble: ChatBubble | undefined
  emote: Emote | undefined
  selected: boolean
  onSelect: (userId: string) => void
}) {
  const { skin } = useSkin()
  const reduce = usePrefersReducedMotion()
  const ref = useRef<SVGGElement>(null)
  const where = useRef<TilePoint | null>(null)
  const [walking, setWalking] = useState(false)
  const [facing, setFacing] = useState(person.spot.facing)
  // Stepping through the farmhouse door: faded while in it.
  const [inDoor, setInDoor] = useState(person.coming && !reduce)
  const [gone, setGoneState] = useState(false)
  const goneRef = useRef(false)
  const setGone = (value: boolean) => {
    goneRef.current = value
    setGoneState(value)
  }
  const spotRef = useStableRef(person.spot)
  const layoutRef = useStableRef(layout)
  const doorwayRef = useStableRef(doorway)
  // Only whether they came through the door when they first appeared matters.
  const coming = useRef(person.coming && !reduce)
  const { leaving } = person
  // The target's coordinates, not the spot object, decide whether to walk.
  const targetKey = `${person.spot.at[0]}:${person.spot.at[1]}`

  useEffect(() => {
    const spot = spotRef.current
    const { house, door } = doorwayRef.current
    const out = doorwayOut(house, door)
    const place = ([i, j]: TilePoint) => {
      where.current = [i, j]
      const [x, y] = iso(i, j)
      const up = porchLift(house, door, [i, j])
      ref.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${(y - up).toFixed(1)})`)
    }
    // Back before they'd quite gone: out of the door again.
    if (!leaving && goneRef.current) {
      setGone(false)
      where.current = null
      coming.current = !reduce
    }
    if (leaving && (reduce || !where.current)) {
      setGone(true)
      return
    }
    let path: TilePoint[]
    if (leaving) {
      // Home: to the foot of the steps, up them and in through the door.
      path = [...walkBetween(layoutRef.current, where.current!, out[1]!), ...[...out].reverse().slice(1)]
    } else {
      const target = spot.at
      const from = where.current
      if (!from && coming.current) {
        // Out of the door, down the steps, then on to their spot.
        path = [...out, ...walkBetween(layoutRef.current, out[1]!, target).slice(1)]
      } else if (!from || (from[0] === target[0] && from[1] === target[1])) {
        place(target)
        setFacing(spot.facing)
        setInDoor(false)
        return
      } else {
        path = walkBetween(layoutRef.current, from, target)
      }
    }
    const length = pathLength(path)
    const speed = Math.max(SPEED, length / MAX_WALK_S)
    const start = performance.now()
    let segment = -1
    let frame = 0
    setWalking(true)
    const tick = (now: number) => {
      // Under way: they've come through the door (cleared here, not before, so a re-run effect still walks it).
      coming.current = false
      const walked = ((now - start) / 1000) * speed
      const step = along(path, walked)
      place(step.at)
      if (step.segment !== segment) {
        segment = step.segment
        setFacing(facingAlong(path[segment]!, path[segment + 1] ?? path[segment]!))
      }
      // Fading in as they step out of the door, or out as they step in.
      const doorway = leaving ? walked > length - FADE_TILES : walked < FADE_TILES && path[0] === out[0]
      setInDoor(doorway)
      if (walked >= length) {
        setWalking(false)
        if (leaving) setGone(true)
        else setFacing(spot.facing)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [targetKey, leaving, reduce, spotRef, layoutRef, doorwayRef])

  if (gone) return null

  const label = person.isMe ? 'You' : tagName(person.name)
  const tagWidth = label.length * 6 + 16
  const said = bubble
    ? bubble.text.length > BUBBLE_CHARS
      ? `${bubble.text.slice(0, BUBBLE_CHARS - 1)}…`
      : bubble.text
    : null
  const bubbleWidth = said ? Math.min(200, said.length * 6 + 20) : 0
  const [bl, bt, bw, bh] = skin.boxes.person
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(person.userId)
    }
  }
  return (
    <g
      ref={ref}
      className={clsx('g-person', inDoor && 'g-person-in-door', leaving && 'g-person-leaving')}
      aria-hidden={leaving || undefined}
    >
      <g
        className="g-hit"
        role="button"
        tabIndex={leaving ? -1 : 0}
        aria-label={person.isMe ? 'You' : `${person.name}, on the farm`}
        aria-pressed={selected}
        onClick={() => onSelect(person.userId)}
        onKeyDown={onKeyDown}
      >
        <rect className="g-hit-area" x={bl} y={bt} width={bw} height={bh} rx={14} />
        <g className={walking ? 'g-walking' : undefined}>
          <g transform={facing === 'left' ? 'scale(-1 1)' : undefined}>
            <skin.Person look={person.look} />
          </g>
        </g>
        <g className={person.isMe ? 'g-person-tag g-person-me' : 'g-person-tag'} transform="translate(0 14)">
          <rect x={-tagWidth / 2} y={-8} width={tagWidth} height={15} rx={7.5} />
          <text y={3.5} textAnchor="middle">
            {label}
          </text>
        </g>
        {said && (
          <g transform={`translate(0 ${bt - 6})`}>
            <g className="g-person-bubble">
              <path d="M-4 -1 L0 6 L4 -1 Z" />
              <rect x={-bubbleWidth / 2} y={-26} width={bubbleWidth} height={25} rx={12} />
              <text y={-9.5} textAnchor="middle">
                {said}
              </text>
            </g>
          </g>
        )}
        {emote && (
          // Beside their speech bubble if they have one, else right over their head.
          <g transform={`translate(${said ? bubbleWidth / 2 + 14 : 0} ${bt - (said ? 14 : 2)})`} aria-hidden="true">
            <text key={emote.at} className="g-person-emote" textAnchor="middle">
              {emote.emoji}
            </text>
          </g>
        )}
        <rect className="g-focus-ring" x={bl} y={bt} width={bw} height={bh} rx={14} />
      </g>
    </g>
  )
})

/** Everyone on the farm, drawn over the scene. */
export function People({
  layout,
  people,
  bubbles,
  emotes,
  selectedUserId,
  onSelect,
}: {
  layout: FarmLayout
  people: PlacedPerson[]
  bubbles: ReadonlyMap<string, ChatBubble>
  emotes: ReadonlyMap<string, Emote>
  selectedUserId: string | null
  onSelect: (userId: string) => void
}) {
  const { skin } = useSkin()
  const { farmhouse } = layout
  const doorway = useMemo<Doorway>(
    () => ({ house: [farmhouse.i, farmhouse.j], door: skin.farmhouseDoor }),
    [farmhouse.i, farmhouse.j, skin.farmhouseDoor]
  )
  // Nearer people draw over farther ones.
  const ordered = [...people].sort((a, b) => a.spot.at[0] + a.spot.at[1] - (b.spot.at[0] + b.spot.at[1]))
  return (
    <g className="g-people">
      {ordered.map((person) => (
        <Walker
          key={person.userId}
          person={person}
          layout={layout}
          doorway={doorway}
          bubble={bubbles.get(person.userId)}
          emote={emotes.get(person.userId)}
          selected={selectedUserId === person.userId}
          onSelect={onSelect}
        />
      ))}
    </g>
  )
}

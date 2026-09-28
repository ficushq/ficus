import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useSkin } from '../skins'
import { useStableRef } from '../hooks/useStableRef'
import { iso } from '../farm/iso'
import { along, pathLength, routeTo, type TilePoint } from '../farm/plantingRoute'
import type { Spot } from './spots'
import type { ChatBubble } from './MultiplayerProvider'
import { personLookFor } from './personLook'

/** Walking speed, tiles per second. */
const SPEED = 2.2
const BUBBLE_CHARS = 60

export interface PlacedPerson {
  userId: string
  name: string
  spot: Spot
  isMe: boolean
}

function inside(point: TilePoint, spot: Spot): boolean {
  const yard = spot.yard
  if (!yard) return false
  return point[0] > yard.i0 && point[0] < yard.i0 + yard.w && point[1] > yard.j0 && point[1] < yard.j0 + yard.h
}

/** A short name for the tag over someone's head: their first name, or the start of their email. */
export function tagName(name: string): string {
  const first = (name.includes('@') ? name.split('@')[0]! : name).split(/\s+/)[0] ?? name
  return first.length > 12 ? `${first.slice(0, 11)}…` : first
}

const facingAlong = (a: TilePoint, b: TilePoint): 'left' | 'right' =>
  b[0] - b[1] - (a[0] - a[1]) < 0 ? 'left' : 'right'

/** One person: walks to their spot whenever it changes (in through the gate when it's inside a yard). */
const Walker = memo(function Walker({
  person,
  bubble,
  selected,
  onSelect,
}: {
  person: PlacedPerson
  bubble: ChatBubble | undefined
  selected: boolean
  onSelect: (userId: string) => void
}) {
  const { skin } = useSkin()
  const ref = useRef<SVGGElement>(null)
  const where = useRef<TilePoint | null>(null)
  const [walking, setWalking] = useState(false)
  const [facing, setFacing] = useState(person.spot.facing)
  const spotRef = useStableRef(person.spot)
  // The target's coordinates, not the spot object, decide whether to walk.
  const targetKey = `${person.spot.at[0]}:${person.spot.at[1]}`

  useEffect(() => {
    const spot = spotRef.current
    const target = spot.at
    const place = ([i, j]: TilePoint) => {
      where.current = [i, j]
      const [x, y] = iso(i, j)
      ref.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    }
    const from = where.current
    if (!from || (from[0] === target[0] && from[1] === target[1])) {
      place(target)
      setFacing(spot.facing)
      return
    }
    const path = inside(target, spot) && !inside(from, spot) ? routeTo(spot.yard!, from, target) : [from, target]
    const length = pathLength(path)
    const start = performance.now()
    let segment = -1
    let frame = 0
    setWalking(true)
    const tick = (now: number) => {
      const walked = ((now - start) / 1000) * SPEED
      const step = along(path, walked)
      place(step.at)
      if (step.segment !== segment) {
        segment = step.segment
        setFacing(facingAlong(path[segment]!, path[segment + 1] ?? path[segment]!))
      }
      if (walked >= length) {
        setWalking(false)
        setFacing(spot.facing)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [targetKey, spotRef])

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
    <g ref={ref} className="g-person">
      <g
        className="g-hit"
        role="button"
        tabIndex={0}
        aria-label={person.isMe ? 'You' : `${person.name}, on the farm`}
        aria-pressed={selected}
        onClick={() => onSelect(person.userId)}
        onKeyDown={onKeyDown}
      >
        <rect className="g-hit-area" x={bl} y={bt} width={bw} height={bh} rx={14} />
        <g className={walking ? 'g-walking' : undefined}>
          <g transform={facing === 'left' ? 'scale(-1 1)' : undefined}>
            <skin.Person look={personLookFor(person.userId)} />
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
        <rect className="g-focus-ring" x={bl} y={bt} width={bw} height={bh} rx={14} />
      </g>
    </g>
  )
})

/** Everyone on the farm, drawn over the scene. */
export function People({
  people,
  bubbles,
  selectedUserId,
  onSelect,
}: {
  people: PlacedPerson[]
  bubbles: ReadonlyMap<string, ChatBubble>
  selectedUserId: string | null
  onSelect: (userId: string) => void
}) {
  // Nearer people draw over farther ones.
  const ordered = [...people].sort((a, b) => a.spot.at[0] + a.spot.at[1] - (b.spot.at[0] + b.spot.at[1]))
  return (
    <g className="g-people">
      {ordered.map((person) => (
        <Walker
          key={person.userId}
          person={person}
          bubble={bubbles.get(person.userId)}
          selected={selectedUserId === person.userId}
          onSelect={onSelect}
        />
      ))}
    </g>
  )
}

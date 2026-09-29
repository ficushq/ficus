import { useEffect, useRef, useState } from 'react'
import { useSkin, type FarmSkin } from '../skins'
import { useStableRef } from '../hooks/useStableRef'
import { iso } from './iso'
import { onLetter, type Letter } from './letters'
import { usePrefersReducedMotion } from './Planting'
import type { TilePoint } from './plantingRoute'
import { robotSpots } from './robotMoves'
import type { FarmLayout } from './types'

/** How long a letter lands for (its pop), ms. */
const LAND_MS = 450

interface Flight {
  id: number
  from: readonly [number, number]
  to: readonly [number, number]
}

/** Where a robot is on the farm (standing, in its hut, at its stand), or null if it isn't here. */
function robotAt(layout: FarmLayout, agentId: string): { at: TilePoint; inside: boolean } | null {
  const spot = robotSpots(layout).get(agentId)
  if (spot) return { at: spot.at, inside: false }
  for (const yard of layout.yards) {
    if (yard.dock.ids?.includes(agentId)) return { at: [yard.dock.i, yard.dock.j], inside: true }
    if (yard.stand.ids?.includes(agentId)) return { at: [yard.stand.i, yard.stand.j], inside: true }
  }
  return null
}

/** A world point just above something's head (a robot, a person, the mailbox, a building's roof). */
function above([i, j]: TilePoint, lift: number): [number, number] {
  const [x, y] = iso(i, j)
  return [x, y + lift]
}

function endpoints(
  letter: Letter,
  layout: FarmLayout,
  skin: FarmSkin,
  me: TilePoint | null
): Pick<Flight, 'from' | 'to'> | null {
  const target = robotAt(layout, letter.toAgentId)
  if (!target) return null
  const robotLift = skin.boxes.robot[1] * 0.75
  const to = above(target.at, target.inside ? skin.boxes.hut[1] * 0.6 : robotLift)
  const mailbox = above([layout.mailbox.i, layout.mailbox.j], skin.boxes.mailbox[1] * 0.8)
  switch (letter.from.kind) {
    case 'me':
      return { from: me ? above(me, skin.boxes.person[1] * 0.9) : mailbox, to }
    case 'mailbox':
      return { from: mailbox, to }
    case 'agent': {
      const sender = robotAt(layout, letter.from.agentId)
      if (!sender) return { from: mailbox, to }
      return { from: above(sender.at, sender.inside ? skin.boxes.hut[1] * 0.6 : robotLift), to }
    }
  }
}

/** One letter in the air: up in an arc from sender to robot, then a little pop as it lands. */
function LetterFlight({ flight, onDone }: { flight: Flight; onDone: (id: number) => void }) {
  const ref = useRef<SVGGElement>(null)
  const [landed, setLanded] = useState(false)
  const onDoneRef = useStableRef(onDone)
  useEffect(() => {
    const [x0, y0] = flight.from
    const [x1, y1] = flight.to
    const distance = Math.hypot(x1 - x0, y1 - y0)
    const duration = Math.min(1600, Math.max(700, distance * 2))
    const arc = Math.min(140, 30 + distance * 0.3)
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const x = x0 + (x1 - x0) * ease
      const y = y0 + (y1 - y0) * ease - arc * 4 * ease * (1 - ease)
      // It tips toward where it's heading.
      const tilt = (x1 >= x0 ? 1 : -1) * 14 * (1 - 2 * ease)
      ref.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${tilt.toFixed(1)})`)
      if (t < 1) frame = requestAnimationFrame(tick)
      else {
        setLanded(true)
        window.setTimeout(() => onDoneRef.current(flight.id), LAND_MS)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [flight, onDoneRef])
  return (
    <g ref={ref} transform={`translate(${flight.from[0]} ${flight.from[1]})`}>
      <g className={landed ? 'g-letter g-letter-landed' : 'g-letter'}>
        <rect x={-13} y={-9} width={26} height={18} rx={2.5} />
        <path d="M-13 -8.5 L0 2 L13 -8.5" fill="none" />
        <circle cy={2} r={3} className="g-letter-seal" />
      </g>
    </g>
  )
}

/**
 * Letters flying across the farm to robots: your chat messages (from you, or
 * the mailbox when you're not on the farm), answers to their questions (from
 * the mailbox), and mail between robots. Drawn over the scene, never clickable.
 */
export function FlyingLetters({ layout, me }: { layout: FarmLayout; me: TilePoint | null }) {
  const { skin } = useSkin()
  const reduce = usePrefersReducedMotion()
  const [flights, setFlights] = useState<Flight[]>([])
  const next = useRef(0)
  const where = useStableRef({ layout, skin, me })
  useEffect(() => {
    if (reduce) return
    return onLetter((letter) => {
      const { layout, skin, me } = where.current
      const ends = endpoints(letter, layout, skin, me)
      // Nothing to fly when it's all in one place (you're right by the robot, or robots mail themselves).
      if (!ends || Math.hypot(ends.to[0] - ends.from[0], ends.to[1] - ends.from[1]) < 12) return
      setFlights((list) => [...list, { id: ++next.current, ...ends }])
    })
  }, [reduce, where])
  const done = (id: number) => setFlights((list) => list.filter((f) => f.id !== id))
  return (
    <g className="g-letters" aria-hidden="true">
      {flights.map((flight) => (
        <LetterFlight key={flight.id} flight={flight} onDone={done} />
      ))}
    </g>
  )
}
